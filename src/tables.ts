// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Reading the paged tables a channel reports (Breeze 0.74+).
 *
 * Kept apart from `main.ts` so actions and feedbacks can use it without an
 * import cycle through the instance class.
 */

import type { TableReport } from './api.js'

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

/** Whether a table shows the page asked for — a 1-based number, or a key (compared case-insensitively). */
export function showsPage(table: TableReport, by: string, page: string): boolean {
	const wanted = page.trim()
	if (!wanted) return false
	if (by === 'name') return (table.key ?? '').trim().toLowerCase() === wanted.toLowerCase()
	return /^\d+$/.test(wanted) && table.page === Number(wanted)
}
