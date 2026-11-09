// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Checking what the server sends before anything uses it.
 *
 * Every state, from the hub socket or the poll, passes through here once, so
 * nothing downstream has to wonder whether `renderers` is a number. A field of
 * the wrong type is dropped or given a neutral value rather than carried into a
 * variable as `NaN`, `"undefined"` or `"two"`; a state missing the counts every
 * feedback relies on is refused as a whole, so the channel reads as unknown
 * rather than wrong.
 */

import type {
	ChannelRef,
	ChannelState,
	PlaybackReport,
	ProjectChannels,
	ScrollsPayload,
	SourceSummary,
	TableReport,
	TimersPayload,
} from './api.js'
import type { ScrollInfo, ScrollState, TimerState } from './clocks.js'

type Loose = Record<string, unknown>

const isRecord = (value: unknown): value is Loose =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number | null =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** One paged table from a report, or null when it cannot be read as one. */
function toTable(raw: unknown): TableReport | null {
	if (!isRecord(raw) || typeof raw.table !== 'string' || raw.table === '') return null
	const page = count(raw.page)
	const pageCount = count(raw.pageCount)
	if (page === null || pageCount === null || pageCount < 1) return null
	return {
		table: raw.table,
		page,
		pageCount,
		key: typeof raw.key === 'string' ? raw.key : null,
		hasCycle: raw.hasCycle === true,
		cycling: raw.cycling === true,
		held: raw.held === true,
		secondsLeft: finite(raw.secondsLeft),
		...(typeof raw.group === 'string' && raw.group !== '' ? { group: raw.group } : {}),
	}
}

function toPlayback(raw: unknown): PlaybackReport | null {
	if (!isRecord(raw) || typeof raw.state !== 'string') return null
	const playback: PlaybackReport = {
		state: raw.state,
		time: finite(raw.time) ?? 0,
		step: count(raw.step) ?? 0,
		stepCount: count(raw.stepCount) ?? 0,
	}
	// Absent from servers older than 0.74 — kept absent rather than invented.
	if (Array.isArray(raw.tables)) {
		playback.tables = raw.tables.map(toTable).filter((t): t is TableReport => t !== null)
	}
	return playback
}

/**
 * A channel state the rest of the module can trust, or null.
 *
 * Null when the counts are missing or not numbers: `renderers` drives the
 * "No browser source attached" warning, and guessing 0 would raise a false one.
 */
export function toChannelState(raw: unknown): ChannelState | null {
	if (!isRecord(raw)) return null
	const renderers = count(raw.renderers)
	const controllers = count(raw.controllers)
	if (renderers === null || controllers === null) return null
	return {
		data: isRecord(raw.data) ? raw.data : {},
		playback: toPlayback(raw.playback),
		renderers,
		controllers,
		updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
		reportedAt: finite(raw.reportedAt),
		now: finite(raw.now),
	}
}

/** One channel from `/api/channels`; null when it has no usable address. `tables` is checked where it is read (`listedTables`). */
function toChannel(raw: unknown): ChannelRef | null {
	if (!isRecord(raw) || typeof raw.channel !== 'string' || raw.channel === '') return null
	return {
		channel: raw.channel,
		ref: typeof raw.ref === 'string' ? raw.ref : raw.channel,
		name: typeof raw.name === 'string' ? raw.name : '',
		sceneId: typeof raw.sceneId === 'string' ? raw.sceneId : null,
		layerId: typeof raw.layerId === 'string' ? raw.layerId : null,
		...(Array.isArray(raw.tables) ? { tables: raw.tables as ChannelRef['tables'] } : {}),
	}
}

/** A channel list, keeping the entries that can be addressed. */
export function toChannels(raw: unknown): ChannelRef[] {
	return Array.isArray(raw) ? raw.map(toChannel).filter((c): c is ChannelRef => c !== null) : []
}

/** `/api/channels`: every project with an id, each with its addressable channels. */
export function toProjectChannels(raw: unknown): ProjectChannels[] {
	if (!Array.isArray(raw)) return []
	return raw
		.filter((p): p is Loose => isRecord(p) && typeof p.id === 'string' && p.id !== '')
		.map((p) => ({
			id: p.id as string,
			name: typeof p.name === 'string' ? p.name : '',
			channels: toChannels(p.channels),
		}))
}

