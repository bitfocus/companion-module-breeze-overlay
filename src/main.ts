// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Bitfocus Companion connection module for Breeze Overlay.
 *
 * Breeze accepts GET for every control verb so that header-less hardware can
 * drive it; this module uses POST and an `x-breeze-key` header instead, because
 * Companion can do both and a key in a query string ends up in Breeze's own
 * activity log and in any proxy log along the way.
 *
 * One connection points at one project. A show with two projects on one server
 * is two connections, which is also how the buttons want to be organised.
 *
 * State comes back two ways. Against Breeze 0.74 or later each watched channel
 * gets a socket on the control hub and the server pushes changes as they
 * happen (see `live.ts`); against anything older, or while a socket is down,
 * the channel is polled over HTTP exactly as module 1.0 did. The server version
 * is re-read on every reconnect, so an upgrade — or a fall back to an older
 * spare machine — is picked up without touching the connection.
 */

import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'

import { BreezeApi, BreezeError, type ChannelState, type SourceSummary, type TableReport } from './api.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { LiveChannel, hasWebSocket } from './live.js'
import { BuildPresets } from './presets.js'
import { mediaDown, mediaUp, sourceState } from './sources.js'
import { cycleState } from './tables.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { MIN_VERSION, atLeast, type Feature } from './versions.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

/** A resolved trigger target. */
interface Target {
	project: string
	channel: string
}

/** Every feedback reads the same cache, so every change re-checks them all. */
const ALL_FEEDBACKS = ['on_air', 'playback_state', 'source_connected', 'cycle_held', 'page_is'] as const

/** How often to prove the server is still there while every channel is live. */
const WATCHDOG_MS = 5000

/**
 * How often to read the project's data-source health. A feed's state changes
 * on the scale of its own poll interval — seconds to minutes — so there is
 * nothing to gain from asking every second like the channel poll does.
 */
