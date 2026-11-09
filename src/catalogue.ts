// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * What a project holds, read once at connect (Breeze 0.79+): its compositions'
 * timers, rolls and typed fields, its rundowns, and the sports catalogue.
 *
 * None of it is live state. It is what presets are built from, and what a
 * timer button needs to know to show the same text the output shows: whether
 * `main` counts down from 8:00 or up from zero, and in which format. It is
 * re-read when the connection is saved or the server comes back, and the
 * rundowns again whenever Breeze says `rundowns.json` was saved.
 *
 * Kept apart from `main.ts`, like `tables.ts`, so actions, feedbacks and
 * presets can use it without an import cycle through the instance class.
 */

import type { TimerSettings } from './clocks.js'

type Loose = Record<string, unknown>

const isRecord = (value: unknown): value is Loose =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined

/* ------------------------------------------------------------ fields */

export interface FieldOption {
	value: string
	label: string
}

/** A typed field a composition declares (Breeze 0.79 `Composition.fields`). */
export type FieldSpec =
	| { kind: 'number'; label?: string; min?: number; max?: number; step: number; buttons: number[] }
	| { kind: 'boolean'; label?: string; onText?: string; offText?: string }
	| { kind: 'enum'; label?: string; options: FieldOption[] }
	| { kind: 'color'; label?: string }
	| { kind: 'asset'; label?: string }

function toField(raw: unknown): FieldSpec | null {
	if (!isRecord(raw)) return null
	const label = text(raw.label)
	const withLabel = label ? { label } : {}
	switch (raw.kind) {
		case 'number': {
			const min = num(raw.min)
			const max = num(raw.max)
			const step = num(raw.step)
			return {
				kind: 'number',
				...withLabel,
				...(min !== undefined ? { min } : {}),
				...(max !== undefined ? { max } : {}),
				step: step !== undefined && step > 0 ? step : 1,
				buttons: Array.isArray(raw.buttons)
					? raw.buttons.filter((b): b is number => typeof b === 'number' && Number.isFinite(b) && b !== 0)
					: [],
			}
		}
		case 'boolean': {
			const onText = typeof raw.onText === 'string' ? raw.onText : undefined
			const offText = typeof raw.offText === 'string' ? raw.offText : undefined
			return {
				kind: 'boolean',
				...withLabel,
				...(onText !== undefined ? { onText } : {}),
				...(offText !== undefined ? { offText } : {}),
			}
		}
		case 'enum': {
			const options = Array.isArray(raw.options)
				? raw.options
						.filter((o): o is Loose => isRecord(o) && typeof o.value === 'string')
						.map((o) => ({ value: o.value as string, label: text(o.label) ?? (o.value as string) }))
				: []
			return options.length ? { kind: 'enum', ...withLabel, options } : null
		}
		case 'color':
			return { kind: 'color', ...withLabel }
		case 'asset':
			return { kind: 'asset', ...withLabel }
		default:
			return null
	}
}

/* ------------------------------------------------------ compositions */

export interface RollRef {
	id: string
	/** The first roll layer's name, for a preset's title. */
	name: string
}

export interface CompositionInfo {
	id: string
	name: string
	/** Timer ids in the order the layers name them, each with the first layer's settings. */
	timers: Map<string, TimerSettings>
	rolls: RollRef[]
	fields: Map<string, FieldSpec>
	/** Seconds, as authored; null when the document has none. */
	duration: number | null
	/** STOP marker times, ascending — where a playing graphic comes to rest. */
	stops: number[]
}

const TIMER_MODES = new Set(['countdown', 'countup', 'stopwatch'])
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/

function toTimer(raw: unknown): TimerSettings | null {
	if (!isRecord(raw) || typeof raw.mode !== 'string' || !TIMER_MODES.has(raw.mode)) return null
	const settings: TimerSettings = { mode: raw.mode as TimerSettings['mode'] }
	const id = text(raw.id)
	if (id) settings.id = id
	for (const key of ['duration', 'limit', 'tenthsUnder'] as const) {
		const value = num(raw[key])
		if (value !== undefined) settings[key] = value
	}
	for (const key of ['until', 'timezone', 'format', 'tenthsFormat'] as const) {
		const value = text(raw[key])
		if (value !== undefined) settings[key] = value
	}
	if (raw.end === 'stop' || raw.end === 'continue') settings.end = raw.end
	return settings
}

