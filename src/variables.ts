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
 *
 * And the 0.79 additions: the rundown variables follow the project's first
 * rundown, the timer variables the default channel's `main` timer (or its
 * first), and the score variables the project's first sport game table. Any
 * other rundown, timer, roll, game or poll is shown through a value feedback
 * into a button's local variable, as the presets do — never through a variable
 * named after something an editor can rename or delete.
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
	/** The first rundown's name (0.79+). */
	rundown: string
	/** The armed item's title, as the rundown panel shows it. */
	cued_item: string
	cued_composition: string
	/** `3/15`. */
	cued_position: string
	/** What the armed item's target shows now. */
	on_air_item: string
	/** The default channel's timer: its id, its text, whole seconds, `true`/`false`. */
	timer: string
	timer_remaining: string
	timer_seconds: string
	timer_running: string
	/** The first sport game table's score and period. */
	home_score: string
	away_score: string
	period_label: string
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
		rundown: { name: 'The first rundown’s name (Breeze 0.79+)' },
		cued_item: { name: 'The item armed in that rundown — what TAKE puts on air next' },
		cued_composition: { name: 'The graphic of the armed item' },
		cued_position: { name: 'The armed item’s place in the rundown — e.g. 3/15' },
		on_air_item: { name: 'The item on air where the armed item goes' },
		timer: { name: 'The default channel’s timer id — main, or its first (Breeze 0.79+)' },
		timer_remaining: { name: 'That timer as the graphic shows it — e.g. 7:42' },
		timer_seconds: { name: 'That timer in whole seconds' },
		timer_running: { name: 'Whether that timer is running — true or false' },
		home_score: { name: 'Home score of the project’s first sport game table (Breeze 0.79+)' },
		away_score: { name: 'Away score of that game table' },
		period_label: { name: 'Period of that game table — e.g. 3rd, 2OT, Top 7th' },
	})
}
