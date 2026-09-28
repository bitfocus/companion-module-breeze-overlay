// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import type ModuleInstance from './main.js'

/**
 * Variables for the default channel only.
 *
 * Companion variable names are fixed at definition time, so a per-channel set
 * would mean redefining them every time a scene is added in Breeze — and a
 * variable that disappears breaks any button referencing it. The default
 * channel is the one a given connection is pointed at, which is the one worth
 * putting on a button; anything else is better served by a feedback, which
 * takes its channel as an option.
 *
 * The same reasoning covers tables: the page variables follow the first paged
 * table on the default channel, rather than one set per table whose names
 * would come and go with the composition. A specific table is what the
 * feedbacks' Table field is for.
 */
export type VariablesSchema = {
	server_version: string
	project: string
	channel: string
	playback_state: string
	playback_step: string
	playback_steps: string
	sources_connected: string
	panels_connected: string
	/** `live` (pushed over the hub socket), `poll`, or blank. */
	state_source: string
	table: string
	page: string
	page_count: string
	page_key: string
	/** `none` | `cycling` | `held` | `stopped`. */
	cycle_state: string
	cycle_seconds_left: string
	/** Sources in the project whose fetches are failing, or whose data ran out. */
	sources_failing: string
	/** Sources whose backup is on air. */
	sources_on_backup: string
	/** The project's mode; blank for none. */
	mode: string
	/** Cameras up across the project's camera lists (Wave 8). */
	media_up: string
	/** Cameras failed or frozen across the project's camera lists (Wave 8). */
	media_down: string
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		server_version: { name: 'Breeze server version' },
		project: { name: 'Default project key' },
		channel: { name: 'Default channel' },
		playback_state: { name: 'Playback state of the default channel' },
		playback_step: { name: 'Current step' },
		playback_steps: { name: 'Total steps' },
		sources_connected: { name: 'Browser sources attached to the default channel' },
		panels_connected: { name: 'Control panels and editors on the default channel' },
		state_source: { name: 'How state is arriving — live (pushed) or poll' },
		table: { name: 'Paged table on the default channel (the first one)' },
		page: { name: 'Page that table is showing, from 1' },
		page_count: { name: 'Pages in that table' },
		page_key: { name: "The page's key — e.g. the city or group it shows" },
		cycle_state: { name: 'Cycle state — none, cycling, held or stopped' },
		cycle_seconds_left: { name: 'Seconds until that table turns its page' },
		sources_failing: { name: 'Data sources failing, expired or frozen (Breeze 0.74+)' },
		sources_on_backup: { name: 'Data sources with their backup on air (Breeze 0.74+)' },
		mode: { name: 'The project mode — blank for none (Breeze 0.74+)' },
		media_up: { name: 'Cameras up across the project’s camera lists (Breeze 0.74+)' },
		media_down: { name: 'Cameras failed or frozen across the project’s camera lists (Breeze 0.74+)' },
	})
}
