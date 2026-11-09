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

import {
	BreezeApi,
	BreezeError,
	type ChannelExtras,
	type ChannelRef,
	type ChannelState,
	type SourceSummary,
	type TableReport,
} from './api.js'
import {
	cellText,
	readCompositions,
	readRundownLive,
	readRundowns,
	readSports,
	itemTitle,
	type CompositionInfo,
	type Rundown,
	type RundownItem,
	type RundownLive,
	type SportInfo,
} from './catalogue.js'
import {
	UNKNOWN_TIMER,
	scrollAtEnd,
	scrollPercent,
	scrollRemaining,
	speedText,
	timerFinished,
	timerMs,
	timerRunning,
	timerText,
	timerTickMs,
	type ScrollInfo,
	type ScrollState,
	type TimerSettings,
} from './clocks.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { LiveChannel, hasWebSocket } from './live.js'
import { BuildPresets } from './presets.js'
import { mediaDown, mediaUp, sourceState } from './sources.js'
import { cycleState, pageNumber } from './tables.js'
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
const ALL_FEEDBACKS = ['on_air', 'playback_state', 'source_connected', 'cycle_held', 'page_is', 'table_page'] as const

/** Feedbacks that read timers and rolls (0.79+): re-checked when those change, and as a clock ticks. */
const CLOCK_FEEDBACKS = [
	'timer_running',
	'timer_under',
	'timer_value',
	'roll_is',
	'roll_value',
	'roll_color',
	'playhead_value',
	'playback_color',
] as const

/** Feedbacks that read the rundowns (0.79+). */
const RUNDOWN_FEEDBACKS = ['rundown_item', 'rundown_cued_differs', 'rundown_value'] as const

/** Feedbacks that read a game table's or a poll's rows (0.79+). */
const ROW_FEEDBACKS = ['game_value', 'game_column_is', 'poll_value', 'poll_open', 'poll_leading'] as const

/** How many rows to read of a watched source: a game table's state is its first row; a poll has at most 12. */
const ROWS_READ = 12

/** One channel's timers and rolls, as `/state` last gave them, with the hub's clock offset at that moment. */
interface Clocks extends ChannelExtras {
	/** Hub clock minus ours, ms. Network delay is ignored: it is far below a timer's second. */
	offset: number
}

/** What a timer shows on a button. */
export interface TimerView {
	id: string
	text: string
	/** Whole seconds — rounded up for a countdown, down otherwise, as the text is. */
	seconds: number
	running: boolean
	finished: boolean
}

/** What the output page's debug overlay shows for a graphic, worked out on this side. */
export interface PlayheadView {
	state: string
	/** Seconds into the composition — carried forward from the last report while it plays. */
	time: number
	/** Seconds, from the project document; null before it is read. */
	duration: number | null
	step: number
	stepCount: number
	/** 0–100 through the composition; 0 without a duration. */
	percent: number
}