const SOURCES_MS = 5000

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig
	secrets!: ModuleSecrets
	api!: BreezeApi

	/**
	 * Last known state per channel, keyed `project/channel`.
	 *
	 * Feedbacks are synchronous in spirit — they are called often and must not
	 * each fire an HTTP request — so they read this cache, and the sockets or
	 * the poll fill it.
	 */
	private states = new Map<string, ChannelState>()
	/**
	 * When each channel's table report last changed, and what it was.
	 *
	 * A report's `secondsLeft` is true as of the moment it was made, and the
	 * poll re-reads the same report every second. Stamping it when it *changes*
	 * rather than when it was fetched is what lets the countdown run down
	 * instead of snapping back to the reported value on every poll.
	 */
	private tableStamps = new Map<string, { signature: string; at: number }>()
	/**
	 * Which placed action or feedback is looking at which channel.
	 *
	 * Keyed `action:<id>` / `feedback:<id>` (Companion instance ids, namespaced
	 * so the two kinds cannot collide), valued `project/channel`. The
	 * set of channels worth watching is derived from this rather than kept as its
	 * own set, so removing a button — Companion calls `unsubscribe` — releases
	 * its channel, and a channel nobody points at any more stops being watched.
	 * The project is part of the key so a `project/channel` address to a second
	 * project is watched in that project, not the connection's own.
	 */
	private owners = new Map<string, string>()
	/** One hub socket per watched channel, when the server is new enough. */
	private sockets = new Map<string, LiveChannel>()

	private timer: NodeJS.Timeout | undefined
	private polling = false
	private watchdog: NodeJS.Timeout | undefined
	private refreshQueued: NodeJS.Timeout | undefined
	private ticker: NodeJS.Timeout | undefined
	private lastSecondsLeft = ''
	/** The connection's project's data sources, by id, as last read. */
	private sources = new Map<string, SourceSummary>()
	/** The project's mode and the modes its rules name, as last read; undefined until read. */
	private modeState: { mode: string; modes: string[] } | undefined
	private sourcesSignature = ''
	private sourcesTimer: NodeJS.Timeout | undefined
	/** The read in flight, so a second caller waits on it instead of skipping. */
	private sourcesInflight: Promise<void> | undefined
	/**
	 * Bumped when the connection is reconfigured. A read that started against
	 * the old server finds the number changed and throws its answer away.
	 */
	private sourcesGeneration = 0

	/** As `/healthz` last reported it; empty until the server has answered once. */
	serverVersion = ''
	/** Null until the first answer, so the first success is not taken for a recovery. */
	private reachable: boolean | null = null

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets ?? { apiKey: '' }
		this.applyConfig()

		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)

		this.setVariableValues({
			project: this.config.project ?? '',
			channel: '',
			playback_state: 'unknown',
			playback_step: '',
			playback_steps: '',
			sources_connected: '',
			panels_connected: '',
			server_version: '',
			state_source: '',
			sources_failing: '',
			sources_on_backup: '',
			mode: '',
			...EMPTY_TABLE_VARIABLES,
		})

		await this.connect()
	}

	async destroy(): Promise<void> {
		this.stopPolling()
		this.stopSourcePolling()
		this.stopSockets()
		this.stopTicker()
		if (this.refreshQueued) clearTimeout(this.refreshQueued)
		this.refreshQueued = undefined
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets ?? { apiKey: '' }
		// Sockets dial the old address; drop them before the API is replaced.
		this.stopSockets()
		this.applyConfig()
		// The cache belongs to the old server; keeping it would colour buttons
		// from a machine this connection no longer points at.
		this.states.clear()
		this.tableStamps.clear()
		this.sources.clear()
		this.modeState = undefined
		this.sourcesSignature = ''
		this.sourcesGeneration += 1
		this.sourcesInflight = undefined
		this.setVariableValues({ sources_failing: '', sources_on_backup: '', mode: '' })
		this.serverVersion = ''
		this.reachable = null
		// Blank-channel buttons resolved against the old project. Drop every
		// claim and have Companion re-report what is placed, so each one is
		// re-resolved against the new config.
		this.owners.clear()
		this.defaultChannel = ''
		await this.connect()
		this.subscribeActions()
		this.checkAllFeedbacks()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private applyConfig(): void {
		this.api = new BreezeApi({
			host: this.config.host ?? '127.0.0.1',
			port: this.config.port ?? 7331,
			apiKey: this.secrets.apiKey ?? '',
		})
	}

	/**
	 * Prove the server is reachable before claiming Ok.
	 *
	 * `/healthz` rather than a control call: it is a read, it needs no key, and
	 * it distinguishes "wrong address" from "right address, wrong key" — which
	 * are the two setup mistakes people actually make. It also carries the
	 * version, which decides whether the sockets are used and which actions the
	 * server will understand.
	 */
	private async connect(): Promise<void> {
		this.stopPolling()
		this.updateStatus(InstanceStatus.Connecting)

		try {
			const health = await this.api.health()
			this.applyVersion(health.version, false)
			await this.refreshPresets()
			this.reachable = true
			this.updateStatus(InstanceStatus.Ok)
		} catch (error) {
			this.reachable = false
			this.reportError('connect', error)
			// Still poll: the server may simply not be up yet, and a connection
			// that recovers on its own is the difference between a working show
			// and someone restarting Companion during a break.
		}

		this.syncSockets()
		this.startPolling()
		this.startSourcePolling()
	}

	/* ------------------------------------------------------------- sources */

	private startSourcePolling(): void {
		this.stopSourcePolling()
		this.sourcesTimer = setInterval(() => void this.pollSources(), SOURCES_MS)
		void this.pollSources()
	}

	private stopSourcePolling(): void {
		if (this.sourcesTimer) clearInterval(this.sourcesTimer)
		this.sourcesTimer = undefined
	}

	/** Read now — after an action, so the button does not lag a round. */
	pollSourcesNow(): void {
		void this.pollSources()
	}

	/**
	 * Read the project's source list, and re-check the source feedbacks only
	 * when something about the sources actually changed.
	 *
	 * Skipped against a server known to be older than 0.74 — its list has no
	 * backup fields, so the feedbacks could only ever say "live". A failure is
	 * left to the channel poll and the watchdog to report; this is status, not
	 * the connection.
	 */
	private async pollSources(): Promise<void> {
		if (!this.sourcesInflight) {
			const generation = this.sourcesGeneration
			this.sourcesInflight = this.readSources(generation).finally(() => {
				if (generation === this.sourcesGeneration) this.sourcesInflight = undefined
			})
		}
		await this.sourcesInflight
	}

	private async readSources(generation: number): Promise<void> {
		const project = this.config.project?.trim() ?? ''
		if (!project) return
		await this.readMode(project, generation)
		if (this.supports('sources') === false) return
		try {
			const list = await this.api.sources(project)
			if (generation !== this.sourcesGeneration) return
			const signature = JSON.stringify(
				list.map((s) => [s.def.id, s.def.fallback, sourceState(s), s.status.use, mediaUp(s), mediaDown(s)]),
			)
			this.sources = new Map(list.map((s) => [s.def.id, s]))
			if (signature === this.sourcesSignature) return
			this.sourcesSignature = signature
			let failing = 0
			let onBackup = 0
			for (const source of list) {
				const state = sourceState(source)
				if (state === 'backup') onBackup += 1
				else if (state === 'failing' || state === 'expired') failing += 1
			}
			let up = 0
			let down = 0
			for (const source of list) {
				up += mediaUp(source) ?? 0
				down += mediaDown(source) ?? 0
			}
			this.setVariableValues({
				sources_failing: String(failing),
				sources_on_backup: String(onBackup),
				media_up: String(up),
				media_down: String(down),
			})
			this.checkFeedbacks('source_state', 'media_state')
		} catch {
			// Reported by the channel poll and the watchdog, if it is the server.
		}
	}

	/** Read the project mode alongside the sources — the same cadence, the same generation rule. */
	private async readMode(project: string, generation: number): Promise<void> {
		if (this.supports('mode') === false) return
		try {
			const state = await this.api.mode(project)
			if (generation !== this.sourcesGeneration) return
			const changed = state.mode !== this.modeState?.mode
			this.modeState = state
			if (!changed) return
			this.setVariableValues({ mode: state.mode })
			this.checkFeedbacks('mode_is')
		} catch {
			// Reported by the channel poll and the watchdog, if it is the server.
		}
	}

	/**
	 * Take the mode the server just answered a set with — so a second press of
	 * a toggle reads the new mode, not the one the last poll saw.
	 */
	noteMode(mode: string): void {
		if (this.modeState?.mode === mode) return
		this.modeState = { mode, modes: this.modeState?.modes ?? [] }
		this.setVariableValues({ mode })
		this.checkFeedbacks('mode_is')
	}

	/** The project's mode as last read, or undefined before the first read. */
	currentMode(): string | undefined {
		return this.modeState?.mode
	}

	/** The modes the project's rules name — for presets. */
	knownModes(): string[] {
		return this.modeState?.modes ?? []
	}

	/** A source as last read, or undefined — by id, trimmed. */
	sourceFor(id: string | undefined): SourceSummary | undefined {
		return this.sources.get((id ?? '').trim())
	}

	/** The project's camera lists — sources with media checks — for presets. */
	mediaSources(): SourceSummary[] {
		return [...this.sources.values()].filter((s) => s.def.media !== undefined)
	}

	/** The project's sources that have a backup — for presets. */
	backedSources(): SourceSummary[] {
		return [...this.sources.values()].filter((s) => s.def.fallback !== undefined)
	}

	/* ------------------------------------------------------------ versions */

	/**
	 * Whether the server has a feature: true, false, or null when its version is
	 * not known yet — see `atLeast`.
	 */
	supports(feature: Feature): boolean | null {
		return atLeast(this.serverVersion, MIN_VERSION[feature])
	}

	/**
	 * Gate an action on a feature, logging why when the server is too old.
	 *
	 * An unknown version lets the request through: the server answers for
	 * itself, and a button that refuses to try because Companion started before
	 * the server did would be the wrong kind of careful.
	 */
	requireFeature(feature: Feature, what: string): boolean {
		if (this.supports(feature) !== false) return true
		this.log('warn', `${what} needs Breeze ${MIN_VERSION[feature]} or later — this server is ${this.serverVersion}`)
		return false
	}

	private applyVersion(version: string, rebuildPresets: boolean): void {
		if (version === this.serverVersion) return
		const before = this.serverVersion
		this.serverVersion = version
		this.setVariableValues({ server_version: version })
		if (before) this.log('info', `Breeze server is now ${version} (was ${before})`)
		this.syncSockets()
		// PREV is only offered to servers that have it.
		if (rebuildPresets) void this.refreshPresets()
	}

	/** Re-read the version after the server comes back — it may have been upgraded while away. */
	private async recheckVersion(): Promise<void> {
		try {
			const health = await this.api.health()
			this.applyVersion(health.version, true)
		} catch {
			// The poll or the watchdog reports the outage; nothing to add here.
		}
	}

	/**
	 * Rebuild the preset list from what the server currently holds.
	 *
	 * Done at connect rather than on every poll: presets are a catalogue the
	 * user drags from, not live state, and rewriting them every second would
	 * churn the UI for no gain. Reconnecting — or hitting Save on the
	 * connection — is the natural moment to pick up a newly added scene.
	 */
	private async refreshPresets(): Promise<void> {
		const project = this.config.project?.trim()
		if (!project) {
			// Nothing to scope to. Empty rather than every project on the server:
			// a preset that addresses a project this connection is not configured
			// for would put the wrong graphic to air.
			this.setPresetDefinitions([], {})
			return
		}

		try {
			const all = await this.api.allChannels()
			// Read before the presets, so a source with a backup gets its button.
			if (this.supports('sources') === true) await this.pollSources()
			const mine = all.find((p) => p.id === project)
			if (!mine) {
				this.log('warn', `Project "${project}" not found on the server — no presets generated`)
				this.setPresetDefinitions([], {})
				return
			}
			BuildPresets(this, mine.channels)
			this.log('debug', `Built presets for ${mine.channels.length} channels in ${mine.name}`)
		} catch (error) {
			// Presets are a convenience; failing to build them must not stop the
			// connection from working.
			this.log('warn', `Could not build presets: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/* ------------------------------------------------------------- sockets */

	private liveEnabled(): boolean {
		return hasWebSocket && this.supports('live') === true
	}

	/** Open a socket for every watched channel, close the rest. */
	private syncSockets(): void {
		const wanted = this.liveEnabled() ? new Set(this.owners.values()) : new Set<string>()

		for (const [key, socket] of this.sockets) {
			if (wanted.has(key)) continue
			socket.stop()
			this.sockets.delete(key)
		}

		for (const key of wanted) {
			if (this.sockets.has(key)) continue
			const socket = new LiveChannel(this.api.socketUrl, key, {
				state: (channel, state) => {
					if (!this.isWatched(channel)) return
					this.acceptState(channel, state)
					this.markReachable(true)
				},
				open: () => {
					this.markReachable(true)
					this.startWatchdog()
					this.publishSource()
				},
				// The poll takes the channel back from its next tick; nudge it so
				// there is no gap.
				close: () => {
					this.publishSource()
					this.pollNow()
				},
			})
			this.sockets.set(key, socket)
			socket.start()
		}

		if (this.sockets.size === 0) this.stopWatchdog()
		this.publishSource()
	}

	private stopSockets(): void {
		for (const socket of this.sockets.values()) socket.stop()
		this.sockets.clear()
		this.stopWatchdog()
	}

	private isLive(key: string): boolean {
		return this.sockets.get(key)?.live === true
	}

	/**
	 * A pushed channel is silent while nothing changes, so silence cannot tell
	 * a quiet graphic from a server that lost power without closing its sockets.
	 * While anything is live, ask `/healthz` every few seconds; if it does not
	 * answer, drop the sockets so the poll takes over and reports the outage.
	 * The answer's version is applied too — a restart onto a different build is
	 * a reconnect like any other.
	 */
	private startWatchdog(): void {
		if (this.watchdog) return
		this.watchdog = setInterval(() => void this.checkServer(), WATCHDOG_MS)
	}

	private stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = undefined
	}

	private async checkServer(): Promise<void> {
		if (![...this.sockets.values()].some((socket) => socket.live)) return
		try {
			const health = await this.api.health()
			this.applyVersion(health.version, true)
		} catch (error) {
			if (error instanceof BreezeError && error.status !== 0) return
			for (const socket of this.sockets.values()) socket.restart()
			this.markReachable(false)
		}
	}

	/** Which way the default channel's state is arriving: `live`, `poll`, or blank. */
	private publishSource(): void {
		const target = this.resolveChannel('')
		const key = target ? `${target.project}/${target.channel}` : ''
		this.setVariableValues({ state_source: key ? (this.isLive(key) ? 'live' : 'poll') : '' })
	}

	/* ------------------------------------------------------------- polling */

	private startPolling(): void {
		const interval = Math.max(250, this.config.pollInterval ?? 1000)
		this.timer = setInterval(() => void this.poll(), interval)
		void this.poll()
	}

	private stopPolling(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}

	/** Poll immediately — called after an action, so the button does not lag a tick. */
	pollNow(): void {
		void this.poll()
	}

	/**
	 * Refresh every watched channel that has no live socket.
	 *
	 * Guarded against overlap: a server that has gone away leaves each request
	 * to time out, and without this the intervals would stack up requests faster
	 * than they drain.
	 */
	private async poll(): Promise<void> {
		if (this.polling) return

		const keys = [...new Set(this.owners.values())].filter((key) => !this.isLive(key))
		if (keys.length === 0) return

		this.polling = true
		try {
			let reachable = [...this.sockets.values()].some((socket) => socket.live)
			for (const key of keys) {
				// Each key carries its own project, so a feedback addressing
				// `other/channel` is read from `other` — not from this
				// connection's configured project.
				const { project, channel } = splitKey(key)
				try {
					const state = await this.api.state(project, channel)
					// Released while the request was in flight — or taken over by
					// a socket — so do not overwrite it.
					if (this.isWatched(key) && !this.isLive(key)) this.acceptState(key, state, true)
					reachable = true
				} catch (error) {
					// A 404 is a wrong channel name, not a dead server — drop the
					// stale entry so a feedback stops claiming the graphic is up.
					this.states.delete(key)
					this.tableStamps.delete(key)
					if (error instanceof BreezeError && error.status !== 0) reachable = true
				}
			}

			this.markReachable(reachable)
			this.refresh()
		} finally {
			this.polling = false
		}
	}

	private markReachable(ok: boolean): void {
		const recovered = ok && this.reachable === false
		this.reachable = ok
		if (ok) this.updateStatus(InstanceStatus.Ok)
		else this.updateStatus(InstanceStatus.ConnectionFailure, `No response from ${this.api.base}`)
		// Came back: it may be a different build now. The sockets follow from
		// whatever version it reports.
		if (recovered) void this.recheckVersion()
	}

	/* --------------------------------------------------------------- state */

	/**
	 * Take a channel's new state, from either path.
	 *
	 * `immediate` for the poll, which already batches a whole round into one
	 * refresh. A socket can deliver several states in a burst — a page turn and
	 * a hold together — so those are coalesced into one variable and feedback
	 * pass instead of one each.
	 */
	private acceptState(key: string, state: ChannelState, immediate = false): void {
		this.states.set(key, state)

		const signature = JSON.stringify(state.playback?.tables ?? null)
		if (this.tableStamps.get(key)?.signature !== signature) {
			this.tableStamps.set(key, { signature, at: Date.now() })
		}

		if (!immediate) this.queueRefresh()
	}

	private queueRefresh(): void {
		if (this.refreshQueued) return
		this.refreshQueued = setTimeout(() => {
			this.refreshQueued = undefined
			this.refresh()
		}, 50)
	}

	private refresh(): void {
		this.publishDefaultVariables()
		this.checkFeedbacks(...ALL_FEEDBACKS)
	}

	/** Variables track the connection's default channel — see `variables.ts`. */
	private publishDefaultVariables(): void {
		const target = this.resolveChannel('')
		if (!target) {
			this.setVariableValues({
				channel: '',
				playback_state: 'unknown',
				playback_step: '',
				playback_steps: '',
				sources_connected: '',
				panels_connected: '',
				state_source: '',
				...EMPTY_TABLE_VARIABLES,
			})
			this.stopTicker()
			return
		}

		const key = `${target.project}/${target.channel}`
		const state = this.states.get(key)
		const table = state?.playback?.tables?.[0]
		this.setVariableValues({
			project: target.project,
			channel: target.channel,
			playback_state: state?.playback?.state ?? 'unknown',
			playback_step: state?.playback ? String(state.playback.step) : '',
			playback_steps: state?.playback ? String(state.playback.stepCount) : '',
			sources_connected: state ? String(state.renderers) : '',
			panels_connected: state ? String(state.controllers) : '',
			state_source: this.isLive(key) ? 'live' : 'poll',
			...(table
				? {
						table: table.table,
						page: String(table.page),
						page_count: String(table.pageCount),
						page_key: table.key ?? '',
						cycle_state: cycleState(table),
					}
				: EMPTY_TABLE_VARIABLES),
		})

		this.lastSecondsLeft = table ? this.secondsLeft(key, table) : ''
		this.setVariableValues({ cycle_seconds_left: this.lastSecondsLeft })
		if (table?.cycling && !table.held) this.startTicker()
		else this.stopTicker()
	}

	/**
	 * Whole seconds to the next page turn, counted down locally from the last
	 * report — the server only speaks when a page turns, not once a second.
	 */
	secondsLeft(key: string, table: TableReport): string {
		if (!table.cycling || table.held || table.secondsLeft === null) return ''
		const at = this.tableStamps.get(key)?.at ?? Date.now()
		const left = table.secondsLeft - (Date.now() - at) / 1000
		return String(Math.max(0, Math.ceil(left)))
	}

	/**
	 * Keep `cycle_seconds_left` counting between reports.
	 *
	 * Ticks four times a second so the number changes close to the real second,
	 * but only writes when the whole-second value changes — Companion sees at
	 * most one update a second.
	 */
	private startTicker(): void {
		if (this.ticker) return
		this.ticker = setInterval(() => {
			const target = this.resolveChannel('')
			if (!target) return
			const key = `${target.project}/${target.channel}`
			const table = this.states.get(key)?.playback?.tables?.[0]
			const value = table ? this.secondsLeft(key, table) : ''
			if (value === this.lastSecondsLeft) return
			this.lastSecondsLeft = value
			this.setVariableValues({ cycle_seconds_left: value })
		}, 250)
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker)
		this.ticker = undefined
	}

	/* ------------------------------------------------------------ channels */

	/**
	 * Work out what an action or feedback is aimed at.
	 *
	 * A blank channel means the connection's default. Accepts `project/channel`
	 * too, so one connection can reach a second project without reconfiguring —
	 * the address is the same shape the user already reads off the portal.
	 */
	resolveChannel(raw: string | undefined): Target | null {
		const value = (raw ?? '').trim()
		const fallbackProject = this.config.project?.trim() ?? ''

		if (value.includes('/')) {
			const at = value.indexOf('/')
			const project = value.slice(0, at).trim()
			const channel = value.slice(at + 1).trim()
			if (!project || !channel) return null
			this.nominateDefault(project, channel)
			return { project, channel }
		}

		if (!fallbackProject) return null
		const channel = value || this.defaultChannel
		if (!channel) return null
		this.nominateDefault(fallbackProject, channel)
		return { project: fallbackProject, channel }
	}

	/**
	 * The channel used when a button leaves the field blank.
	 *
	 * There is no config field for it on purpose: a default that silently drives
	 * a *different* graphic than the button says is worse than a button that
	 * does nothing and logs why. This is only set once something has named a
	 * channel explicitly, so the variables have something to report.
	 */
	private defaultChannel = ''

	/** The first channel in this connection's own project to be named becomes the default. */
	private nominateDefault(project: string, channel: string): void {
		if (this.defaultChannel) return
		if (project !== (this.config.project?.trim() ?? '')) return
		this.defaultChannel = channel
	}

	/**
	 * Record that a placed action or feedback is looking at `raw`, replacing
	 * whatever it looked at before, and return the resolved target.
	 *
	 * Called from action `subscribe` and on every feedback run, so an edited
	 * channel field — or a variable in it changing value — moves the claim
	 * rather than adding a second one.
	 */
	track(ownerId: string, raw: string | undefined): Target | null {
		const target = this.resolveChannel(raw)
		if (!target) {
			this.untrack(ownerId)
			return null
		}

		const key = `${target.project}/${target.channel}`
		const previous = this.owners.get(ownerId)
		if (previous === key) return target

		this.owners.set(ownerId, key)
		if (previous !== undefined) this.release(previous)
		this.syncSockets()
		if (!this.states.has(key)) this.pollNow()
		return target
	}

	/** Companion reported the action or feedback removed, disabled or edited. */
	untrack(ownerId: string): void {
		const previous = this.owners.get(ownerId)
		if (previous === undefined) return
		this.owners.delete(ownerId)
		this.release(previous)
	}

	private isWatched(key: string): boolean {
		for (const owned of this.owners.values()) if (owned === key) return true
		return false
	}

	/**
	 * Forget a channel once nothing points at it: close its socket, stop
	 * polling it and drop its cached state. If it was the default, hand the role
	 * to the next channel in this project that something still watches, so the
	 * variables keep reporting a channel that is actually on a button.
	 */
	private release(key: string): void {
		if (this.isWatched(key)) return
		this.states.delete(key)
		this.tableStamps.delete(key)
		this.syncSockets()

		const project = this.config.project?.trim() ?? ''
		if (key !== `${project}/${this.defaultChannel}`) return

		this.defaultChannel = ''
		for (const owned of this.owners.values()) {
			const next = splitKey(owned)
			if (next.project === project) {
				this.defaultChannel = next.channel
				break
			}
		}
		this.publishDefaultVariables()
	}

	/** Cached state for a feedback, or undefined before the first report lands. */
	stateFor(ownerId: string, rawChannel: string | undefined): ChannelState | undefined {
		const target = this.track(ownerId, rawChannel)
		if (!target) return undefined
		return this.states.get(`${target.project}/${target.channel}`)
	}

	/** Cached state for an action's target, without claiming anything. */
	cachedState(target: Target): ChannelState | undefined {
		return this.states.get(`${target.project}/${target.channel}`)
	}

	/** One place that turns an error into a status and a log line. */
	reportError(what: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error)

		if (error instanceof BreezeError) {
			if (error.status === 401) {
				this.updateStatus(InstanceStatus.AuthenticationFailure, 'API key rejected')
				this.log('error', `${what}: ${message} — check the API key against BREEZE_API_KEY`)
				return
			}
			if (error.status === 404) {
				// Not a connection problem: the server answered. Saying otherwise
				// would send someone to check the network cable over a typo.
				this.log('error', `${what}: not found — check the project and channel keys`)
				return
			}
			if (error.status === 400) {
				// The server said what was wrong with the request; pass it on.
				this.log('error', `${what}: ${message}`)
				return
			}
			if (error.status === 0) {
				this.updateStatus(InstanceStatus.ConnectionFailure, `Cannot reach ${this.api.base}`)
				this.log('error', `${what}: ${message}`)
				return
			}
		}

		this.updateStatus(InstanceStatus.UnknownError, message)
		this.log('error', `${what}: ${message}`)
	}
}

/** Table variables when the default channel has no paged table. */
const EMPTY_TABLE_VARIABLES = {
	table: '',
	page: '',
	page_count: '',
	page_key: '',
	cycle_state: 'none',
	cycle_seconds_left: '',
} as const

/** Split a `project/channel` key. Project keys cannot contain `/`, so the first one is the seam. */
function splitKey(key: string): Target {
	const at = key.indexOf('/')
	return { project: key.slice(0, at), channel: key.slice(at + 1) }
}
