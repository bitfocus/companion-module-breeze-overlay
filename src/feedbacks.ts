// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { cellText } from './catalogue.js'
import { formatMs } from './clocks.js'
import { mediaDown, overridden, sourceState } from './sources.js'
import { findTable, pageText, showsPage } from './tables.js'

export type FeedbacksSchema = {
	on_air: { type: 'boolean'; options: { channel: string } }
	playback_state: { type: 'boolean'; options: { channel: string; state: string } }
	source_connected: { type: 'boolean'; options: { channel: string } }
	cycle_held: { type: 'boolean'; options: { channel: string; table: string } }
	page_is: { type: 'boolean'; options: { channel: string; table: string; by: string; page: string } }
	table_page: { type: 'value'; options: { channel: string; table: string; show: string }; result: string }
	source_state: { type: 'boolean'; options: { source: string; state: string } }
	media_state: { type: 'boolean'; options: { source: string; state: string } }
	mode_is: { type: 'boolean'; options: { mode: string } }
	rundown_item: { type: 'boolean'; options: { rundown: string; item: string; state: string } }
	rundown_cued_differs: { type: 'boolean'; options: { rundown: string } }
	rundown_value: { type: 'value'; options: { rundown: string; show: string }; result: string }
	timer_running: { type: 'boolean'; options: { channel: string; timer: string } }
	timer_under: { type: 'boolean'; options: { channel: string; timer: string; seconds: number } }
	timer_value: { type: 'value'; options: { channel: string; timer: string; show: string }; result: string }
	roll_is: { type: 'boolean'; options: { channel: string; roll: string; state: string } }
	roll_value: { type: 'value'; options: { channel: string; roll: string; show: string }; result: string | number }
	playhead_value: { type: 'value'; options: { channel: string; show: string }; result: string | number }
	playback_color: {
		type: 'value'
		options: { channel: string; idle: number; playingIn: number; holding: number; playingOut: number }
		result: number
	}
	roll_color: {
		type: 'value'
		options: {
			channel: string
			roll: string
			warn: number
			critical: number
			normal: number
			warnColor: number
			criticalColor: number
		}
		result: number
	}
	game_value: { type: 'value'; options: { source: string; column: string }; result: string }
	game_column_is: { type: 'boolean'; options: { source: string; column: string; value: string } }
	poll_value: { type: 'value'; options: { source: string; option: string; show: string }; result: string }
	poll_open: { type: 'boolean'; options: { source: string } }
	poll_leading: { type: 'boolean'; options: { source: string; option: string } }
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

	const clockChannelOption = {
		...channelOption,
		label: 'Channel — a graphic, or @output (blank = connection default)',
	}
	const timerOption = {
		id: 'timer' as const,
		type: 'textinput' as const,
		label: 'Timer id (blank = the channel’s first, main if it has one)',
		default: '',
		useVariables: true,
	}
	const rollOption = {
		id: 'roll' as const,
		type: 'textinput' as const,
		label: 'Roll id (blank = the channel’s first)',
		default: '',
		useVariables: true,
	}
	const rundownOption = {
		id: 'rundown' as const,
		type: 'textinput' as const,
		label: 'Rundown id (blank = the first rundown)',
		default: '',
		useVariables: true,
	}
	const sourceOption = {
		id: 'source' as const,
		type: 'textinput' as const,
		label: 'Data source id',
		default: '',
		useVariables: true,
	}

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
					disableAutoExpression: true,
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
		/*
		 * A value, not a style: what a PAGE status button prints. Each button
		 * stores it in a local variable (`$(local:page)`), so every button can
		 * watch its own graphic's table — the connection variables only follow
		 * the default channel.
		 */
		table_page: {
			name: 'Table page — page number, count or key (Breeze 0.74+)',
			type: 'value',
			options: [
				channelOption,
				tableOption,
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'page',
					choices: [
						{ id: 'page', label: 'Page of pages — 2/3' },
						{ id: 'number', label: 'Page number — 2' },
						{ id: 'count', label: 'Page count — 3' },
						{ id: 'key', label: 'Page key — e.g. Group C' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const state = self.stateFor(`feedback:${feedback.id}`, feedback.options.channel)
				const table = findTable(state?.playback?.tables, feedback.options.table)[0]
				return table ? pageText(table, feedback.options.show) : ''
			},
		},

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

		/* ------------------------------------------------ 0.79: rundowns */

		/**
		 * An item is armed, or on air. For a bank of Arm buttons: the armed one
		 * lights amber, and the one on air red.
		 */
		rundown_item: {
			name: 'Rundown item is armed or on air (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(200, 120, 0), color: combineRgb(0, 0, 0) },
			options: [
				rundownOption,
				{ id: 'item', type: 'textinput', label: 'Item id', default: '', useVariables: true },
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'armed',
					choices: [
						{ id: 'armed', label: 'Armed — TAKE puts it on air next' },
						{ id: 'on_air', label: 'On air' },
					],
					disableAutoExpression: true,
				},
			],
			callback: (feedback) => {
				const rundown = self.rundownFor(feedback.options.rundown)
				const live = rundown ? self.rundownState(rundown.id) : undefined
				const item = (feedback.options.item ?? '').trim()
				if (!live || !item) return false
				if (feedback.options.state === 'on_air') return Object.values(live.onAir).includes(item)
				return live.armed === item
			},
		},

		/**
		 * The armed item is not what its target shows — the moment before a
		 * TAKE. Off once it is taken, or when nothing is armed.
		 */
		rundown_cued_differs: {
			name: 'Rundown: armed item is not on air yet (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(200, 120, 0), color: combineRgb(0, 0, 0) },
			options: [rundownOption],
			callback: (feedback) => {
				const rundown = self.rundownFor(feedback.options.rundown)
				const live = rundown ? self.rundownState(rundown.id) : undefined
				const armed = rundown?.items.find((i) => i.id === live?.armed)
				if (!live || !armed) return false
				return live.onAir[armed.output ? `@${armed.output}` : armed.composition] !== armed.id
			},
		},

		/** What a TAKE button prints: the armed item, its graphic, its place, or what is on air. */
		rundown_value: {
			name: 'Rundown — armed item, its place, or what is on air (Breeze 0.79+)',
			type: 'value',
			options: [
				rundownOption,
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'cued',
					choices: [
						{ id: 'cued', label: 'Armed item' },
						{ id: 'composition', label: 'Armed item’s graphic' },
						{ id: 'position', label: 'Armed item’s place — 3/15' },
						{ id: 'on_air', label: 'On air where the armed item goes' },
						{ id: 'name', label: 'Rundown name' },
					],
					disableAutoExpression: true,
				},
			],
			callback: (feedback) => {
				const rundown = self.rundownFor(feedback.options.rundown)
				if (!rundown) return ''
				if (feedback.options.show === 'name') return rundown.name
				const live = self.rundownState(rundown.id)
				const armed = rundown.items.find((i) => i.id === live?.armed)
				switch (feedback.options.show) {
					case 'composition':
						return armed ? (self.compositionFor(armed.composition)?.name ?? armed.composition) : ''
					case 'position':
						return armed ? `${rundown.items.indexOf(armed) + 1}/${rundown.items.length}` : ''
					case 'on_air': {
						const target = armed ? (armed.output ? `@${armed.output}` : armed.composition) : undefined
						const id = live ? (target ? live.onAir[target] : Object.values(live.onAir).at(-1)) : undefined
						return self.itemTitle(rundown.items.find((i) => i.id === id))
					}
					default:
						return self.itemTitle(armed)
				}
			},
		},

		/* ----------------------------------------- 0.79: timers and rolls */

		timer_running: {
			name: 'Timer is running (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(0, 120, 40), color: combineRgb(255, 255, 255) },
			options: [clockChannelOption, timerOption],
			unsubscribe,
			callback: (feedback) =>
				self.timerView(`feedback:${feedback.id}`, feedback.options.channel, feedback.options.timer)?.running === true,
		},

		/** The last thirty seconds — or the last N — of a countdown, or N into a count-up. */
		timer_under: {
			name: 'Timer at or under N seconds (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) },
			options: [
				clockChannelOption,
				timerOption,
				{ id: 'seconds', type: 'number', label: 'Seconds', default: 30, min: 0, max: 86400 },
			],
			unsubscribe,
			callback: (feedback) => {
				const view = self.timerView(`feedback:${feedback.id}`, feedback.options.channel, feedback.options.timer)
				return view !== undefined && view.seconds <= Number(feedback.options.seconds ?? 30)
			},
		},

		/** What a timer button prints — the clock as the graphic shows it. */
		timer_value: {
			name: 'Timer — as shown, in seconds, or running (Breeze 0.79+)',
			type: 'value',
			options: [
				clockChannelOption,
				timerOption,
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'text',
					choices: [
						{ id: 'text', label: 'As the graphic shows it — 7:42' },
						{ id: 'seconds', label: 'Whole seconds — 462' },
						{ id: 'running', label: 'Running — true or false' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const view = self.timerView(`feedback:${feedback.id}`, feedback.options.channel, feedback.options.timer)
				if (!view) return ''
				if (feedback.options.show === 'seconds') return String(view.seconds)
				if (feedback.options.show === 'running') return view.running ? 'true' : 'false'
				return view.text
			},
		},

		roll_is: {
			name: 'Roll is running, reversed or at its end (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(0, 120, 40), color: combineRgb(255, 255, 255) },
			options: [
				clockChannelOption,
				rollOption,
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'running',
					choices: [
						{ id: 'running', label: 'Running' },
						{ id: 'reversed', label: 'Running backward' },
						{ id: 'at_end', label: 'At its end' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const view = self.rollView(`feedback:${feedback.id}`, feedback.options.channel, feedback.options.roll)
				if (!view) return false
				if (feedback.options.state === 'reversed') return view.reversed
				if (feedback.options.state === 'at_end') return view.atEnd
				return view.running
			},
		},

		roll_value: {
			name: 'Roll — how far, speed or direction (Breeze 0.79+)',
			type: 'value',
			options: [
				clockChannelOption,
				rollOption,
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'percent',
					choices: [
						{ id: 'percent', label: 'How far through — 42%' },
						{ id: 'percent_number', label: 'How far through, as a number 0–100 — for a gauge' },
						{ id: 'remaining', label: 'Time left at this speed — 1:42' },
						{ id: 'remaining_seconds', label: 'Time left in whole seconds' },
						{ id: 'speed', label: 'Speed — ×1.25' },
						{ id: 'direction', label: 'Direction — forward or backward' },
						{ id: 'state', label: 'State — running, paused or end' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const view = self.rollView(`feedback:${feedback.id}`, feedback.options.channel, feedback.options.roll)
				if (!view) return ''
				switch (feedback.options.show) {
					case 'percent_number':
						return view.percent ?? 0
					case 'remaining':
						return view.remaining === null ? '' : formatMs(view.remaining * 1000, 'm:ss', true)
					case 'remaining_seconds':
						return view.remaining === null ? '' : String(Math.ceil(view.remaining))
					case 'speed':
						return view.speed
					case 'direction':
						return view.reversed ? 'backward' : 'forward'
					case 'state':
						return view.atEnd ? 'end' : view.running ? 'running' : 'paused'
					default:
						return view.percent === null ? '' : `${view.percent}%`
				}
			},
		},

		/**
		 * The output page's debug line, for a button: state, the time into the
		 * composition over its length, and the step — or any one of them. The
		 * time is carried forward between reports while the graphic plays.
		 */
		playhead_value: {
			name: 'Playhead — state, time and step, as the debug view shows them',
			type: 'value',
			options: [
				channelOption,
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'line',
					choices: [
						{ id: 'line', label: 'The debug line — holding t=1.50/2.40s step 1/1' },
						{ id: 'state', label: 'State — idle, playing-in, holding, playing-out, finished' },
						{ id: 'time', label: 'Time — t=1.50/2.40s' },
						{ id: 'seconds', label: 'Time in seconds — 1.50' },
						{ id: 'percent_number', label: 'How far through, as a number 0–100 — for a gauge' },
						{ id: 'step', label: 'Step — 1/1' },
						{ id: 'step_line', label: 'Step with its word — step 1/1' },
						{ id: 'duration', label: 'Length in seconds — 2.40' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const view = self.playheadView(`feedback:${feedback.id}`, feedback.options.channel)
				if (!view) return feedback.options.show === 'percent_number' ? 0 : ''
				const time = `t=${view.time.toFixed(2)}${view.duration !== null ? `/${view.duration.toFixed(2)}` : ''}s`
				const step = `${view.step}/${view.stepCount}`
				switch (feedback.options.show) {
					case 'state':
						return view.state
					case 'time':
						return time
					case 'seconds':
						return view.time.toFixed(2)
					case 'percent_number':
						return view.percent
					case 'step':
						return step
					case 'step_line':
						return `step ${step}`
					case 'duration':
						return view.duration === null ? '' : view.duration.toFixed(2)
					default:
						return `${view.state} ${time} step ${step}`
				}
			},
		},

		/** A colour for a playhead ring: grey idle, green playing in, red holding (on air), amber playing out. */
		playback_color: {
			name: 'Playback — colour by state',
			type: 'value',
			options: [
				channelOption,
				{
					id: 'idle',
					type: 'colorpicker',
					label: 'Idle or finished',
					default: combineRgb(90, 90, 90),
					returnType: 'number',
				},
				{
					id: 'playingIn',
					type: 'colorpicker',
					label: 'Playing in',
					default: combineRgb(0, 200, 80),
					returnType: 'number',
				},
				{
					id: 'holding',
					type: 'colorpicker',
					label: 'Holding (on air)',
					default: combineRgb(230, 0, 0),
					returnType: 'number',
				},
				{
					id: 'playingOut',
					type: 'colorpicker',
					label: 'Playing out',
					default: combineRgb(255, 200, 0),
					returnType: 'number',
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const o = feedback.options
				switch (self.playheadView(`feedback:${feedback.id}`, o.channel)?.state) {
					case 'playing-in':
						return Number(o.playingIn)
					case 'holding':
						return Number(o.holding)
					case 'playing-out':
						return Number(o.playingOut)
					default:
						return Number(o.idle)
				}
			},
		},

		/**
		 * A colour for a roll's progress ring: normal, then a warning colour and
		 * a last-seconds colour as the time left at the current speed runs down
		 * — green, yellow under 30 s, red under 10 s by default. A loop, which
		 * never ends, stays the normal colour.
		 */
		roll_color: {
			name: 'Roll — colour by time left (Breeze 0.79+)',
			type: 'value',
			options: [
				clockChannelOption,
				rollOption,
				{ id: 'warn', type: 'number', label: 'Warning at (seconds left)', default: 30, min: 0, max: 3600 },
				{ id: 'critical', type: 'number', label: 'Last seconds at (seconds left)', default: 10, min: 0, max: 3600 },
				{ id: 'normal', type: 'colorpicker', label: 'Normal', default: combineRgb(0, 200, 80), returnType: 'number' },
				{
					id: 'warnColor',
					type: 'colorpicker',
					label: 'Warning',
					default: combineRgb(255, 200, 0),
					returnType: 'number',
				},
				{
					id: 'criticalColor',
					type: 'colorpicker',
					label: 'Last seconds',
					default: combineRgb(230, 0, 0),
					returnType: 'number',
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const o = feedback.options
				const view = self.rollView(`feedback:${feedback.id}`, o.channel, o.roll)
				const left = view?.remaining
				if (left === null || left === undefined) return Number(o.normal)
				if (left <= Number(o.critical)) return Number(o.criticalColor)
				if (left <= Number(o.warn)) return Number(o.warnColor)
				return Number(o.normal)
			},
		},

		/* --------------------------------------- 0.79: games and polls */

		/** One column of a game table — `homeScore`, `periodLabel`, `homeFouls`. */
		game_value: {
			name: 'Game — a column of a sport game table (Breeze 0.79+)',
			type: 'value',
			options: [
				sourceOption,
				{ id: 'column', type: 'textinput', label: 'Column', default: 'homeScore', useVariables: true },
			],
			unsubscribe,
			callback: (feedback) => {
				const row = self.rowsFor(`feedback:${feedback.id}`, feedback.options.source)?.[0]
				return row ? cellText(row[(feedback.options.column ?? '').trim()]) : ''
			},
		},

		/** For possession, serving or a status: lit while a column holds a value. */
		game_column_is: {
			name: 'Game column is… — possession, serving, status (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(200, 120, 0), color: combineRgb(0, 0, 0) },
			options: [
				sourceOption,
				{ id: 'column', type: 'textinput', label: 'Column', default: 'possession', useVariables: true },
				{ id: 'value', type: 'textinput', label: 'Value', default: 'home', useVariables: true },
			],
			unsubscribe,
			callback: (feedback) => {
				const row = self.rowsFor(`feedback:${feedback.id}`, feedback.options.source)?.[0]
				if (!row) return false
				const value = cellText(row[(feedback.options.column ?? '').trim()])
				return value.toLowerCase() === (feedback.options.value ?? '').trim().toLowerCase()
			},
		},

		/** What a poll button prints: an option's votes or share, or the poll's question, total or status. */
		poll_value: {
			name: 'Poll — votes, percent, question or total (Breeze 0.79+)',
			type: 'value',
			options: [
				sourceOption,
				{
					id: 'option',
					type: 'textinput',
					label: 'Option id (for votes, percent, label and rank)',
					default: '',
					useVariables: true,
				},
				{
					id: 'show',
					type: 'dropdown',
					label: 'Show',
					default: 'votes',
					choices: [
						{ id: 'votes', label: 'Option’s votes' },
						{ id: 'percent', label: 'Option’s percent — 42%' },
						{ id: 'label', label: 'Option’s label' },
						{ id: 'rank', label: 'Option’s rank' },
						{ id: 'leader', label: 'The leading option’s label' },
						{ id: 'question', label: 'Question' },
						{ id: 'total', label: 'Total votes' },
						{ id: 'status', label: 'Open or closed' },
					],
					disableAutoExpression: true,
				},
			],
			unsubscribe,
			callback: (feedback) => {
				const rows = self.rowsFor(`feedback:${feedback.id}`, feedback.options.source)
				if (!rows || rows.length === 0) return ''
				const show = feedback.options.show
				if (show === 'question' || show === 'total' || show === 'status') return cellText(rows[0][show])
				if (show === 'leader') {
					const leaders = rows.filter((r) => r['leader'] === true)
					return leaders.map((r) => cellText(r['label'])).join(' / ')
				}
				const row = rows.find((r) => r['option'] === (feedback.options.option ?? '').trim())
				if (!row) return ''
				if (show === 'percent') return row['percent'] === null ? '' : `${cellText(row['percent'])}%`
				return cellText(row[show === 'label' || show === 'rank' ? show : 'votes'])
			},
		},

		poll_open: {
			name: 'Poll is open (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(0, 120, 40), color: combineRgb(255, 255, 255) },
			options: [sourceOption],
			unsubscribe,
			callback: (feedback) =>
				self.rowsFor(`feedback:${feedback.id}`, feedback.options.source)?.[0]?.['status'] === 'open',
		},

		/** An option is leading, or tied for the lead. */
		poll_leading: {
			name: 'Poll option is leading (Breeze 0.79+)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(200, 120, 0), color: combineRgb(0, 0, 0) },
			options: [sourceOption, { id: 'option', type: 'textinput', label: 'Option id', default: '', useVariables: true }],
			unsubscribe,
			callback: (feedback) => {
				const rows = self.rowsFor(`feedback:${feedback.id}`, feedback.options.source)
				const row = rows?.find((r) => r['option'] === (feedback.options.option ?? '').trim())
				return row?.['leader'] === true
			},
		},
	})
}
