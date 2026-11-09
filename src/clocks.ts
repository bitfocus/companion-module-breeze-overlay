// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Operator timers and rolls, worked out locally (Breeze 0.79+).
 *
 * Breeze does not send a frame per second for a running clock. It keeps each
 * timer as `{ running, anchor, elapsed, base, adjust }` and each roll as
 * `{ running, anchor, base, rate }`, stamped with the hub's clock, and every
 * output works the value out from that. This module does the same, so a
 * button shows the clock the output shows without polling it.
 *
 * The rules follow Breeze's own (`@breeze/schema` timer.ts and scroll.ts): a
 * countdown rounds whole seconds up, so `0:00` means zero; a count-up rounds
 * down; `until` counts down to a time of day in a zone.
 */

export interface TimerSettings {
	id?: string
	mode: 'countdown' | 'countup' | 'stopwatch'
	/** Seconds. Countdown: where it starts. Count-up: where it starts (default 0). */
	duration?: number
	/** Count-up: where it ends, in seconds. */
	limit?: number
	/** Countdown to a time of day, `10:00` or `18:30:00`, 24-hour. */
	until?: string
	timezone?: string
	format?: string
	tenthsUnder?: number
	tenthsFormat?: string
	end?: 'stop' | 'continue'
}

/** One timer's state as the hub keeps it. Times are hub-clock epoch ms. */
export interface TimerState {
	running: boolean
	anchor: number
	elapsed: number
	base?: number
	adjust: number
}

/** One roll's transport as the hub keeps it. */
export interface ScrollState {
	running: boolean
	anchor: number
	/** Travel at `anchor`, seconds at the designer's speed. */
	base: number
	/** Signed multiple of the designer's speed. */
	rate: number
}

/** What the outputs reported about a roll. */
export interface ScrollInfo {
	/** The whole travel, seconds at the designer's speed. */
	extent?: number
	end?: string
	start?: string
}

/** Used when no layer in the project describes a timer id: a plain count-up. */
export const UNKNOWN_TIMER: TimerSettings = { mode: 'countup' }

const IDLE: TimerState = { running: false, anchor: 0, elapsed: 0, adjust: 0 }

function elapsedMs(state: TimerState, now: number): number {
	return state.elapsed + (state.running ? Math.max(0, now - state.anchor) : 0)
}

/** Seconds into the day in `zone` (the host's zone when absent or unknown). */
function secondsOfDay(zone: string | undefined, at: Date): number {
	let parts: Intl.DateTimeFormatPart[]
	try {
		parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: zone,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(at)
	} catch {
		parts = new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(at)
	}
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
	return get('hour') * 3600 + get('minute') * 60 + get('second') + at.getMilliseconds() / 1000
}

function untilMs(until: string, zone: string | undefined, now: number): number {
	const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(until.trim())
	if (!m) return 0
	const target = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)
	return Math.round((target - secondsOfDay(zone, new Date(now))) * 1000)
}

/** The value on screen in milliseconds: time left for a countdown, time run otherwise. */
export function timerMs(timer: TimerSettings, state: TimerState | undefined, now: number): number {
	const s = state ?? IDLE
	const end = timer.end ?? 'stop'
	const base = s.base ?? (timer.duration ?? 0) * 1000
	if (timer.mode === 'countdown') {
		const left =
			timer.until !== undefined
				? untilMs(timer.until, timer.timezone, now) + s.adjust
				: base - elapsedMs(s, now) + s.adjust
		return end === 'stop' ? Math.max(0, left) : left
	}
	const run = base + elapsedMs(s, now) + s.adjust
	const limit = timer.limit !== undefined ? timer.limit * 1000 : undefined
	return end === 'stop' && limit !== undefined ? Math.min(limit, Math.max(0, run)) : Math.max(0, run)
}

/** Whether a timer has reached its end: zero for a countdown, its limit for a count-up. */
export function timerFinished(timer: TimerSettings, state: TimerState | undefined, now: number): boolean {
	const ms = timerMs(timer, state, now)
	if (timer.mode === 'countdown') return ms <= 0
	return timer.limit !== undefined && ms >= timer.limit * 1000
}

/** Whether a timer counts now. A time-of-day countdown always does. */
export function timerRunning(timer: TimerSettings, state: TimerState | undefined): boolean {
	if (timer.mode === 'countdown' && timer.until !== undefined) return true
	return state?.running === true
}

const TOKENS = ['hh', 'mm', 'ss', 'SS', 'h', 'm', 's', 'S'] as const

