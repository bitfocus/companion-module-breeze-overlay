// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * The Breeze HTTP control API, as this module uses it.
 *
 * Everything here is a plain `fetch`. Breeze accepts GET for every verb —
 * deliberately, so header-less control surfaces can drive it — but this module
 * uses POST for the side-effecting ones and sends the key as a header. A key in
 * a query string ends up in the activity log and in any proxy log, and Companion
 * has no trouble setting a header.
 *
 * The same rule holds for the table verbs added in Breeze 0.74: their options
 * (`table`, `n`, `name`, `state`) go in the JSON body, which the server reads
 * exactly as it reads the query string, so nothing but the path is in the URL.
 */

/** Shape of a verb response. `delivered` is the number of browser sources reached. */

import type { ScrollInfo, ScrollState, TimerState } from './clocks.js'
import {
	isRecord,
	toChannels,
	toChannelState,
	toMode,
	toProjectChannels,
	toScrolls,
	toSources,
	toTimers,
} from './validate.js'

export interface VerbResult {
	ok: boolean
	verb: string
	channel: string
	delivered: number
}

/**
 * One paged table, as the output page reported it (Breeze 0.74+).
 *
 * `table` is the address the table answers to — the name to put in an action's
 * Table field.
 */
export interface TableReport {
	table: string
	/** Counted from 0, as Breeze reports it. Use `pageNumber()` for the 1-based page an operator reads. */
	page: number
	pageCount: number
	/** The page's key — the value of the table's key column on that page — or null. */
	key: string | null
	/** A cycle is configured at all, whether or not it is running. */
	hasCycle: boolean
	cycling: boolean
	held: boolean
	/** Seconds to the next turn when the report was made; null when not cycling. */
	secondsLeft: number | null
	group?: string
}

export interface PlaybackReport {
	state: string
	time: number
	step: number
	stepCount: number
	/** Absent from servers and output pages older than 0.74. */
	tables?: TableReport[]
}

export interface ChannelState {
	data: Record<string, unknown>
	playback: PlaybackReport | null
	/** Browser sources attached — vMix/OBS inputs and debug tabs. */
	renderers: number
	/** Control panels and editors. */
	controllers: number
	updatedAt: string
	/** Hub clock, epoch ms, when `playback` was reported; null when never (0.74.1+). */
	reportedAt: number | null
	/** Hub clock, epoch ms, when this state was put together (0.74.1+). */
	now: number | null
}

/** A channel's operator timers (Breeze 0.79+), stamped with the hub's clock. */
export interface TimersPayload {
	/** Hub clock, epoch ms, when the server answered. */
	clock: number
	timers: Record<string, TimerState>
}

/** A channel's rolls (Breeze 0.79+): each one's transport and what the outputs said about it. */
export interface ScrollsPayload {
	clock: number
	items: Array<{ id: string; state: ScrollState; info?: ScrollInfo }>
}

/**
 * What `/state` carries beside the channel state (Breeze 0.79+). Timers and
 * rolls ride there so a lean reader still gets them; the socket leaves them
 * out with the field data.
 */
export interface ChannelExtras {
	timers: TimersPayload | null
	scrolls: ScrollsPayload | null
}

/** A table a graphic was built to page, as `/api/channels` lists it (Breeze 0.77+). */
export interface PagedTableRef {
	/** The address NEXT, PREV and Go to page take, and a live report's `table`. */
	table: string
	/** The table layer's name. */
	name: string
	/** A cycle is set, so Cycle hold/resume means something for it. */
	cycle: boolean
}

/** One addressable thing in a project: a scene, or a scene's independent element. */
export interface ChannelRef {
	channel: string
	ref: string
	/** What to call it on a button — the composition's or element's own name. */
	name: string
	sceneId: string | null
	layerId: string | null
	/** Tables built to page. Absent from servers older than 0.77; read it through `listedTables()`. */
	tables?: PagedTableRef[]
}

