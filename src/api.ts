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
	/** 1-based. */
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
}

/** One addressable thing in a project: a scene, or a scene's independent element. */
export interface ChannelRef {
	channel: string
	ref: string
	/** What to call it on a button — the composition's or element's own name. */
	name: string
	sceneId: string | null
	layerId: string | null
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
	def: { id: string; name: string; type: string; fallback?: string; media?: { column: string } }
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
				// failure: the operator presses again, and again.
				signal: AbortSignal.timeout(5000),
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
	async verb(project: string, channel: string, verb: string, table?: string): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, verb), {
			method: 'POST',
			...(table ? { body: JSON.stringify({ table }) } : {}),
		})
	}

	/** Go to a page (0.74+). */
	async page(project: string, channel: string, target: PageTarget, table?: string): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'page'), {
			method: 'POST',
			body: JSON.stringify({ ...target, ...(table ? { table } : {}) }),
		})
	}

	/** Freeze or restart self-paging tables (0.74+). */
	async cycle(project: string, channel: string, state: 'hold' | 'resume', table?: string): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'cycle'), {
			method: 'POST',
			body: JSON.stringify({ state, ...(table ? { table } : {}) }),
		})
	}

	/**
	 * Push dynamic field values.
	 *
	 * POSTed as a JSON body rather than a query string, so a value containing an
	 * ampersand or a newline arrives intact — a lower third carrying a quote from
	 * a press release will eventually contain both.
	 */
	async update(project: string, channel: string, fields: Record<string, string>): Promise<VerbResult> {
		return this.request<VerbResult>(this.controlPath(project, channel, 'update'), {
			method: 'POST',
			body: JSON.stringify(fields),
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
		const body = await this.request<{ channel: string; state: ChannelState }>(
			`${this.controlPath(project, channel, 'state')}?data=0`,
		)
		return body.state
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
		const body = await this.request<{ channels: ChannelRef[] }>(`/api/projects/${encodeURIComponent(project)}/channels`)
		return body.channels
	}

	/**
	 * Every channel on the server, in one request.
	 *
	 * What the presets are built from. One call rather than `/api/projects`
	 * followed by a `/channels` per project — see the route.
	 */
	async allChannels(): Promise<ProjectChannels[]> {
		const body = await this.request<{ projects: ProjectChannels[] }>('/api/channels')
		return body.projects
	}

	/**
	 * A project's data sources and their health. Read-only; no rows — the
	 * list is polled, and a source's rows are nothing a button needs.
	 */
	async sources(project: string): Promise<SourceSummary[]> {
		const body = await this.request<{ sources: SourceSummary[] }>(
			`/api/projects/${encodeURIComponent(project)}/datasources`,
		)
		return body.sources
	}

	/**
	 * Choose whose rows a source serves (0.74+): automatic, its own, or its
	 * backup. POST with the mode in the body, like every other verb here.
	 */
	async useSource(project: string, source: string, mode: SourceUse): Promise<SourceSummary['status']> {
		const body = await this.request<{ status: SourceSummary['status'] }>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/use`,
			{ method: 'POST', body: JSON.stringify({ mode }) },
		)
		return body.status
	}

	/** Check every camera in a source now rather than at its next round (0.74+, Wave 8). */
	async checkMedia(project: string, source: string): Promise<SourceSummary['status']['media'] | null> {
		const body = await this.request<{ summary: SourceSummary['status']['media'] | null }>(
			`/api/projects/${encodeURIComponent(project)}/datasources/${encodeURIComponent(source)}/media/check`,
			{ method: 'POST' },
		)
		return body.summary
	}

	/** The project's mode, and every mode its rules name (0.74+). */
	async mode(project: string): Promise<{ mode: string; modes: string[] }> {
		return this.request<{ mode: string; modes: string[] }>(`/api/projects/${encodeURIComponent(project)}/mode`)
	}

	/** Set the project's mode — every graphic follows (0.74+). '' clears it. */
	async setMode(project: string, value: string): Promise<{ mode: string }> {
		return this.request<{ mode: string }>(`/api/projects/${encodeURIComponent(project)}/mode/set`, {
			method: 'POST',
			body: JSON.stringify({ value }),
		})
	}

	/** Server-wide health, used to prove the connection and learn the version. */
	async health(): Promise<{ ok: boolean; version: string }> {
		return this.request<{ ok: boolean; version: string }>('/healthz')
	}
}
