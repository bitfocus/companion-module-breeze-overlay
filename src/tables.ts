// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Reading the paged tables a channel reports (Breeze 0.74+).
 *
 * Kept apart from `main.ts` so actions and feedbacks can use it without an
 * import cycle through the instance class.
 */

import type { ChannelRef, PagedTableRef, TableReport } from './api.js'

/** `none` | `cycling` | `held` | `stopped` — stopped is a cycle that ran to its end. */
export function cycleState(table: TableReport): string {
	if (!table.hasCycle) return 'none'
	if (table.held) return 'held'
	return table.cycling ? 'cycling' : 'stopped'
}

/**
 * The reported tables a Table field names.
 *
 * Blank is the first paged table. Otherwise close to the names Breeze accepts
 * in `?table=`: the table's reported address, its cycle group, the binding at
 * the end of a nested address (`standings` for `groups.standings`), or the
 * layer id at the end of a namespaced one — so the name a user reads in the
 * editor is enough.
 */
export function findTable(tables: TableReport[] | undefined, name: string | undefined): TableReport[] {
	const all = tables ?? []
	const wanted = (name ?? '').trim()
	if (!wanted) return all.slice(0, 1)
	return all.filter(
		(table) =>
			table.table === wanted ||
			table.group === wanted ||
			table.table.endsWith(`.${wanted}`) ||
			table.table.endsWith(`/${wanted}`),
	)
}

/**
 * The page a table shows, counted from 1 — the number an operator reads and types.
 *
 * Breeze reports `page` counted from 0, as its own control panel does before it
 * adds one for display. Every place this module shows or matches a page number
 * goes through here, so the conversion happens once. Null when the report has
 * no usable number, so a variable shows blank rather than `NaN`.
 */
export function pageNumber(table: TableReport): number | null {
	return Number.isInteger(table.page) && table.page >= 0 ? table.page + 1 : null
}

/**
 * What the Table page feedback shows: `2/3`, `2`, `3` or the page key.
 *
 * Blank rather than a guess when the report lacks a number, so a status button
 * reads empty instead of `NaN/3`. The key is the value of the table's key
 * column on the page showing — `Peoria Pioneers`, `Group C` — and blank when
 * the table has none.
 */
export function pageText(table: TableReport, show: string): string {
	const n = pageNumber(table)
	const count = Number.isInteger(table.pageCount) && table.pageCount > 0 ? table.pageCount : null
	switch (show) {
		case 'number':
			return n === null ? '' : String(n)
		case 'count':
			return count === null ? '' : String(count)
		case 'key':
			return typeof table.key === 'string' ? table.key.trim() : ''
		default:
			return n === null || count === null ? '' : `${n}/${count}`
	}
}

/**
 * A channel's paged tables from `/api/channels`, keeping only well-formed entries.
 *
 * Absent on a server older than 0.77, which simply means no PAGE presets.
 */
export function listedTables(entry: ChannelRef): PagedTableRef[] {
	if (!Array.isArray(entry.tables)) return []
	return entry.tables
		.filter(
			(t): t is PagedTableRef =>
				typeof t === 'object' && t !== null && typeof t.table === 'string' && t.table.trim() !== '',
		)
		.map((t) => ({
			table: t.table,
			name: typeof t.name === 'string' && t.name.trim() ? t.name : t.table,
			cycle: t.cycle === true,
		}))
}

/** Whether a table shows the page asked for — a 1-based number, or a key (compared case-insensitively). */
export function showsPage(table: TableReport, by: string, page: string): boolean {
	const wanted = page.trim()
	if (!wanted) return false
	if (by === 'name') return (table.key ?? '').trim().toLowerCase() === wanted.toLowerCase()
	return /^\d+$/.test(wanted) && pageNumber(table) === Number(wanted)
}