export interface ProjectChannels {
	id: string
	name: string
	channels: ChannelRef[]
}

export interface ProjectSummary {
	id: string
	name: string
	compositions: Array<{ id: string; name: string }>
}

/** One data source and its health, from `/api/projects/:id/datasources` (Breeze 0.74+ for the backup fields). */
export interface SourceSummary {
	def: {
		id: string
		name: string
		type: string
		fallback?: string
		media?: { column: string }
		/** A source made from a sport template (Breeze 0.79+). */
		template?: { sport: string; ruleset: string; table: string }
		/** A poll's question and options (Breeze 0.79+). */
		question?: string
		options?: Array<{ id: string; label: string }>
		/** A URL, for a text source: one with none is held in the project. */
		url?: string
	}
	status: {
		/** A camera list's checks, when the source has them (0.74+, CYCLE.md Wave 8). */
		media?: { ok: number; failed: number; frozen: number; unchecked: number; checkedAt?: string }
		failures?: number
		lastSuccess?: string
		lastError?: string
		expired?: boolean
		stuck?: boolean
		/** Id of the source whose rows are on air instead — the backup is serving. */
		serving?: string
		/** An operator's override, when one is set. */
		use?: 'primary' | 'backup'
	}
}

/** Whose rows a source serves. */
export type SourceUse = 'auto' | 'primary' | 'backup'

/** Where Go to page lands: a 1-based number, or a page key. Exactly one. */
export type PageTarget = { n: number } | { name: string }

export class BreezeError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'BreezeError'
	}
}

export interface BreezeConfig {
	host: string
	port: number
	apiKey: string
}

export class BreezeApi {
	constructor(private readonly config: BreezeConfig) {}

	get base(): string {
		// No scheme in the config field: Breeze is served over plain HTTP on a
		// LAN, and offering a choice invites someone to pick https on a server
		// that has no certificate and then debug the wrong thing.
		return `http://${this.config.host}:${this.config.port}`
	}

	/**
	 * The control hub socket.
	 *
	 * Carries no key, and needs none: the server gates `/api/*`, not the hub,
	 * and a subscription only ever reads. Commands still go over HTTP with the
	 * key in a header, so the socket never becomes a way round it.
	 */
	get socketUrl(): string {
		return `ws://${this.config.host}:${this.config.port}/ws/control`
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json' }
		if (this.config.apiKey) headers['x-breeze-key'] = this.config.apiKey
		if (init?.body) headers['content-type'] = 'application/json'

		let response: Response
		try {
			response = await fetch(`${this.base}${path}`, {
				...init,
				headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
				// A control surface that hangs is worse than one that reports a
				// failure: the operator presses again, and again. The caller's
				// signal as well, when it gives one: Companion aborts an action
				// it no longer needs — a cancelled press, a connection being
				// removed — and the wait should end with it. (A command that
				// already reached the server has still been carried out.)
				signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
			})
		} catch (error) {
			throw new BreezeError(error instanceof Error ? error.message : String(error), 0)
		}

		if (!response.ok) {
			let detail = response.statusText
			try {
				const body = (await response.json()) as { error?: string }
				if (body.error) detail = body.error
			} catch {
				// Non-JSON error body; the status line is all we have.
			}
			throw new BreezeError(detail, response.status)
		}

		return (await response.json()) as T
	}

	private controlPath(project: string, channel: string, verb: string): string {
		return `/api/control/${encodeURIComponent(project)}/${encodeURIComponent(channel)}/${verb}`
	}

