// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Reading data-source health (Breeze 0.74+, CYCLE.md Wave 5).
 *
 * Kept apart from `main.ts`, like `tables.ts`, so actions and feedbacks can use
 * it without an import cycle through the instance class.
 */

import type { SourceSummary } from './api.js'

/**
 * One word for what a source is doing, most urgent first:
 *
 * - `backup` — its backup's rows are on air
 * - `expired` — blank on air: its data ran out, or froze
 * - `failing` — fetches failing, last good rows still on air
 * - `waiting` — has not fetched yet
 * - `live` — working
 *
 * A manual source is always `live`: its rows are typed, not fetched.
 */
export function sourceState(source: SourceSummary): string {
	const status = source.status
	if (status.serving !== undefined) return 'backup'
	if (status.expired || status.stuck) return 'expired'
	if ((status.failures ?? 0) > 0) return 'failing'
	if (source.def.type !== 'manual' && !status.lastSuccess) return 'waiting'
	return 'live'
}

/** Cameras in a source that are down — failed or frozen — or null for a source with no media checks. */
export function mediaDown(source: SourceSummary): number | null {
	const media = source.status.media
	return media ? media.failed + media.frozen : null
}

/** Cameras in a source that are up. A camera not checked yet counts: it is on air until a check says otherwise. */
export function mediaUp(source: SourceSummary): number | null {
	const media = source.status.media
	return media ? media.ok + media.unchecked : null
}

/** Whether an operator has overridden the source — `use` is set. */
export function overridden(source: SourceSummary): boolean {
	return source.status.use !== undefined
}

/**
 * What a toggle press should ask for: back to automatic when the backup is on
 * air by an operator's choice, otherwise the backup.
 */
export function toggleUse(source: SourceSummary | undefined): 'auto' | 'backup' {
	return source?.status.use === 'backup' ? 'auto' : 'backup'
}