interface LayerLike {
	id?: unknown
	name?: unknown
	type?: unknown
	timer?: unknown
	scrollId?: unknown
	children?: unknown
	ref?: unknown
}

/**
 * Every composition's timers, rolls and fields.
 *
 * Walks groups and mounted compositions the way Breeze's own panel does: a
 * scorebug mounted in a scene runs its clock on the scene's channel, so the
 * scene's buttons need it. The first layer to name an id wins.
 */
export function readCompositions(project: unknown): Map<string, CompositionInfo> {
	const out = new Map<string, CompositionInfo>()
	if (!isRecord(project) || !Array.isArray(project.compositions)) return out
	const raw = new Map<string, Loose>()
	for (const c of project.compositions) {
		if (isRecord(c) && typeof c.id === 'string' && c.id !== '') raw.set(c.id, c)
	}

	for (const [id, comp] of raw) {
		const timers = new Map<string, TimerSettings>()
		const rolls = new Map<string, RollRef>()
		const seen = new Set<string>([id])
		const walk = (layers: unknown): void => {
			if (!Array.isArray(layers)) return
			for (const layer of layers as LayerLike[]) {
				if (!isRecord(layer)) continue
				if (layer.type === 'text' && layer.timer !== undefined) {
					const settings = toTimer(layer.timer)
					const timerId = settings?.id ?? 'main'
					if (settings && ID_PATTERN.test(timerId) && !timers.has(timerId)) timers.set(timerId, settings)
				}
				if (layer.type === 'roll') {
					const rollId = text(layer.scrollId) ?? 'main'
					if (ID_PATTERN.test(rollId) && !rolls.has(rollId)) {
						rolls.set(rollId, { id: rollId, name: text(layer.name) ?? text(layer.id) ?? rollId })
					}
				}
				walk(layer.children)
				const ref = text(layer.ref)
				if (layer.type === 'composition' && ref && !seen.has(ref)) {
					seen.add(ref)
					walk(raw.get(ref)?.layers)
				}
			}
		}
		walk(comp.layers)

		const fields = new Map<string, FieldSpec>()
		if (isRecord(comp.fields)) {
			for (const [name, spec] of Object.entries(comp.fields)) {
				const field = toField(spec)
				if (field && name.trim() !== '') fields.set(name, field)
			}
		}

		const duration = num(comp.duration)
		const stops = Array.isArray(comp.markers)
			? comp.markers
					.filter((m): m is Loose => isRecord(m) && m.type === 'stop' && typeof m.time === 'number')
					.map((m) => m.time as number)
					.sort((a, b) => a - b)
			: []
		out.set(id, {
			id,
			name: text(comp.name) ?? id,
			timers,
			rolls: [...rolls.values()],
			fields,
			duration: duration !== undefined && duration > 0 ? duration : null,
			stops,
		})
	}
	return out
}

/* ---------------------------------------------------------- rundowns */

export interface RundownItem {
	id: string
	composition: string
	label?: string
	data: Record<string, unknown>
	/** Output name, without the `@`. Absent: the composition's own channel. */
	output?: string
}

export interface Rundown {
	id: string
	name: string
	items: RundownItem[]
}

const RUNDOWN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const OUTPUT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/