/** Milliseconds through a token format — `m:ss`, `h:mm:ss`, `s.S`, `[text]` literal. */
export function formatMs(ms: number, format: string, down: boolean): string {
	const negative = ms < 0
	const abs = Math.abs(ms)
	const unit = format.includes('SS') ? 10 : format.includes('S') ? 100 : 1000
	const units = down && !negative ? Math.ceil(abs / unit) : Math.floor(abs / unit)
	const total = units * unit
	const bare = format.replace(/\[[^\]]*\]/g, '')
	const hasH = bare.includes('h')
	const hasM = bare.includes('m')
	const hours = Math.floor(total / 3_600_000)
	const minutes = hasH ? Math.floor(total / 60_000) % 60 : Math.floor(total / 60_000)
	const seconds = hasM ? Math.floor(total / 1000) % 60 : Math.floor(total / 1000)
	const value: Record<(typeof TOKENS)[number], string> = {
		hh: String(hours).padStart(2, '0'),
		h: String(hours),
		mm: String(minutes).padStart(2, '0'),
		m: String(minutes),
		ss: String(seconds).padStart(2, '0'),
		s: String(seconds),
		SS: String(Math.floor((total % 1000) / 10)).padStart(2, '0'),
		S: String(Math.floor((total % 1000) / 100)),
	}
	let out = ''
	let i = 0
	while (i < format.length) {
		if (format[i] === '[') {
			const close = format.indexOf(']', i)
			if (close !== -1) {
				out += format.slice(i + 1, close)
				i = close + 1
				continue
			}
		}
		const token = TOKENS.find((t) => format.startsWith(t, i))
		if (token) {
			out += value[token]
			i += token.length
		} else {
			out += format[i]
			i += 1
		}
	}
	return negative && total > 0 ? `-${out}` : out
}

/** The text a timer layer shows at `now`. */
export function timerText(timer: TimerSettings, state: TimerState | undefined, now: number): string {
	const ms = timerMs(timer, state, now)
	const base = timer.format ?? (timer.mode === 'stopwatch' ? 'm:ss.S' : 'm:ss')
	const format =
		timer.tenthsUnder !== undefined && ms >= 0 && ms < timer.tenthsUnder * 1000 ? (timer.tenthsFormat ?? 's.S') : base
	return formatMs(ms, format, timer.mode === 'countdown')
}

/**
 * How often a shown timer can change: tenths need 100 ms, hundredths 50,
 * whole seconds 250 (so the change lands close to the real second).
 */
export function timerTickMs(timer: TimerSettings): number {
	const formats = [timer.format ?? (timer.mode === 'stopwatch' ? 'm:ss.S' : 'm:ss')]
	if (timer.tenthsUnder !== undefined) formats.push(timer.tenthsFormat ?? 's.S')
	if (formats.some((f) => f.includes('SS'))) return 50
	if (formats.some((f) => f.includes('S'))) return 100
	return 250
}

/* -------------------------------------------------------------- rolls */

/** Travel at `now`, kept inside the text (wrapped for a loop). */
export function scrollTravel(state: ScrollState, info: ScrollInfo | undefined, now: number): number {
	const travel = state.base + (state.running ? (state.rate * Math.max(0, now - state.anchor)) / 1000 : 0)
	const extent = info?.extent
	if (extent === undefined || !Number.isFinite(extent) || extent <= 0) return Math.max(0, travel)
	if (info?.end === 'loop') return ((travel % extent) + extent) % extent
	return Math.min(extent, Math.max(0, travel))
}

/** How far through the text, 0–100, or null before an output has said how long it is. */
export function scrollPercent(state: ScrollState, info: ScrollInfo | undefined, now: number): number | null {
	const extent = info?.extent
	if (extent === undefined || !Number.isFinite(extent) || extent <= 0) return null
	return Math.round((scrollTravel(state, info, now) / extent) * 100)
}

/** Whether a roll that does not loop has reached the end it is heading for. */
export function scrollAtEnd(state: ScrollState, info: ScrollInfo | undefined, now: number): boolean {
	const extent = info?.extent
	if (extent === undefined || info?.end === 'loop') return false
	const travel = state.base + (state.running ? (state.rate * Math.max(0, now - state.anchor)) / 1000 : 0)
	return state.rate >= 0 ? travel >= extent : travel <= 0
}

/**
 * Seconds of real time until a roll reaches the end it is heading for, at its
 * current speed: the text left over the speed going forward, the text behind
 * it going backward. Null for a loop, which has no end, and before an output
 * has said how long the text is. Paused, it is what is left at that speed.
 */
export function scrollRemaining(state: ScrollState, info: ScrollInfo | undefined, now: number): number | null {
	const extent = info?.extent
	if (extent === undefined || !Number.isFinite(extent) || extent <= 0 || info?.end === 'loop') return null
	const rate = Math.abs(state.rate)
	if (rate === 0) return null
	const travel = scrollTravel(state, info, now)
	return Math.max(0, (state.rate >= 0 ? extent - travel : travel) / rate)
}

/** `×1`, `×1.25`, `×0.5` — the speed as an operator reads it. */
export function speedText(rate: number): string {
	return `×${Number(Math.abs(rate).toFixed(2))}`
}