/** What a roll shows on a button. */
export interface RollView {
	id: string
	/** 0–100, or null until an output has said how long the text is. */
	percent: number | null
	running: boolean
	reversed: boolean
	atEnd: boolean
	speed: string
	/** Real seconds to the end it is heading for at this speed; null for a loop or before the length is known. */
	remaining: number | null
}

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
	/** The connect generation of the poll round in flight, if any — see `poll`. */
	private pollingGeneration: number | undefined
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

	/* 0.79: what the project holds, read at connect — see `catalogue.ts`. */
	private compositions = new Map<string, CompositionInfo>()
	private rundownList: Rundown[] = []
	private sportsInfo = new Map<string, SportInfo>()
	/** The connection's own project's channels from `/api/channels`, by channel name. */
	private channelRefs = new Map<string, ChannelRef>()

	/** Armed and on air, per rundown, as the rundown channel last said. */
	private rundownLive = new Map<string, RundownLive>()
	/** The rundown channel's socket — `project/#rundowns`, with its (small) data. */
	private rundownSocket: LiveChannel | undefined
	/** `$rundownsRev` as last seen, so a save is noticed once. */
	private rundownsRev: unknown
	private rundownTimer: NodeJS.Timeout | undefined
	private rundownsReload: NodeJS.Timeout | undefined
	private rundownsInflight = false
	/** The rundown variables last published, so an unchanged set is not sent again. */
	private rundownShown = ''
	private timerShown = ''
	private gameShown = ''

	/** Timers and rolls per channel key, from `/state` (0.79+). */
	private clocks = new Map<string, Clocks>()
	/** Owners (`feedback:<id>`) that show a timer or a roll, so their channel's clocks are kept fresh. */
	private clockOwners = new Set<string>()
	private clocksQueued = new Set<string>()
	private clocksTimer: NodeJS.Timeout | undefined
	private clockTicker: NodeJS.Timeout | undefined
	private clockSignature = ''
	/** Owners that show a playhead, so it is ticked while the graphic plays. */
	private playheadOwners = new Set<string>()
	/** When each channel's state last arrived, by our clock — to carry a report forward. */
	private receivedAt = new Map<string, number>()

	/** Game and poll rows per source id, as last read (0.79+). */
	private rows = new Map<string, Array<Record<string, unknown>>>()
	/** Which placed action or feedback reads which source's rows. */
	private rowOwners = new Map<string, string>()
	private rowsTimer: NodeJS.Timeout | undefined
	private rowsInflight = false
	private rowsSignature = ''

	/**
	 * Bumped by every `connect()` and by `destroy()`.
	 *
	 * Connecting, polling and version checks all wait on the network, and the
	 * config — or the instance itself — can change while they wait: an operator
	 * saving twice while correcting a host, or removing the connection. Each
	 * captures this before its first `await` and drops its result if it moved,
	 * so an answer from the old server cannot set the status, the version gate
	 * or a timer for the new one, and nothing restarts after `destroy()`.
	 */
	private generation = 0
	private destroyed = false

	/** As `/healthz` last reported it; empty until the server has answered once. */
	serverVersion = ''
	/** Null until the first answer, so the first success is not taken for a recovery. */
	private reachable: boolean | null = null
	/**
	 * Why the server is refusing this connection's key, or undefined while
	 * there is no reason to think it is.
	 *
	 * Breeze checks the key only on commands — every read is open — so a wrong
	 * key cannot show up in a poll, and probing for one would spend one of the
	 * five wrong keys a minute Breeze allows this machine. It is set by a
	 * refused command, or at connect when the server needs a key and none is
	 * configured. While it is set, the status stays AuthenticationFailure
	 * through every poll and socket message, until a command succeeds or the
	 * config is saved.
	 */
	private keyProblem: string | undefined

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
			media_up: '',
			media_down: '',
			mode: '',
			...EMPTY_TABLE_VARIABLES,
			...EMPTY_RUNDOWN_VARIABLES,
			...EMPTY_TIMER_VARIABLES,
			...EMPTY_GAME_VARIABLES,
		})

		/*
		 * Not awaited. Companion allows `init` ten seconds and then restarts the
		 * module, and connect() makes up to four requests of up to five seconds
		 * each: a slow server would put the module in a restart loop. The status
		 * says Connecting meanwhile, and connect() reports its own failures.
		 */
		this.startConnect()
	}

	/** Connect in the background — see `init`. Every failure inside is already reported. */
	private startConnect(): void {
		this.connect().catch((error: unknown) => this.reportError('connect', error))
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.generation += 1
		this.sourcesGeneration += 1
		this.stopPolling()
		this.stopSourcePolling()
		this.stopSockets()
		this.stopTicker()
		this.stopRundowns()
		this.stopClocks()
		this.stopRows()
		if (this.refreshQueued) clearTimeout(this.refreshQueued)
		this.refreshQueued = undefined
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets ?? { apiKey: '' }
		// Sockets dial the old address; drop them before the API is replaced.
		this.stopSockets()
		this.stopRundowns()
		this.stopClocks()
		this.stopRows()
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
		this.setVariableValues({
			sources_failing: '',
			sources_on_backup: '',
			media_up: '',
			media_down: '',
			mode: '',
			...EMPTY_RUNDOWN_VARIABLES,
			...EMPTY_TIMER_VARIABLES,
			...EMPTY_GAME_VARIABLES,
		})
		this.compositions.clear()
		this.rundownList = []
		this.sportsInfo.clear()
		this.channelRefs.clear()
		this.rundownLive.clear()
		this.rundownsRev = undefined
		this.rundownShown = ''
		this.timerShown = ''
		this.gameShown = ''
		this.clocks.clear()
		this.clockOwners.clear()
		this.playheadOwners.clear()
		this.receivedAt.clear()
		this.clockSignature = ''
		this.rows.clear()
		this.rowOwners.clear()
		this.rowsSignature = ''
		this.serverVersion = ''
		this.reachable = null
		// The key may be the thing that was just fixed.
		this.keyProblem = undefined
		// Blank-channel buttons resolved against the old project. Drop every
		// claim and have Companion re-report what is placed, so each one is
		// re-resolved against the new config.
		this.owners.clear()
		this.defaultChannel = ''
		// In the background, for the same reason as in init(): Companion gives
		// configUpdated five seconds. Its synchronous start has already moved the
		// connect generation on, so the re-subscriptions below poll the new
		// server, and anything still running against the old one is ignored.
		this.startConnect()
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
		const generation = ++this.generation
		this.stopPolling()
		this.setStatus(InstanceStatus.Connecting)

		try {
			const health = await this.api.health()
			// A newer connect() or destroy() ran while this one waited; it owns
			// the status, the version and the timers now.
			if (!this.isCurrent(generation)) return
			this.applyVersion(health.version, false)
			await this.refreshPresets(generation)
			if (!this.isCurrent(generation)) return
			await this.checkKeyRequired(generation)
			if (!this.isCurrent(generation)) return
			this.reachable = true
			this.showStatus()
		} catch (error) {
			if (!this.isCurrent(generation)) return
			this.reachable = false
			this.reportError('connect', error)
			// Still poll: the server may simply not be up yet, and a connection
			// that recovers on its own is the difference between a working show
			// and someone restarting Companion during a break.
		}

		this.syncSockets()
		this.startPolling()
		this.startSourcePolling()
		this.syncRundowns()
		this.startRows()
	}

	/**
	 * Catch a missing key before the first press: `GET /api/auth` says whether
	 * the server needs one, and never counts as an attempt. Whether a key that
	 * *is* configured is the right one only a command can tell — see
	 * `keyProblem`. Older servers have no such route; nothing is lost.
	 */
	private async checkKeyRequired(generation: number): Promise<void> {
		if (this.supports('auth') !== true || this.secrets.apiKey) return
		try {
			const { keyRequired } = await this.api.auth()
			if (!this.isCurrent(generation) || !keyRequired) return
			this.keyProblem = 'This server needs an API key'
			this.log(
				'error',
				'The server has BREEZE_API_KEY set and this connection has no API key — every command will be refused',
			)
		} catch {
			// Only a hint: whether the server is there was decided by /healthz.
		}
	}

	/** The status last sent to Companion, so an unchanged one is not sent again every tick. */
	private statusShown: string | undefined

	/** `updateStatus`, only when the status or its message actually changes. */
	private setStatus(status: InstanceStatus, message?: string): void {
		const next = JSON.stringify([status, message ?? null])
		if (next === this.statusShown) return
		this.statusShown = next
		this.updateStatus(status, message)
	}

	/** Ok, unless the server has refused the key — reachable and refusing is still a failure. */
	private showStatus(): void {
		if (this.keyProblem) this.setStatus(InstanceStatus.AuthenticationFailure, this.keyProblem)
		else this.setStatus(InstanceStatus.Ok)
	}

	/**
	 * A command went through, so the key — if one is needed — is right. The
	 * only proof there is: reads succeed with any key.
	 */
	commandSucceeded(): void {
		if (this.destroyed) return
		if (this.keyProblem) this.log('info', 'API key accepted')
		this.keyProblem = undefined
		this.setStatus(InstanceStatus.Ok)
	}

	/** Whether async work started under `generation` may still act on its result. */
	private isCurrent(generation: number): boolean {
		return !this.destroyed && generation === this.generation
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
		if (this.destroyed) return
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
		if (this.destroyed || version === this.serverVersion) return
		const before = this.serverVersion
		this.serverVersion = version
		this.setVariableValues({ server_version: version })
		if (before) this.log('info', `Breeze server is now ${version} (was ${before})`)
		this.syncSockets()
		this.syncRundowns()
		// PREV is only offered to servers that have it.
		if (rebuildPresets) void this.refreshPresets()
	}

	/** Re-read the version after the server comes back — it may have been upgraded while away. */
	private async recheckVersion(): Promise<void> {
		const generation = this.generation
		try {
			const health = await this.api.health()
			if (!this.isCurrent(generation)) return
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
	private async refreshPresets(generation = this.generation): Promise<void> {
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
			if (!this.isCurrent(generation)) return
			// Read before the presets, so a source with a backup gets its button.
			if (this.supports('sources') === true) await this.pollSources()
			if (!this.isCurrent(generation)) return
			const mine = all.find((p) => p.id === project)
			if (!mine) {
				this.log('warn', `Project "${project}" not found on the server — no presets generated`)
				this.setPresetDefinitions([], {})
				return
			}
			this.channelRefs = new Map(mine.channels.map((c) => [c.channel, c]))
			await this.readCatalogue(project, generation)
			if (!this.isCurrent(generation)) return
			BuildPresets(this, mine.channels)
			this.log('debug', `Built presets for ${mine.channels.length} channels in ${mine.name}`)
		} catch (error) {
			if (!this.isCurrent(generation)) return
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
		if (this.destroyed) return
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
					// The hub sends a state on every timer or roll command, but the
					// lean socket leaves the clocks out; read them from /state.
					if (this.wantsClocks(channel)) this.queueClocks(channel)
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
		if (this.watchdog || this.destroyed) return
		this.watchdog = setInterval(() => void this.checkServer(), WATCHDOG_MS)
	}

	private stopWatchdog(): void {
		if (this.watchdog) clearInterval(this.watchdog)
		this.watchdog = undefined
	}

	private async checkServer(): Promise<void> {
		if (![...this.sockets.values()].some((socket) => socket.live)) return
		const generation = this.generation
		try {
			const health = await this.api.health()
			if (!this.isCurrent(generation)) return
			this.applyVersion(health.version, true)
		} catch (error) {
			if (!this.isCurrent(generation)) return
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
		// Never two at once: a handle overwritten here could not be cleared again.
		this.stopPolling()
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
	 * Refresh every watched channel that has no live socket — or, with none to
	 * read and nothing live, just ask `/healthz`, so the status still follows
	 * the server.
	 *
	 * Guarded against overlap: a server that has gone away leaves each request
	 * to time out, and without this the intervals would stack up requests faster
	 * than they drain. The guard is per connect generation, so a slow round
	 * against the old server neither blocks the new one nor reports for it.
	 */
	private async poll(): Promise<void> {
		if (this.destroyed || this.pollingGeneration === this.generation) return

		const keys = [...new Set(this.owners.values())].filter((key) => !this.isLive(key))
		const anyLive = [...this.sockets.values()].some((socket) => socket.live)
		// Every watched channel is live: the sockets and the watchdog report for it.
		if (keys.length === 0 && anyLive) return

		const generation = this.generation
		this.pollingGeneration = generation
		try {
			if (keys.length === 0) {
				/*
				 * No channel to read, but the status must still follow the
				 * server. Without this a connection whose buttons only use
				 * sources, the mode or camera lists — or that has no buttons
				 * yet — never noticed an outage, and never recovered from a
				 * failed connect: Companion started before Breeze stayed
				 * ConnectionFailure, with no presets, until someone saved the
				 * config. `/healthz` is open and cheap; a recovery re-reads the
				 * version, which also builds the presets (`markReachable`).
				 */
				let reachable: boolean
				try {
					await this.api.health()
					reachable = true
				} catch (error) {
					reachable = error instanceof BreezeError && error.status !== 0
				}
				if (!this.isCurrent(generation)) return
				this.markReachable(reachable)
				return
			}

			let reachable = anyLive
			let changed = false
			for (const key of keys) {
				// Each key carries its own project, so a feedback addressing
				// `other/channel` is read from `other` — not from this
				// connection's configured project.
				const { project, channel } = splitKey(key)
				try {
					const { state, extras } = await this.api.stateWithExtras(project, channel)
					if (!this.isCurrent(generation)) return
					// Released while the request was in flight — or taken over by
					// a socket — so do not overwrite it.
					if (this.isWatched(key) && !this.isLive(key)) {
						changed = this.acceptState(key, state, true) || changed
						this.acceptClocks(key, extras)
					}
					reachable = true
				} catch (error) {
					if (!this.isCurrent(generation)) return
					// A 404 is a wrong channel name, not a dead server — drop the
					// stale entry so a feedback stops claiming the graphic is up.
					if (this.states.delete(key)) changed = true
					this.tableStamps.delete(key)
					if (error instanceof BreezeError && error.status !== 0) reachable = true
				}
			}

			this.markReachable(reachable)
			// Only when something a button or variable shows has changed, or the
			// default channel has moved — not on every tick of an idle show.
			if (changed || this.defaultKey() !== this.publishedDefault) this.refresh()
		} finally {
			if (this.pollingGeneration === generation) this.pollingGeneration = undefined
		}
	}

	private markReachable(ok: boolean): void {
		if (this.destroyed) return
		const recovered = ok && this.reachable === false
		this.reachable = ok
		if (ok) this.showStatus()
		else this.setStatus(InstanceStatus.ConnectionFailure, `No response from ${this.api.base}`)
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
	private acceptState(key: string, state: ChannelState, immediate = false): boolean {
		const before = this.states.get(key)
		this.states.set(key, state)
		this.receivedAt.set(key, Date.now())

		const signature = JSON.stringify(state.playback?.tables ?? null)
		if (this.tableStamps.get(key)?.signature !== signature) {
			this.tableStamps.set(key, { signature, at: Date.now() })
		}

		const changed = before === undefined || shownOf(before) !== shownOf(state)
		if (changed && !immediate) this.queueRefresh()
		return changed
	}

	/** The default channel's key as `resolveChannel('')` would give it, without nominating one. */
	private defaultKey(): string {
		const project = this.config.project?.trim() ?? ''
		return project && this.defaultChannel ? `${project}/${this.defaultChannel}` : ''
	}

	/** The default channel the variables were last published for. */
	private publishedDefault = ''

	private queueRefresh(): void {
		if (this.refreshQueued || this.destroyed) return
		this.refreshQueued = setTimeout(() => {
			this.refreshQueued = undefined
			this.refresh()
		}, 50)
	}

	private refresh(): void {
		this.publishDefaultVariables()
		this.checkFeedbacks(...ALL_FEEDBACKS)
		// A graphic starting to play starts the playhead ticking.
		this.onClocksChanged()
	}

	/** Variables track the connection's default channel — see `variables.ts`. */
	private publishDefaultVariables(): void {
		const target = this.resolveChannel('')
		this.publishedDefault = target ? `${target.project}/${target.channel}` : ''
		if (!target) {
			this.setVariableValues({
				project: this.config.project ?? '',
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
						page: pageNumber(table)?.toString() ?? '',
						page_count: Number.isInteger(table.pageCount) ? String(table.pageCount) : '',
						page_key: table.key ?? '',
						cycle_state: cycleState(table),
					}
				: EMPTY_TABLE_VARIABLES),
		})

		this.lastSecondsLeft = table ? this.secondsLeft(key, table) : ''
		this.setVariableValues({ cycle_seconds_left: this.lastSecondsLeft })
		if (table?.cycling && !table.held) this.startTicker()
		else this.stopTicker()
		// The default channel may have moved; its timer goes with it.
		this.publishTimerVariables()
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
		if (this.ticker || this.destroyed) return
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

	/* ----------------------------------------------- 0.79: the catalogue */

	/**
	 * Read what the project holds — compositions, rundowns, the sports — for
	 * presets and for showing timers as the output shows them. Each read stands
	 * alone: a failure leaves that part empty and the rest working.
	 */
	private async readCatalogue(project: string, generation: number): Promise<void> {
		// The project document is as old as Breeze: durations and markers for
		// the DEBUG buttons on any server. The rest is 0.79's.
		try {
			const doc = await this.api.project(project)
			if (!this.isCurrent(generation)) return
			this.compositions = readCompositions(doc)
		} catch (error) {
			if (!this.isCurrent(generation)) return
			this.log('debug', `Could not read the project's compositions: ${messageOf(error)}`)
		}
		if (this.supports('rundowns') !== true) {
			this.rundownList = []
			this.sportsInfo.clear()
			return
		}
		await this.readRundownsDoc(project, generation)
		if (!this.isCurrent(generation)) return
		try {
			const sports = await this.api.sports()
			if (!this.isCurrent(generation)) return
			this.sportsInfo = readSports(sports)
		} catch {
			// Only the game presets need it; they are left out.
		}
		this.onClocksChanged(true)
	}

	private async readRundownsDoc(project: string, generation: number): Promise<void> {
		try {
			const doc = await this.api.rundowns(project)
			if (!this.isCurrent(generation)) return
			this.rundownList = readRundowns(doc)
		} catch (error) {
			if (!this.isCurrent(generation)) return
			this.log('debug', `Could not read the project's rundowns: ${messageOf(error)}`)
		}
		this.publishRundownVariables()
		this.checkFeedbacks(...RUNDOWN_FEEDBACKS)
	}

	/** The project's compositions with their timers, rolls and fields — for presets. */
	compositionList(): CompositionInfo[] {
		return [...this.compositions.values()]
	}

	/** The project's rundowns, in `rundowns.json` order — for presets and option defaults. */
	rundowns(): Rundown[] {
		return this.rundownList
	}

	/** A sport's scoring buttons, from `/api/sports`. */
	sport(id: string): SportInfo | undefined {
		return this.sportsInfo.get(id)
	}

	/** The project's sport game tables — manual sources made from a template's `game` table. */
	gameSources(): SourceSummary[] {
		return [...this.sources.values()].filter((s) => s.def.type === 'manual' && s.def.template?.table === 'game')
	}

	/** The project's operator polls. */
	pollList(): SourceSummary[] {
		return [...this.sources.values()].filter((s) => s.def.type === 'poll')
	}

	/** Output names the rundowns take items onto, in first-use order. */
	outputNames(): string[] {
		const names: string[] = []
		for (const rundown of this.rundownList) {
			for (const item of rundown.items) if (item.output && !names.includes(item.output)) names.push(item.output)
		}
		return names
	}

	/** The compositions the rundowns take onto an output. */
	outputCompositions(output: string): string[] {
		const ids: string[] = []
		for (const rundown of this.rundownList) {
			for (const item of rundown.items) {
				if (item.output === output && !ids.includes(item.composition)) ids.push(item.composition)
			}
		}
		return ids
	}

	/** The composition a channel plays: a scene or element's own, or an output's first. */
	compositionFor(channel: string): CompositionInfo | undefined {
		if (channel.startsWith('@')) {
			const first = this.outputCompositions(channel.slice(1))[0]
			return first ? this.compositions.get(first) : undefined
		}
		return this.compositions.get(this.channelRefs.get(channel)?.ref ?? channel)
	}

	/* ------------------------------------------------ 0.79: rundowns */

	/** A rundown by id, or the first one for a blank field. */
	rundownFor(raw: string | undefined): Rundown | undefined {
		const id = (raw ?? '').trim()
		if (!id) return this.rundownList[0]
		return this.rundownList.find((r) => r.id === id)
	}

	/** The rundown id an action should send: the one named, or the first. Blank when there is none. */
	rundownId(raw: string | undefined): string {
		const id = (raw ?? '').trim()
		return id || this.rundownList[0]?.id || ''
	}

	/** Armed and on air for a rundown, as last heard. */
	rundownState(id: string): RundownLive | undefined {
		return this.rundownLive.get(id)
	}

	/** What a press just answered — the next button press reads it, not the last broadcast. */
	noteArmed(rundown: string, armed: string | null | undefined): void {
		if (armed === undefined) return
		const live = this.rundownLive.get(rundown) ?? { armed: null, onAir: {} }
		if (live.armed === armed) return
		this.rundownLive.set(rundown, { ...live, armed })
		this.publishRundownVariables()
		this.checkFeedbacks(...RUNDOWN_FEEDBACKS)
	}

	/** An item's title as the rundown panel shows it. */
	itemTitle(item: RundownItem | undefined): string {
		return item ? itemTitle(item, this.compositions.get(item.composition)?.name) : ''
	}

	/**
	 * Follow the rundown channel while the server has rundowns. The socket asks
	 * for the channel's data: it is only `$rundown` and `$rundownsRev`, since
	 * Breeze sends no data-source rows to that channel.
	 */
	private syncRundowns(): void {
		if (this.destroyed) return
		const project = this.config.project?.trim() ?? ''
		const wanted = project !== '' && this.supports('rundowns') === true
		const key = `${project}/#rundowns`
		if (!wanted || !this.liveEnabled()) {
			this.rundownSocket?.stop()
			this.rundownSocket = undefined
		} else if (this.rundownSocket?.key !== key) {
			this.rundownSocket?.stop()
			this.rundownSocket = new LiveChannel(
				this.api.socketUrl,
				key,
				{
					state: (_key, state) => this.acceptRundownData(state.data),
					open: () => undefined,
					close: () => void this.pollRundowns(),
				},
				true,
			)
			this.rundownSocket.start()
		}
		// The fallback: read each rundown's state while the socket is not live.
		if (wanted && !this.rundownTimer) {
			const interval = Math.max(1000, this.config.pollInterval ?? 1000)
			this.rundownTimer = setInterval(() => void this.pollRundowns(), interval)
		} else if (!wanted && this.rundownTimer) {
			clearInterval(this.rundownTimer)
			this.rundownTimer = undefined
		}
	}

	private stopRundowns(): void {
		this.rundownSocket?.stop()
		this.rundownSocket = undefined
		if (this.rundownTimer) clearInterval(this.rundownTimer)
		this.rundownTimer = undefined
		if (this.rundownsReload) clearTimeout(this.rundownsReload)
		this.rundownsReload = undefined
	}

	private acceptRundownData(data: Record<string, unknown>): void {
		if (this.destroyed) return
		const live = readRundownLive(data['$rundown'])
		this.applyRundownLive(live, true)
		const rev = data['$rundownsRev']
		if (rev !== undefined && rev !== this.rundownsRev) {
			// The first revision seen is the one the catalogue was read at.
			const saved = this.rundownsRev !== undefined
			this.rundownsRev = rev
			if (saved) this.queueRundownsReload()
		}
	}

	private applyRundownLive(live: Map<string, RundownLive>, replace: boolean): void {
		const next = replace ? live : new Map([...this.rundownLive, ...live])
		if (JSON.stringify([...next]) === JSON.stringify([...this.rundownLive])) return
		this.rundownLive = next
		this.publishRundownVariables()
		this.checkFeedbacks(...RUNDOWN_FEEDBACKS)
	}

	private async pollRundowns(): Promise<void> {
		if (this.destroyed || this.rundownsInflight || this.rundownSocket?.live) return
		const project = this.config.project?.trim() ?? ''
		if (!project || this.rundownList.length === 0) return
		const generation = this.generation
		this.rundownsInflight = true
		try {
			const read = new Map<string, RundownLive>()
			for (const rundown of this.rundownList) {
				try {
					const body = await this.api.rundownState(project, rundown.id)
					if (!this.isCurrent(generation)) return
					const live = readRundownLive({ [rundown.id]: body }).get(rundown.id)
					if (live) read.set(rundown.id, live)
				} catch {
					// The channel poll and the watchdog report the server.
				}
			}
			if (this.isCurrent(generation) && !this.rundownSocket?.live) this.applyRundownLive(read, false)
		} finally {
			this.rundownsInflight = false
		}
	}

	/** `rundowns.json` was saved: re-read it, and rebuild the presets so new items get buttons. */
	private queueRundownsReload(): void {
		if (this.rundownsReload || this.destroyed) return
		this.rundownsReload = setTimeout(() => {
			this.rundownsReload = undefined
			void this.refreshPresets()
		}, 500)
	}

	/** Variables follow the first rundown — see `variables.ts`. */
	private publishRundownVariables(): void {
		const rundown = this.rundownList[0]
		const live = rundown ? this.rundownLive.get(rundown.id) : undefined
		const armed = rundown?.items.find((i) => i.id === live?.armed)
		const at = armed ? rundown.items.indexOf(armed) : -1
		let onAirId: string | undefined
		if (live) {
			onAirId = armed ? live.onAir[armed.output ? `@${armed.output}` : armed.composition] : undefined
			onAirId ??= Object.values(live.onAir).at(-1)
		}
		const onAir = rundown?.items.find((i) => i.id === onAirId)
		const values = {
			rundown: rundown?.name ?? '',
			cued_item: this.itemTitle(armed),
			cued_composition: armed ? (this.compositions.get(armed.composition)?.name ?? armed.composition) : '',
			cued_position: armed ? `${at + 1}/${rundown.items.length}` : '',
			on_air_item: this.itemTitle(onAir),
		}
		const shown = JSON.stringify(values)
		if (shown === this.rundownShown) return
		this.rundownShown = shown
		this.setVariableValues(values)
	}

	/* --------------------------------------------- 0.79: timers and rolls */

	/** Claim a channel for a timer or roll feedback, so its clocks are read. */
	trackClocks(ownerId: string, raw: string | undefined): string | null {
		const target = this.track(ownerId, raw)
		if (!target) return null
		this.clockOwners.add(ownerId)
		const key = `${target.project}/${target.channel}`
		if (!this.clocks.has(key)) this.queueClocks(key)
		return key
	}

	/** Whether anything shows this channel's timers or rolls — the default channel's variables count. */
	private wantsClocks(key: string): boolean {
		if (this.supports('timers') === false) return false
		if (key === this.defaultKey()) return true
		for (const owner of this.clockOwners) if (this.owners.get(owner) === key) return true
		return false
	}

	/** Read a channel's clocks soon. Bursts — a command and its echo — collapse into one read. */
	queueClocks(key: string): void {
		if (this.destroyed || this.supports('timers') === false) return
		this.clocksQueued.add(key)
		if (this.clocksTimer) return
		this.clocksTimer = setTimeout(() => {
			this.clocksTimer = undefined
			void this.readClocks()
		}, 100)
	}

	private async readClocks(): Promise<void> {
		const keys = [...this.clocksQueued]
		this.clocksQueued.clear()
		const generation = this.generation
		for (const key of keys) {
			const { project, channel } = splitKey(key)
			try {
				const { extras } = await this.api.stateWithExtras(project, channel)
				if (!this.isCurrent(generation)) return
				if (this.isWatched(key)) this.acceptClocks(key, extras)
			} catch {
				// The poll and the watchdog report the server.
			}
		}
	}

	private acceptClocks(key: string, extras: ChannelExtras): void {
		if (this.supports('timers') === false) return
		const clock = extras.timers?.clock ?? extras.scrolls?.clock
		this.clocks.set(key, { ...extras, offset: clock !== undefined ? clock - Date.now() : 0 })
		this.onClocksChanged()
	}

	private stopClocks(): void {
		if (this.clocksTimer) clearTimeout(this.clocksTimer)
		this.clocksTimer = undefined
		this.clocksQueued.clear()
		if (this.clockTicker) clearInterval(this.clockTicker)
		this.clockTicker = undefined
	}

	/** The settings of the layer that shows a timer on a channel; a plain count-up when none does. */
	private timerSettings(channel: string, id: string): TimerSettings {
		const own = channel.startsWith('@')
			? this.outputCompositions(channel.slice(1)).map((c) => this.compositions.get(c))
			: [this.compositionFor(channel)]
		for (const comp of own) {
			const found = comp?.timers.get(id)
			if (found) return found
		}
		for (const comp of this.compositions.values()) {
			const found = comp.timers.get(id)
			if (found) return found
		}
		return UNKNOWN_TIMER
	}

	/** Timer ids a channel shows: its layers' first, then any the hub has state for. */
	timerIds(channel: string, key?: string): string[] {
		const ids: string[] = []
		const comps = channel.startsWith('@')
			? this.outputCompositions(channel.slice(1)).map((c) => this.compositions.get(c))
			: [this.compositionFor(channel)]
		for (const comp of comps) for (const id of comp?.timers.keys() ?? []) if (!ids.includes(id)) ids.push(id)
		const held = key ? this.clocks.get(key)?.timers?.timers : undefined
		for (const id of Object.keys(held ?? {})) if (!ids.includes(id)) ids.push(id)
		return ids
	}

	private viewTimer(key: string, rawId: string | undefined): TimerView | undefined {
		const clocks = this.clocks.get(key)
		const { channel } = splitKey(key)
		const ids = (rawId ?? '').trim() ? [] : this.timerIds(channel, key)
		const id = (rawId ?? '').trim() || (ids.includes('main') ? 'main' : ids[0])
		if (!id || !clocks) return undefined
		const state = clocks.timers?.timers[id]
		const settings = this.timerSettings(channel, id)
		// Nothing describes it and nothing has run it: no such timer here.
		if (!state && settings === UNKNOWN_TIMER) return undefined
		const now = Date.now() + clocks.offset
		const ms = timerMs(settings, state, now)
		const finished = timerFinished(settings, state, now)
		return {
			id,
			text: timerText(settings, state, now),
			seconds: settings.mode === 'countdown' ? Math.ceil(ms / 1000) : Math.floor(ms / 1000),
			running: timerRunning(settings, state) && !(finished && (settings.end ?? 'stop') === 'stop'),
			finished,
		}
	}

	/** A timer for a feedback: claims the channel, then reads the clocks it has. */
	timerView(ownerId: string, rawChannel: string | undefined, rawId: string | undefined): TimerView | undefined {
		const key = this.trackClocks(ownerId, rawChannel)
		return key ? this.viewTimer(key, rawId) : undefined
	}

	/** Roll ids a channel shows. */
	rollIds(channel: string, key?: string): string[] {
		const ids: string[] = []
		const comps = channel.startsWith('@')
			? this.outputCompositions(channel.slice(1)).map((c) => this.compositions.get(c))
			: [this.compositionFor(channel)]
		for (const comp of comps) for (const roll of comp?.rolls ?? []) if (!ids.includes(roll.id)) ids.push(roll.id)
		for (const item of (key ? this.clocks.get(key)?.scrolls?.items : undefined) ?? []) {
			if (!ids.includes(item.id)) ids.push(item.id)
		}
		return ids
	}

	private viewRoll(key: string, rawId: string | undefined): RollView | undefined {
		const clocks = this.clocks.get(key)
		const { channel } = splitKey(key)
		const id = (rawId ?? '').trim() || this.rollIds(channel, key)[0]
		if (!id || !clocks) return undefined
		const item = clocks.scrolls?.items.find((i) => i.id === id)
		if (!item && !this.rollIds(channel).includes(id)) return undefined
		const state: ScrollState = item?.state ?? { running: false, anchor: 0, base: 0, rate: 1 }
		const info: ScrollInfo | undefined = item?.info
		const now = Date.now() + clocks.offset
		const atEnd = scrollAtEnd(state, info, now)
		return {
			id,
			percent: scrollPercent(state, info, now),
			running: state.running && !atEnd,
			reversed: state.rate < 0,
			atEnd,
			speed: speedText(state.rate),
			remaining: scrollRemaining(state, info, now),
		}
	}

	/** A roll for a feedback. */
	rollView(ownerId: string, rawChannel: string | undefined, rawId: string | undefined): RollView | undefined {
		const key = this.trackClocks(ownerId, rawChannel)
		return key ? this.viewRoll(key, rawId) : undefined
	}

	/**
	 * Re-check the clock feedbacks when what they show has changed, and keep a
	 * ticker going while anything shown is running. The ticker writes nothing
	 * between changes: a 0:42 that is still 0:42 sends no update.
	 */
	private onClocksChanged(force = false): void {
		if (this.destroyed) return
		let tick = 0
		const parts: unknown[] = []
		for (const [key, clocks] of this.clocks) {
			const { channel } = splitKey(key)
			for (const id of this.timerIds(channel, key)) {
				const view = this.viewTimer(key, id)
				if (!view) continue
				parts.push([key, 't', id, view.text, view.running, view.finished])
				if (view.running) {
					const every = timerTickMs(this.timerSettings(channel, id))
					tick = tick === 0 ? every : Math.min(tick, every)
				}
			}
			for (const item of clocks.scrolls?.items ?? []) {
				const view = this.viewRoll(key, item.id)
				if (!view) continue
				const left = view.remaining === null ? null : Math.ceil(view.remaining)
				parts.push([key, 'r', item.id, view.percent, view.running, view.reversed, view.atEnd, view.speed, left])
				if (view.running) tick = tick === 0 ? 250 : Math.min(tick, 250)
			}
		}
		const playheads = new Set<string>()
		for (const owner of this.playheadOwners) {
			const key = this.owners.get(owner)
			if (key) playheads.add(key)
		}
		for (const key of playheads) {
			const view = this.viewPlayhead(key)
			if (!view) continue
			parts.push([key, 'p', view.state, view.time.toFixed(1), view.step, view.stepCount, view.percent])
			if (view.state === 'playing-in' || view.state === 'playing-out') tick = tick === 0 ? 100 : Math.min(tick, 100)
		}
		const signature = JSON.stringify(parts)
		if (force || signature !== this.clockSignature) {
			this.clockSignature = signature
			this.checkFeedbacks(...CLOCK_FEEDBACKS)
			this.publishTimerVariables()
		}

		if (tick === 0) {
			if (this.clockTicker) clearInterval(this.clockTicker)
			this.clockTicker = undefined
		} else if (!this.clockTicker) {
			this.clockTicker = setInterval(() => this.onClocksChanged(), tick)
		}
	}

	/** Timer variables follow the default channel's first timer — `main`, if it has one. */
	private publishTimerVariables(): void {
		const key = this.defaultKey()
		const ids = key ? this.timerIds(splitKey(key).channel, key) : []
		const id = ids.includes('main') ? 'main' : ids[0]
		const view = key && id ? this.viewTimer(key, id) : undefined
		const values = view
			? {
					timer: view.id,
					timer_remaining: view.text,
					timer_seconds: String(view.seconds),
					timer_running: view.running ? 'true' : 'false',
				}
			: EMPTY_TIMER_VARIABLES
		const shown = JSON.stringify(values)
		if (shown === this.timerShown) return
		this.timerShown = shown
		this.setVariableValues(values)
	}

	/* -------------------------------------------------------- playhead */

	/**
	 * A graphic's playhead as the output's debug overlay shows it: state,
	 * time into the composition, step. Outputs report on change, not every
	 * frame, so while it plays the time is carried forward from the report by
	 * the hub's clock and stopped where the runtime would stop: the next STOP
	 * marker playing in, the end playing out.
	 */
	private viewPlayhead(key: string): PlayheadView | undefined {
		const state = this.states.get(key)
		if (!state) return undefined
		const { channel } = splitKey(key)
		const comp = this.compositionFor(channel)
		const duration = comp?.duration ?? null
		const p = state.playback
		if (!p) return { state: 'idle', time: 0, duration, step: 0, stepCount: 0, percent: 0 }
		let time = p.time
		if ((p.state === 'playing-in' || p.state === 'playing-out') && state.reportedAt !== null && state.now !== null) {
			const since = (state.now - state.reportedAt + Date.now() - (this.receivedAt.get(key) ?? Date.now())) / 1000
			const stop = p.state === 'playing-in' ? comp?.stops.find((s) => s > p.time + 0.001) : undefined
			time = Math.min(time + Math.max(0, since), stop ?? duration ?? Infinity)
		}
		const percent = duration ? Math.max(0, Math.min(100, Math.round((time / duration) * 100))) : 0
		return { state: p.state, time, duration, step: p.step, stepCount: p.stepCount, percent }
	}

	/** A graphic's playhead for a feedback: claims the channel, and keeps it ticking while it plays. */
	playheadView(ownerId: string, rawChannel: string | undefined): PlayheadView | undefined {
		const target = this.track(ownerId, rawChannel)
		if (!target) return undefined
		this.playheadOwners.add(ownerId)
		return this.viewPlayhead(`${target.project}/${target.channel}`)
	}

	/* ------------------------------------------- 0.79: game and poll rows */

	/** Claim a source's rows for a feedback, and return them as last read. */
	rowsFor(ownerId: string, rawSource: string | undefined): Array<Record<string, unknown>> | undefined {
		const source = (rawSource ?? '').trim()
		if (!source) {
			this.rowOwners.delete(ownerId)
			return undefined
		}
		const previous = this.rowOwners.get(ownerId)
		this.rowOwners.set(ownerId, source)
		if (previous !== source && !this.rows.has(source)) void this.pollRows()
		return this.rows.get(source)
	}

	/** Rows a press just answered with — buttons read them now, not after the next read. */
	noteRows(source: string, rows: Array<Record<string, unknown>>): void {
		this.rows.set(source, rows)
		this.onRowsChanged()
	}

	private startRows(): void {
		this.stopRows()
		if (this.supports('game') === false && this.supports('polls') === false) return
		const interval = Math.max(1000, this.config.pollInterval ?? 1000)
		this.rowsTimer = setInterval(() => void this.pollRows(), interval)
	}

	private stopRows(): void {
		if (this.rowsTimer) clearInterval(this.rowsTimer)
		this.rowsTimer = undefined
	}

	/**
	 * Read the rows of every source a button shows, plus the first game table
	 * (for the score variables). A game table's state is one row and a poll has
	 * at most twelve, so this stays small; nothing else is read.
	 */
	private async pollRows(): Promise<void> {
		if (this.destroyed || this.rowsInflight) return
		if (this.supports('game') === false && this.supports('polls') === false) return
		const project = this.config.project?.trim() ?? ''
		if (!project) return
		const wanted = new Set(this.rowOwners.values())
		const firstGame = this.gameSources()[0]?.def.id
		if (firstGame) wanted.add(firstGame)
		for (const id of [...this.rows.keys()]) if (!wanted.has(id)) this.rows.delete(id)
		if (wanted.size === 0) return
		const generation = this.generation
		this.rowsInflight = true
		try {
			for (const source of wanted) {
				try {
					const rows = await this.api.sourceRows(project, source, ROWS_READ)
					if (!this.isCurrent(generation)) return
					this.rows.set(source, rows)
				} catch {
					// A deleted source, or the server: the poll and watchdog report that.
				}
			}
			this.onRowsChanged()
		} finally {
			this.rowsInflight = false
		}
	}

	private onRowsChanged(): void {
		if (this.destroyed) return
		const signature = JSON.stringify([...this.rows])
		if (signature === this.rowsSignature) return
		this.rowsSignature = signature
		this.checkFeedbacks(...ROW_FEEDBACKS)
		const row = this.rows.get(this.gameSources()[0]?.def.id ?? '')?.[0]
		const values = row
			? {
					home_score: cellText(row['homeScore']),
					away_score: cellText(row['awayScore']),
					period_label: cellText(row['periodLabel']),
				}
			: EMPTY_GAME_VARIABLES
		const shown = JSON.stringify(values)
		if (shown === this.gameShown) return
		this.gameShown = shown
		this.setVariableValues(values)
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
		this.clockOwners.delete(ownerId)
		this.playheadOwners.delete(ownerId)
		this.rowOwners.delete(ownerId)
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
		this.clocks.delete(key)
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
				// Held until a command succeeds: a poll or a socket message must
				// not paint a connection green whose every command is refused.
				this.keyProblem = this.secrets.apiKey ? 'API key rejected' : 'This server needs an API key'
				this.setStatus(InstanceStatus.AuthenticationFailure, this.keyProblem)
				this.log('error', `${what}: ${message} — check the API key against BREEZE_API_KEY`)
				return
			}
			if (error.status === 429) {
				// Breeze's limit on wrong keys: five a minute from one address.
				this.keyProblem = 'Too many wrong API keys — Breeze is refusing this machine for up to a minute'
				this.setStatus(InstanceStatus.AuthenticationFailure, this.keyProblem)
				this.log(
					'error',
					`${what}: refused — five wrong API keys from this machine within a minute. Fix the key; Breeze accepts this machine again once the minute is up`,
				)
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
				this.setStatus(InstanceStatus.ConnectionFailure, `Cannot reach ${this.api.base}`)
				this.log('error', `${what}: ${message}`)
				return
			}
		}

		this.setStatus(InstanceStatus.UnknownError, message)
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

/** Rundown variables with no rundown to follow. */
const EMPTY_RUNDOWN_VARIABLES = {
	rundown: '',
	cued_item: '',
	cued_composition: '',
	cued_position: '',
	on_air_item: '',
} as const

/** Timer variables with no timer on the default channel. */
const EMPTY_TIMER_VARIABLES = {
	timer: '',
	timer_remaining: '',
	timer_seconds: '',
	timer_running: '',
} as const

/** Game variables with no game table in the project. */
const EMPTY_GAME_VARIABLES = {
	home_score: '',
	away_score: '',
	period_label: '',
} as const

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Split a `project/channel` key. Project keys cannot contain `/`, so the first one is the seam. */
function splitKey(key: string): Target {
	const at = key.indexOf('/')
	return { project: key.slice(0, at), channel: key.slice(at + 1) }
}

/**
 * What a button or variable can show from a channel state — the comparison
 * that decides whether a new state is worth a feedback pass. Leaves out the
 * playhead time and the report timestamps, which move on every report without
 * anything visible changing.
 */
function shownOf(state: ChannelState): string {
	const p = state.playback
	return JSON.stringify([
		p ? [p.state, p.step, p.stepCount, p.tables ?? null] : null,
		state.renderers,
		state.controllers,
	])
}