/** `GET /api/projects/:id/rundowns`, keeping what can be addressed. */
export function readRundowns(raw: unknown): Rundown[] {
	if (!isRecord(raw) || !Array.isArray(raw.rundowns)) return []
	const out: Rundown[] = []
	for (const r of raw.rundowns) {
		if (!isRecord(r) || typeof r.id !== 'string' || !RUNDOWN_ID.test(r.id)) continue
		const items: RundownItem[] = []
		for (const i of Array.isArray(r.items) ? r.items : []) {
			if (!isRecord(i) || typeof i.id !== 'string' || !RUNDOWN_ID.test(i.id)) continue
			if (typeof i.composition !== 'string' || i.composition === '') continue
			const label = text(i.label)
			const output = typeof i.output === 'string' && OUTPUT_NAME.test(i.output) ? i.output : undefined
			items.push({
				id: i.id,
				composition: i.composition,
				...(label ? { label } : {}),
				data: isRecord(i.data) ? i.data : {},
				...(output ? { output } : {}),
			})
		}
		out.push({ id: r.id, name: text(r.name) ?? r.id, items })
	}
	return out
}

/** The target an item is taken onto, as Breeze names it: `@<output>` or the composition id. */
export function itemTarget(item: RundownItem): string {
	return item.output ? `@${item.output}` : item.composition
}

/** What a list row shows: the label, else the first non-empty text field, else the composition's name. */
export function itemTitle(item: RundownItem | undefined, compositionName?: string): string {
	if (!item) return ''
	if (item.label) return item.label
	for (const value of Object.values(item.data)) {
		if (typeof value === 'string' && value.trim()) return value.trim()
	}
	return compositionName || item.composition
}

/** What is armed and what each target shows, for one rundown. */
export interface RundownLive {
	armed: string | null
	/** Target (`@main` or a composition id) → item id. */
	onAir: Record<string, string>
}

/** `$rundown` from the rundown channel, or a rundown's `/state`: rundown id → live state. */
export function readRundownLive(raw: unknown): Map<string, RundownLive> {
	const out = new Map<string, RundownLive>()
	if (!isRecord(raw)) return out
	for (const [id, live] of Object.entries(raw)) {
		const one = toRundownLive(live)
		if (one) out.set(id, one)
	}
	return out
}

export function toRundownLive(raw: unknown): RundownLive | null {
	if (!isRecord(raw)) return null
	const onAir: Record<string, string> = {}
	if (isRecord(raw.onAir)) {
		for (const [target, item] of Object.entries(raw.onAir)) if (typeof item === 'string') onAir[target] = item
	}
	return { armed: typeof raw.armed === 'string' && raw.armed !== '' ? raw.armed : null, onAir }
}

/* ------------------------------------------------------------ sports */

export interface SportAction {
	id: string
	label: string
}

export interface SportInfo {
	id: string
	/** `points` | `rally` | `sideout` | `tennis` | `cricket`. */
	scoring: string
	actions: SportAction[]
}

/** `GET /api/sports`, by sport id. */
export function readSports(raw: unknown): Map<string, SportInfo> {
	const out = new Map<string, SportInfo>()
	if (!isRecord(raw) || !Array.isArray(raw.sports)) return out
	for (const s of raw.sports) {
		if (!isRecord(s) || typeof s.id !== 'string') continue
		const actions = Array.isArray(s.actions)
			? s.actions
					.filter((a): a is Loose => isRecord(a) && typeof a.id === 'string' && typeof a.label === 'string')
					.map((a) => ({ id: a.id as string, label: a.label as string }))
			: []
		out.set(s.id, { id: s.id, scoring: typeof s.scoring === 'string' ? s.scoring : 'points', actions })
	}
	return out
}

/* --------------------------------------------------------- variables */

/** A row value as a variable shows it: blank for null or missing, never `undefined`. */
export function cellText(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return ''
}

/**
 * A Companion variable id from a Breeze name.
 *
 * Companion 5.1 drops a variable whose id has anything but letters, digits,
 * `-`, `_`, `.` and `!`, or is a reserved name, for every module API. Breeze's
 * own ids already fit; this guards a name that does not.
 */
export function variableId(raw: string): string {
	const id = raw.replace(/[^a-zA-Z0-9\-_.!]/g, '_')
	return RESERVED.has(id) ? `${id}_` : id
}

const RESERVED = new Set(['constructor', 'prototype', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'])