	/**
	 * `play` | `next` | `prev` | `stop` | `clear` | `clear-all`.
	 *
	 * `table` aims NEXT or PREV at one table's pages (0.74+). Sent only when
	 * given, so a plain NEXT is byte-for-byte the request older servers expect.
	 */
	async verb(
		project: string,
		channel: string,
		verb: string,
		table?: string,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, verb), {
			method: 'POST',
			...(table ? { body: JSON.stringify({ table }) } : {}),
			signal,
		})
	}

	/** Go to a page (0.74+). */
	async page(
		project: string,
		channel: string,
		target: PageTarget,
		table?: string,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'page'), {
			method: 'POST',
			body: JSON.stringify({ ...target, ...(table ? { table } : {}) }),
			signal,
		})
	}

	/** Freeze or restart self-paging tables (0.74+). */
	async cycle(
		project: string,
		channel: string,
		state: 'hold' | 'resume',
		table?: string,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'cycle'), {
			method: 'POST',
			body: JSON.stringify({ state, ...(table ? { table } : {}) }),
			signal,
		})
	}

	/**
	 * Push dynamic field values.
	 *
	 * POSTed as a JSON body rather than a query string, so a value containing an
	 * ampersand or a newline arrives intact — a lower third carrying a quote from
	 * a press release will eventually contain both.
	 */
	async update(
		project: string,
		channel: string,
		fields: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'update'), {
			method: 'POST',
			body: JSON.stringify(fields),
			signal,
		})
	}

	/**
	 * Read-only, safe to poll.
	 *
	 * `?data=0` leaves out the channel's retained field data, which on a
	 * data-driven graphic carries every source's whole DataSet — nothing a
	 * button colour needs, once a second per watched channel. Servers older than
	 * 0.74 ignore the parameter and answer as they always did.
	 */
	async state(project: string, channel: string): Promise<ChannelState> {
		return (await this.stateWithExtras(project, channel)).state
	}

	/**
	 * `state`, plus the timers and rolls `/state` carries beside it (0.79+).
	 * The same request — older servers simply have neither.
	 *
	 * Works for an output's routing channel too (`@main`): the state route
	 * reads the hub by name and does not insist on a composition.
	 */
	async stateWithExtras(project: string, channel: string): Promise<{ state: ChannelState; extras: ChannelExtras }> {
		const body = await this.request<unknown>(`${this.controlPath(project, channel, 'state')}?data=0`)
		const state = toChannelState(isRecord(body) ? body.state : undefined)
		// Answered, but not with a Breeze channel state — not a dead server, so not
		// status 0, and not something to colour buttons from either.
		if (!state) throw new BreezeError(`unexpected state for "${channel}" — is this a Breeze server?`, 502)
		return {
			state,
			extras: {
				timers: toTimers(isRecord(body) ? body.timers : undefined),
				scrolls: toScrolls(isRecord(body) ? body.scrolls : undefined),
			},
		}
	}

	/**
	 * A channel's retained field values, read when a press needs the value on
	 * air now — a toggle, a +1 — and not otherwise: the full state carries
	 * every source's rows too.
	 */
	async fieldValues(project: string, channel: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const body = await this.request<unknown>(this.controlPath(project, channel, 'state'), { signal })
		const state = isRecord(body) && isRecord(body.state) ? body.state : undefined
		return state && isRecord(state.data) ? state.data : {}
	}

	/* ------------------------------------------------- 0.79: project reads */

	/** The project document: compositions, layers, typed fields. Read at connect only. */
	async project(project: string): Promise<unknown> {
		return this.request<unknown>(`/api/projects/${encodeURIComponent(project)}`)
	}

	/** `rundowns.json` (0.79+). */
	async rundowns(project: string): Promise<unknown> {
		return this.request<unknown>(`/api/projects/${encodeURIComponent(project)}/rundowns`)
	}

	/** One rundown's armed item and what each target shows (0.79+) — the fallback when the socket is down. */
	async rundownState(project: string, rundown: string): Promise<unknown> {
		return this.request<unknown>(`/api/rundown/${encodeURIComponent(project)}/${encodeURIComponent(rundown)}/state`)
	}

	/** The sports catalogue (0.79+): each sport's scoring buttons. */
	async sports(): Promise<unknown> {
		return this.request<unknown>('/api/sports')
	}

	/** One source with its first `rows` rows (0.79+ for game and poll rows). */
	async sourceRows(project: string, source: string, rows: number): Promise<Array<Record<string, unknown>>> {
		const body = await this.request<unknown>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}?rows=${rows}`,
		)
		const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
		return Array.isArray(data?.rows) ? data.rows.filter(isRecord) : []
	}

	/* ------------------------------------------------ 0.79: control verbs */

	/**
	 * A rundown verb (0.79+): `cue`, `next`, `prev`, `take` or `out`. Options
	 * (`item`, `advance`, `target`) go in the body. The answer carries the
	 * armed item, and for TAKE how many outputs it reached.
	 */
	async rundownVerb(
		project: string,
		rundown: string,
		verb: 'cue' | 'next' | 'prev' | 'take' | 'out',
		options: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ armed: string | null | undefined; delivered: number | undefined }> {
		const body = await this.request<unknown>(
			`/api/rundown/${encodeURIComponent(project)}/${encodeURIComponent(rundown)}/${verb}`,
			{ method: 'POST', body: JSON.stringify(options), signal },
		)
		const armed = isRecord(body) ? body.armed : undefined
		const delivered = isRecord(body) ? body.delivered : undefined
		return {
			armed: typeof armed === 'string' || armed === null ? armed : undefined,
			delivered: typeof delivered === 'number' ? delivered : undefined,
		}
	}

	/** An output's own verb (0.79+): `stop`, `next`, `prev` or `clear`, at one mount or all. */
	async outputVerb(
		project: string,
		output: string,
		verb: 'stop' | 'next' | 'prev' | 'clear',
		mount: string | undefined,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(`/api/out/${encodeURIComponent(project)}/${encodeURIComponent(output)}/${verb}`, {
			method: 'POST',
			...(mount ? { body: JSON.stringify({ mount }) } : {}),
			signal,
		})
	}

	/**
	 * The path for a channel's timer or roll verb: an output's (`@main`) or a
	 * graphic's. The two share their arguments; only the route differs.
	 */
	private clockPath(project: string, channel: string, verb: 'timer' | 'scroll'): string {
		if (channel.startsWith('@')) {
			return `/api/out/${encodeURIComponent(project)}/${encodeURIComponent(channel.slice(1))}/${verb}`
		}
		return this.controlPath(project, channel, verb)
	}

	/**
	 * An operator timer (0.79+): `action` start | pause | toggle | reset | set | add,
	 * `value` as an operator types it (`8:00`, `-10`).
	 */
	async timer(
		project: string,
		channel: string,
		action: string,
		id: string,
		value: string | undefined,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.clockPath(project, channel, 'timer'), {
			method: 'POST',
			body: JSON.stringify({ action, id, ...(value !== undefined ? { value } : {}) }),
			signal,
		})
	}

	/** The roll transport (0.79+). `value` for speed (`1.5`), jog (`-3`) and seek (`1:30`, `50%`). */
	async scroll(
		project: string,
		channel: string,
		action: string,
		id: string,
		value: string | undefined,
		signal?: AbortSignal,
	): Promise<VerbResult> {
		return this.request<VerbResult>(this.clockPath(project, channel, 'scroll'), {
			method: 'POST',
			body: JSON.stringify({ action, id, ...(value !== undefined ? { value } : {}) }),
			signal,
		})
	}

	/** A tap on a sport game table (0.79+). Answers with the new game row. */
	async game(
		project: string,
		source: string,
		action: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown> | null> {
		const body = await this.request<unknown>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/game`,
			{ method: 'POST', body: JSON.stringify(action), signal },
		)
		return isRecord(body) && isRecord(body.row) ? body.row : null
	}

	/** A poll tally (0.79+): vote, set, open, close or reset. Answers with the poll's rows. */
	async poll(
		project: string,
		source: string,
		action: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Array<Record<string, unknown>> | null> {
		const body = await this.request<unknown>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/poll`,
			{ method: 'POST', body: JSON.stringify(action), signal },
		)
		return isRecord(body) && Array.isArray(body.rows) ? body.rows.filter(isRecord) : null
	}

	async projects(): Promise<ProjectSummary[]> {
		const body = await this.request<{ projects: ProjectSummary[] }>('/api/projects')
		return body.projects
	}

	/**
	 * Every address a project answers to, including scene elements.
	 *
	 * The authoritative list — it is the same index the server resolves a trigger
	 * against, so anything absent from it will 404.
	 */
	async channels(project: string): Promise<ChannelRef[]> {
		const body = await this.request<unknown>(`/api/projects/${encodeURIComponent(project)}/channels`)
		return toChannels(isRecord(body) ? body.channels : undefined)
	}

	/**
	 * Every channel on the server, in one request.
	 *
	 * What the presets are built from. One call rather than `/api/projects`
	 * followed by a `/channels` per project — see the route.
	 */
	async allChannels(): Promise<ProjectChannels[]> {
		const body = await this.request<unknown>('/api/channels')
		return toProjectChannels(isRecord(body) ? body.projects : undefined)
	}

	/**
	 * A project's data sources and their health. Read-only; no rows — the
	 * list is polled, and a source's rows are nothing a button needs.
	 */
	async sources(project: string): Promise<SourceSummary[]> {
		const body = await this.request<unknown>(`/api/projects/${encodeURIComponent(project)}/datasources`)
		return toSources(isRecord(body) ? body.sources : undefined)
	}

	/**
	 * Choose whose rows a source serves (0.74+): automatic, its own, or its
	 * backup. POST with the mode in the body, like every other verb here.
	 */
	async useSource(
		project: string,
		source: string,
		mode: SourceUse,
		signal?: AbortSignal,
	): Promise<SourceSummary['status']> {
		const body = await this.request<{ status: SourceSummary['status'] }>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/use`,
			{ method: 'POST', body: JSON.stringify({ mode }), signal },
		)
		return body.status
	}

	/** Check every camera in a source now rather than at its next round (0.74+, Wave 8). */
	async checkMedia(
		project: string,
		source: string,
		signal?: AbortSignal,
	): Promise<SourceSummary['status']['media'] | null> {
		const body = await this.request<{ summary: SourceSummary['status']['media'] | null }>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/media/check`,
			{ method: 'POST', signal },
		)
		return body.summary
	}

	/** The project's mode, and every mode its rules name (0.74+). */
	async mode(project: string): Promise<{ mode: string; modes: string[] }> {
		return toMode(await this.request<unknown>(`/api/projects/${encodeURIComponent(project)}/mode`))
	}

	/** Set the project's mode — every graphic follows (0.74+). '' clears it. */
	async setMode(project: string, value: string, signal?: AbortSignal): Promise<{ mode: string }> {
		return this.request<{ mode: string }>(`/api/projects/${encodeURIComponent(project)}/mode/set`, {
			method: 'POST',
			body: JSON.stringify({ value }),
			signal,
		})
	}

	/** Server-wide health, used to prove the connection and learn the version. */
	/**
	 * Whether the server needs a key (Breeze 0.74+).
	 *
	 * The one auth question that can be asked for free: Breeze leaves this
	 * route out of its key check entirely, so it never counts as a wrong key
	 * against this machine, whatever key is sent with it.
	 */
	async auth(): Promise<{ keyRequired: boolean }> {
		const body = await this.request<unknown>('/api/auth')
		return { keyRequired: isRecord(body) && body.keyRequired === true }
	}

	/**
	 * `/healthz`, checked: the version decides which actions are offered and
	 * whether sockets are used, so an answer without one is not taken as Breeze
	 * — something else is listening on that address and port.
	 */
	async health(): Promise<{ ok: boolean; version: string }> {
		const body = await this.request<unknown>('/healthz')
		if (!isRecord(body) || typeof body.version !== 'string' || body.version === '') {
			throw new BreezeError(`${this.base} answered, but not as Breeze — check the address and port`, 502)
		}
		return { ok: body.ok === true, version: body.version }
	}
}