/** A data source from `/datasources`, or null without an id to address it by. */
function toSource(raw: unknown): SourceSummary | null {
	if (!isRecord(raw) || !isRecord(raw.def) || typeof raw.def.id !== 'string' || raw.def.id === '') return null
	const def = raw.def
	const status = isRecord(raw.status) ? raw.status : {}
	const media = isRecord(status.media) ? status.media : undefined
	return {
		def: {
			id: def.id as string,
			name: typeof def.name === 'string' && def.name !== '' ? def.name : (def.id as string),
			type: typeof def.type === 'string' ? def.type : '',
			...(typeof def.fallback === 'string' ? { fallback: def.fallback } : {}),
			...(isRecord(def.media) && typeof def.media.column === 'string' ? { media: { column: def.media.column } } : {}),
			...(isRecord(def.template) &&
			typeof def.template.sport === 'string' &&
			typeof def.template.ruleset === 'string' &&
			typeof def.template.table === 'string'
				? { template: { sport: def.template.sport, ruleset: def.template.ruleset, table: def.template.table } }
				: {}),
			...(typeof def.question === 'string' ? { question: def.question } : {}),
			...(Array.isArray(def.options)
				? {
						options: def.options
							.filter((o): o is Loose => isRecord(o) && typeof o.id === 'string' && o.id !== '')
							.map((o) => ({
								id: o.id as string,
								label: typeof o.label === 'string' && o.label ? o.label : (o.id as string),
							})),
					}
				: {}),
			...(typeof def.url === 'string' && def.url !== '' ? { url: def.url } : {}),
		},
		status: {
			...(media
				? {
						media: {
							ok: count(media.ok) ?? 0,
							failed: count(media.failed) ?? 0,
							frozen: count(media.frozen) ?? 0,
							unchecked: count(media.unchecked) ?? 0,
							...(typeof media.checkedAt === 'string' ? { checkedAt: media.checkedAt } : {}),
						},
					}
				: {}),
			...(count(status.failures) !== null ? { failures: count(status.failures)! } : {}),
			...(typeof status.lastSuccess === 'string' ? { lastSuccess: status.lastSuccess } : {}),
			...(typeof status.lastError === 'string' ? { lastError: status.lastError } : {}),
			...(status.expired === true ? { expired: true } : {}),
			...(status.stuck === true ? { stuck: true } : {}),
			...(typeof status.serving === 'string' ? { serving: status.serving } : {}),
			...(status.use === 'primary' || status.use === 'backup' ? { use: status.use } : {}),
		},
	}
}

export function toSources(raw: unknown): SourceSummary[] {
	return Array.isArray(raw) ? raw.map(toSource).filter((s): s is SourceSummary => s !== null) : []
}

/** The project mode and the modes its rules name. */
export function toMode(raw: unknown): { mode: string; modes: string[] } {
	if (!isRecord(raw)) return { mode: '', modes: [] }
	return {
		mode: typeof raw.mode === 'string' ? raw.mode : '',
		modes: Array.isArray(raw.modes) ? raw.modes.filter((m): m is string => typeof m === 'string') : [],
	}
}

export { isRecord }

/** One timer's state, or null. Times must be numbers: a `NaN` here would print as one on a button. */
function toTimerState(raw: unknown): TimerState | null {
	if (!isRecord(raw)) return null
	const anchor = finite(raw.anchor)
	const elapsed = finite(raw.elapsed)
	if (anchor === null || elapsed === null) return null
	const base = finite(raw.base)
	return {
		running: raw.running === true,
		anchor,
		elapsed,
		...(base !== null ? { base } : {}),
		adjust: finite(raw.adjust) ?? 0,
	}
}

/** `/state`'s `timers` (Breeze 0.79+), or null when the channel has none. */
export function toTimers(raw: unknown): TimersPayload | null {
	if (!isRecord(raw) || !isRecord(raw.timers)) return null
	const clock = finite(raw.clock)
	if (clock === null) return null
	const timers: Record<string, TimerState> = {}
	for (const [id, state] of Object.entries(raw.timers)) {
		const timer = toTimerState(state)
		if (timer) timers[id] = timer
	}
	return { clock, timers }
}

function toScrollState(raw: unknown): ScrollState | null {
	if (!isRecord(raw)) return null
	const anchor = finite(raw.anchor)
	const base = finite(raw.base)
	const rate = finite(raw.rate)
	if (anchor === null || base === null || rate === null) return null
	return { running: raw.running === true, anchor, base, rate }
}

function toScrollInfo(raw: unknown): ScrollInfo | undefined {
	if (!isRecord(raw)) return undefined
	const extent = finite(raw.extent)
	return {
		...(extent !== null && extent > 0 ? { extent } : {}),
		...(typeof raw.end === 'string' ? { end: raw.end } : {}),
		...(typeof raw.start === 'string' ? { start: raw.start } : {}),
	}
}

/** `/state`'s `scrolls` (Breeze 0.79+), or null when the channel has no rolls. */
export function toScrolls(raw: unknown): ScrollsPayload | null {
	if (!isRecord(raw) || !Array.isArray(raw.items)) return null
	const clock = finite(raw.clock)
	if (clock === null) return null
	const items: ScrollsPayload['items'] = []
	for (const item of raw.items) {
		if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') continue
		const state = toScrollState(item.state)
		if (!state) continue
		const info = toScrollInfo(item.info)
		items.push({ id: item.id, state, ...(info ? { info } : {}) })
	}
	return { clock, items }
}
