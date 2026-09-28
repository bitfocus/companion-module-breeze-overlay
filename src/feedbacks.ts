// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { mediaDown, overridden, sourceState } from './sources.js'
import { findTable, showsPage } from './tables.js'

export type FeedbacksSchema = {
	on_air: { type: 'boolean'; options: { channel: string } }
	playback_state: { type: 'boolean'; options: { channel: string; state: string } }
	source_connected: { type: 'boolean'; options: { channel: string } }
	cycle_held: { type: 'boolean'; options: { channel: string; table: string } }
	page_is: { type: 'boolean'; options: { channel: string; table: string; by: string; page: string } }
	source_state: { type: 'boolean'; options: { source: string; state: string } }
	media_state: { type: 'boolean'; options: { source: string; state: string } }
	mode_is: { type: 'boolean'; options: { mode: string } }
}

/**
 * Playback states Breeze reports.
 *
 * `holding` is the one that matters on a button: it means the graphic is parked
 * at a STOP marker and is sitting on screen right now.
 */
const STATES = ['idle', 'playing-in', 'holding', 'playing-out', 'finished'] as const

export function UpdateFeedbacks(self: ModuleInstance): void {
	const channelOption = {
		id: 'channel' as const,
		type: 'textinput' as const,
		label: 'Scene or element channel (blank = connection default)',
		default: '',
		useVariables: true,
	}

	const tableOption = {
		id: 'table' as const,
		type: 'textinput' as const,
		label: 'Table (blank = the first paged table)',
		default: '',
		useVariables: true,
	}

	/*
	 * Each run re-claims the feedback's channel (so an edited field or a
	 * changed variable moves the claim), and `unsubscribe` — which since
	 * module-base 2.0 fires only on delete/disable — releases it, so a removed
	 * feedback's channel stops being polled.
	 */
	const unsubscribe = (feedback: { id: string }) => self.untrack(`feedback:${feedback.id}`)

	self.setFeedbackDefinitions({
		/**
		 * On air — anything other than idle or finished.
		 *
		 * The single most useful button colour: is this graphic currently
		 * contributing pixels? Red, because that is what on-air means everywhere
		 * else in a gallery.
		 */
		on_air: {
			name: 'Graphic is on air',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(200, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [channelOption],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				const playback = state?.playback?.state
				if (!playback) return false
				return playback !== 'idle' && playback !== 'finished'
			},
		},

		/** For an operator who wants to distinguish rolling in from holding. */
		playback_state: {
			name: 'Playback state is…',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(200, 120, 0),
				color: combineRgb(0, 0, 0),
			},
			options: [
				channelOption,
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'holding',
					choices: STATES.map((id) => ({ id, label: id })),
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				return (state?.playback?.state ?? 'idle') === feedback.options.state
			},
		},

		/**
		 * No browser source attached.
		 *
		 * Deliberately inverted — it lights up when something is *wrong*. A
		 * button that looks normal until you press it, and then does nothing
		 * because the output was never opened in OBS, is the failure this exists
		 * to make visible beforehand.
		 */
		source_connected: {
			name: 'No browser source attached (warning)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(90, 90, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [channelOption],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				// Unknown is not the same as zero: before the first poll lands we
				// have no basis to warn, and a button that flashes a warning on
				// every Companion restart teaches people to ignore it.
				if (!state) return false
				return state.renderers === 0
			},
		},

		/**
		 * A self-paging table is frozen.
		 *
		 * The reminder a held table needs: it looks exactly like a table between
		 * turns, and a hold survives the graphic going off air and back, so the
		 * button is the only place that remembers somebody pressed it.
		 */
		cycle_held: {
			name: 'Table cycle is held (Breeze 0.74+)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(0, 70, 160),
				color: combineRgb(255, 255, 255),
			},
			options: [channelOption, tableOption],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				const tables = findTable(state?.playback?.tables, feedback.options.table)
				return tables.some((table) => table.hasCycle && table.held)
			},
		},

		/**
		 * A paged table is showing a given page.
		 *
		 * For a bank of Go to page buttons — Group A to Group H, or one per city
		 * — where the one on screen should light up, whoever turned to it.
		 */
		page_is: {
			name: 'Table is showing page… (Breeze 0.74+)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(0, 120, 40),
				color: combineRgb(255, 255, 255),
			},
			options: [
				channelOption,
				tableOption,
				{
					id: 'by',
					type: 'dropdown',
					label: 'Match',
					default: 'number',
					choices: [
						{ id: 'number', label: 'Page number (from 1)' },
						{ id: 'name', label: 'Page key' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'page',
					type: 'textinput',
					label: 'Page',
					default: '1',
					useVariables: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				const tables = findTable(state?.playback?.tables, feedback.options.table)
				return tables.some((table) => showsPage(table, feedback.options.by, feedback.options.page))
			},
		},

		/**
		 * What a data source is doing.
		 *
		 * `backup` is the one to put on a button: the rows on air are not the
		 * source's own, which is the state an operator must not forget they are
		 * in. Reads the project's source list, polled every few seconds — not a
		 * channel, so it takes no Channel field.
		 */
		source_state: {
			name: 'Data source is… (Breeze 0.74+)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(150, 90, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'source',
					type: 'textinput',
					label: 'Data source id',
					default: '',
					useVariables: true,
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'backup',
					choices: [
						{ id: 'backup', label: 'On its backup' },
						{ id: 'failing', label: 'Failing (last good still on air)' },
						{ id: 'expired', label: 'Expired or frozen (blank on air)' },
						{ id: 'problem', label: 'Any problem — backup, failing or expired' },
						{ id: 'live', label: 'Live' },
						{ id: 'override', label: 'Set by an operator (not automatic)' },
					],
					disableAutoExpression: true,
				},
			],
			callback: (feedback) => {
				const source = self.sourceFor(feedback.options.source)
				if (!source) return false
				if (feedback.options.state === 'override') return overridden(source)
				const state = sourceState(source)
				if (feedback.options.state === 'problem')
					return state === 'backup' || state === 'failing' || state === 'expired'
				return state === feedback.options.state
			},
		},

		/**
		 * A camera list's health (Wave 8). `down` is the one for a button: some
		 * camera has failed or frozen and has dropped out of the rotation.
		 */
		media_state: {
			name: 'Camera list is… (Breeze 0.74+)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(200, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'source',
					type: 'textinput',
					label: 'Data source id',
					default: '',
					useVariables: true,
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'down',
					choices: [
						{ id: 'down', label: 'A camera is down — failed or frozen' },
						{ id: 'frozen', label: 'A camera is frozen' },
						{ id: 'ok', label: 'Every camera up' },
					],
					disableAutoExpression: true,
				},
			],
			callback: (feedback) => {
				const source = self.sourceFor(feedback.options.source)
				const media = source?.status.media
				if (!source || !media) return false
				if (feedback.options.state === 'frozen') return media.frozen > 0
				const down = mediaDown(source) ?? 0
				return feedback.options.state === 'ok' ? down === 0 : down > 0
			},
		},

		/**
		 * The project is in a mode — First Alert, election night. Red by
		 * default, because a mode is exactly the state a button should not let
		 * anyone forget. Blank matches "no mode".
		 */
		mode_is: {
			name: 'Project mode is… (Breeze 0.74+)',
			type: 'boolean',
			defaultStyle: {
				bgcolor: combineRgb(200, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					id: 'mode',
					type: 'textinput',
					label: 'Mode (blank = no mode)',
					default: '',
					useVariables: true,
				},
			],
			callback: (feedback) => {
				const current = self.currentMode()
				if (current === undefined) return false
				return current.toLowerCase() === (feedback.options.mode ?? '').trim().toLowerCase()
			},
		},
	})
}
