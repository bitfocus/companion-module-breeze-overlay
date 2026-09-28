// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * What each feature needs from the server.
 *
 * One connection may outlive several server upgrades — or be pointed at an
 * older machine kept as a backup — so the module asks `/healthz` for the
 * version on every (re)connect and checks against this table, rather than
 * assuming the server is as new as the module.
 *
 * An action whose feature the server lacks logs one plain sentence naming the
 * version it needs, instead of sending a request that would come back 404 and
 * be reported as a wrong channel key.
 */
export const MIN_VERSION = {
	/** Live state over the control hub socket, as a `companion` controller with `data: false`. */
	live: '0.74.0',
	/** PREV, and NEXT / PREV aimed at one table. */
	prev: '0.74.0',
	/** Go to page. */
	page: '0.74.0',
	/** Cycle hold / resume. */
	cycle: '0.74.0',
	/** Data-source health with backups, and choosing a source's backup. */
	sources: '0.74.0',
	/** The project mode that layer rules read. */
	mode: '0.74.0',
	/** Camera lists: media checks per source, and checking them now (Wave 8). */
	media: '0.74.0',
} as const

export type Feature = keyof typeof MIN_VERSION

/**
 * `[major, minor, patch]`, or null for anything that does not start like a
 * version. Pre-release and build suffixes (`0.74.0-dev`, `0.74.0+abc`) are
 * ignored: a development build of 0.74 has 0.74's routes.
 */
export function parseVersion(raw: string | undefined): [number, number, number] | null {
	const match = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw ?? '')
	if (!match) return null
	return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/**
 * Whether `version` is at least `minimum`.
 *
 * An unknown version answers `null`, not false: the server could not be asked
 * (it was down at connect), and refusing every newer action on that basis
 * would leave buttons dead after the server comes back. Callers try the
 * request instead and let the answer speak.
 */
export function atLeast(version: string | undefined, minimum: string): boolean | null {
	const have = parseVersion(version)
	const need = parseVersion(minimum)
	if (!have || !need) return null
	for (const [i, part] of have.entries()) {
		const wanted = need[i] ?? 0
		if (part !== wanted) return part > wanted
	}
	return true
}
