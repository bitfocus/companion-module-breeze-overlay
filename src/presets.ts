// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Ready-made buttons, one set per addressable graphic.
 *
 * Built from `GET /api/channels`, which lists every scene and scene element on
 * the server in a single request — presets need to enumerate everything, and
 * doing that per project would be an N+1 against a server that is also feeding
 * graphics to air.
 *
 * Only the channels belonging to this connection's project get presets. A
 * connection is configured for one project, and offering buttons that silently
 * address a different one is how a graphic goes to air in the wrong show.
 */

import { ButtonGraphicsDecorationType, combineRgb } from '@companion-module/base'
import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'

import type { ChannelRef } from './api.js'
import type { FieldSpec } from './catalogue.js'
import { listedTables } from './tables.js'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const RED = combineRgb(200, 0, 0)
const GREEN = combineRgb(0, 120, 40)
const AMBER = combineRgb(150, 90, 0)

/**
 * Companion preset ids must be stable across restarts, or a button a user has
 * already placed loses its link to the preset it came from. The channel name is
 * the stable thing here — it is the address, and Breeze does not let it be
 * renamed.
 */
const idFor = (channel: string, verb: string) => `${channel}__${verb}`

/**
 * Button text: the graphic's name, a real newline, then the verb.
 *
 * A literal `\n` two-character sequence would depend on Companion parsing
 * escapes in button text, which its types do not promise. An actual newline
 * cannot be misread. Wrapping is left to `size: 'auto'`, which shrinks text to
 * fit — mangling every space into a line break turned "World Cup — Tournament
 * scene" into five lines on a 72px button.
 */
const buttonText = (name: string, verb: string) => `${name}\n${verb}`

/** Most items a rundown gets an Arm button for — a service of names, not a database. */
const MAX_ITEM_PRESETS = 100

/** A preset id part from any name: safe characters plus a hash, so `a.b` and `a_b` stay apart. */
const idPart = (name: string) => `${name.replace(/[^A-Za-z0-9_-]/g, '_')}_${nameHash(name)}`

type Presets = CompanionPresetDefinitions<ModuleSchema>

/**
 * Timer buttons for one channel or output (Breeze 0.79+): start/pause showing
 * the clock, reset, and ±10 / ±1 seconds. The clock is a local variable fed by
 * the Timer value feedback, so each button shows its own timer.
 */
function timerPresets(presets: Presets, base: string, channel: string, label: string, ids: string[]): string[] {
	const out: string[] = []
	for (const id of ids) {
		const key = `${base}__timer__${idPart(id)}`
		const opts = { channel, timer: id }
		presets[`${key}__toggle`] = {
			type: 'simple',
			name: `${label} — timer ${id} START/PAUSE`,
			style: { text: `${id}\n$(local:clock)`, size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'timer', options: { ...opts, action: 'toggle', value: '' } }], up: [] }],
			feedbacks: [{ feedbackId: 'timer_running', options: opts, style: { bgcolor: GREEN, color: WHITE } }],
			localVariables: [
				{
					variableType: 'feedback',
					variableName: 'clock',
					feedbackId: 'timer_value',
					options: { ...opts, show: 'text' },
				},
			],
		}
		out.push(`${key}__toggle`)
		const step = (suffix: string, text: string, action: string, value: string) => {
			presets[`${key}__${suffix}`] = {
				type: 'simple',
				name: `${label} — timer ${id} ${text.replace('\n', ' ')}`,
				style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'timer', options: { ...opts, action, value } }], up: [] }],
				feedbacks: [],
			}
			out.push(`${key}__${suffix}`)
		}
		step('reset', `${id}\nRESET`, 'reset', '')
		step('plus10', `${id}\n+10`, 'add', '10')
		step('minus10', `${id}\n−10`, 'add', '-10')
		step('plus1', `${id}\n+1`, 'add', '1')
		step('minus1', `${id}\n−1`, 'add', '-1')
	}
	return out
}

/**
 * Roll transport for one channel or output (Breeze 0.79+): play/pause showing
 * how far, backward, forward, slower, faster showing the speed, restart, end.
 */
function rollPresets(presets: Presets, base: string, channel: string, label: string, ids: string[]): string[] {
	const out: string[] = []
	for (const id of ids) {
		const key = `${base}__roll__${idPart(id)}`
		const opts = { channel, roll: id }
		presets[`${key}__toggle`] = {
			type: 'simple',
			name: `${label} — roll ${id} PLAY/PAUSE`,
			style: { text: `${id} ⏯\n$(local:pos)`, size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'scroll', options: { ...opts, action: 'toggle', value: '' } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'roll_is', options: { ...opts, state: 'running' }, style: { bgcolor: GREEN, color: WHITE } },
			],
			localVariables: [
				{
					variableType: 'feedback',
					variableName: 'pos',
					feedbackId: 'roll_value',
					options: { ...opts, show: 'percent' },
				},
			],
		}
		out.push(`${key}__toggle`)

		/*
		 * PROGRESS: a ring that fills as the roll does, in step with the control
		 * panel's position bar, the time left in the middle, and a colour that
		 * turns as the end comes (the Roll colour feedback: green, yellow under
		 * 30 s, red under 10 s — change them on the button). Pressing it plays
		 * or pauses. A plain text button for a host that cannot draw layers.
		 */
		const progressVars = [
			{
				variableType: 'feedback' as const,
				variableName: 'pct',
				feedbackId: 'roll_value' as const,
				options: { ...opts, show: 'percent_number' },
			},
			{
				variableType: 'feedback' as const,
				variableName: 'left',
				feedbackId: 'roll_value' as const,
				options: { ...opts, show: 'remaining' },
			},
			{
				variableType: 'feedback' as const,
				variableName: 'ringcolor',
				feedbackId: 'roll_color' as const,
				options: {
					...opts,
					warn: 30,
					critical: 10,
					normal: combineRgb(0, 200, 80),
					warnColor: combineRgb(255, 200, 0),
					criticalColor: combineRgb(230, 0, 0),
				},
			},
		]
		const progressSteps = [
			{ down: [{ actionId: 'scroll' as const, options: { ...opts, action: 'toggle', value: '' } }], up: [] },
		]
		presets[`${key}__progress`] = {
			type: 'alternatives',
			variants: [
				{
					type: 'layered',
					name: `${label} — roll ${id} PROGRESS`,
					keywords: ['roll', 'progress', 'credits', 'time left'],
					canvas: { decoration: ButtonGraphicsDecorationType.None },
					elements: [
						{ type: 'box', id: 'bg', x: 0, y: 0, width: 100, height: 100, color: BLACK },
						{
							type: 'gauge',
							id: 'ring',
							x: 6,
							y: 6,
							width: 88,
							height: 88,
							orientation: 'ring',
							min: 0,
							max: 100,
							value: { isExpression: true, value: '$(local:pct)' },
							ringWidth: 14,
							roundedEnds: true,
							fillEnabled: true,
							multiColour: false,
							stops: [{ value: 0, color: { isExpression: true, value: '$(local:ringcolor)' }, gradient: false }],
							trackStyle: 'dimmed',
							trackAmount: 20,
						},
						{
							type: 'text',
							id: 'left',
							x: 18,
							y: 30,
							width: 64,
							height: 30,
							text: { isExpression: true, value: '$(local:left)' },
							fontsize: 80,
							fontsizeAllowShrink: true,
							color: WHITE,
							halign: 'center',
							valign: 'center',
						},
						{
							type: 'text',
							id: 'name',
							x: 18,
							y: 60,
							width: 64,
							height: 14,
							text: id,
							fontsize: 90,
							fontsizeAllowShrink: true,
							color: WHITE,
							halign: 'center',
							valign: 'center',
						},
					],
					feedbacks: [],
					steps: progressSteps,
					localVariables: progressVars,
				},
				{
					type: 'simple',
					name: `${label} — roll ${id} PROGRESS`,
					style: { text: `${id}\n$(local:left)`, size: 'auto', color: WHITE, bgcolor: BLACK },
					steps: progressSteps,
					feedbacks: [
						{ feedbackId: 'roll_is', options: { ...opts, state: 'running' }, style: { bgcolor: GREEN, color: WHITE } },
					],
					localVariables: progressVars.slice(1, 2),
				},
			],
		}
		out.push(`${key}__progress`)

		const step = (suffix: string, text: string, action: string, withSpeed = false) => {
			presets[`${key}__${suffix}`] = {
				type: 'simple',
				name: `${label} — roll ${id} ${text.split('\n')[1] ?? text}`,
				style: { text: withSpeed ? `${text}\n$(local:speed)` : text, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'scroll', options: { ...opts, action, value: '' } }], up: [] }],
				feedbacks:
					action === 'backward'
						? [
								{
									feedbackId: 'roll_is',
									options: { ...opts, state: 'reversed' },
									style: { bgcolor: AMBER, color: WHITE },
								},
							]
						: [],
				...(withSpeed
					? {
							localVariables: [
								{
									variableType: 'feedback' as const,
									variableName: 'speed',
									feedbackId: 'roll_value' as const,
									options: { ...opts, show: 'speed' },
								},
							],
						}
					: {}),
			}
			out.push(`${key}__${suffix}`)
		}
		step('backward', `${id}\n◀◀`, 'backward')
		step('forward', `${id}\n▶▶`, 'forward')
		step('slower', `${id}\nSLOWER`, 'slower', true)
		step('faster', `${id}\nFASTER`, 'faster', true)
		step('restart', `${id}\n⏮`, 'restart')
		step('end', `${id}\n⏭`, 'end')
	}
	return out
}

/** The DEBUG status button for one graphic, as a layered ring with a plain-text fallback. */
function debugPreset(presets: Presets, channel: string, label: string): string {
	const id = `${channel}__debug`
	const vars = [
		{
			variableType: 'feedback' as const,
			variableName: 'pct',
			feedbackId: 'playhead_value' as const,
			options: { channel, show: 'percent_number' },
		},
		{
			variableType: 'feedback' as const,
			variableName: 'state',
			feedbackId: 'playhead_value' as const,
			options: { channel, show: 'state' },
		},
		{
			variableType: 'feedback' as const,
			variableName: 'time',
			feedbackId: 'playhead_value' as const,
			options: { channel, show: 'time' },
		},
		{
			variableType: 'feedback' as const,
			variableName: 'step',
			feedbackId: 'playhead_value' as const,
			options: { channel, show: 'step_line' },
		},
		{
			variableType: 'feedback' as const,
			variableName: 'ringcolor',
			feedbackId: 'playback_color' as const,
			options: {
				channel,
				// The feedback's own defaults, so a button placed by hand matches the preset.
				idle: combineRgb(90, 90, 90),
				playingIn: combineRgb(0, 200, 80),
				holding: combineRgb(230, 0, 0),
				playingOut: combineRgb(255, 200, 0),
			},
		},
	]
	const line = (lineId: string, y: number, height: number, text: string) => ({
		type: 'text' as const,
		id: lineId,
		x: 14,
		y,
		width: 72,
		height,
		text: { isExpression: true, value: text },
		fontsize: 90,
		fontsizeAllowShrink: true,
		color: WHITE,
		halign: 'center' as const,
		valign: 'center' as const,
	})
	presets[id] = {
		type: 'alternatives',
		variants: [
			{
				type: 'layered',
				name: `${label} — DEBUG`,
				keywords: ['debug', 'playhead', 'state', 'step', 'time'],
				canvas: { decoration: ButtonGraphicsDecorationType.None },
				elements: [
					{ type: 'box', id: 'bg', x: 0, y: 0, width: 100, height: 100, color: BLACK },
					{
						type: 'gauge',
						id: 'ring',
						x: 4,
						y: 4,
						width: 92,
						height: 92,
						orientation: 'ring',
						min: 0,
						max: 100,
						value: { isExpression: true, value: '$(local:pct)' },
						ringWidth: 10,
						roundedEnds: true,
						fillEnabled: true,
						multiColour: false,
						stops: [{ value: 0, color: { isExpression: true, value: '$(local:ringcolor)' }, gradient: false }],
						trackStyle: 'dimmed',
						trackAmount: 20,
					},
					line('state', 24, 16, '$(local:state)'),
					line('time', 42, 16, '$(local:time)'),
					line('step', 60, 14, '$(local:step)'),
				],
				feedbacks: [],
				steps: [{ down: [], up: [] }],
				localVariables: vars,
			},
			{
				type: 'simple',
				name: `${label} — DEBUG`,
				style: {
					text: `$(local:state)\n$(local:time)\n$(local:step)`,
					size: 'auto',
					color: WHITE,
					bgcolor: BLACK,
				},
				steps: [{ down: [], up: [] }],
				feedbacks: [],
				localVariables: vars.slice(1, 4),
			},
		],
	}
	return id
}

/** Buttons for a graphic's typed fields (Breeze 0.79+): ± for numbers, a toggle, one per option. */
function fieldPresets(
	presets: Presets,
	base: string,
	channel: string,
	label: string,
	fields: Map<string, FieldSpec>,
): string[] {
	const out: string[] = []
	for (const [name, spec] of fields) {
		const key = `${base}__field__${idPart(name)}`
		const title = spec.label ?? name
		const add = (suffix: string, text: string, how: string, value: string) => {
			presets[`${key}__${suffix}`] = {
				type: 'simple',
				name: `${label} — ${title} ${text.split('\n')[1] ?? ''}`.trim(),
				style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'field', options: { channel, field: name, how, value } }], up: [] }],
				feedbacks: [],
			}
			out.push(`${key}__${suffix}`)
		}
		if (spec.kind === 'number') {
			const steps = [spec.step, ...spec.buttons.filter((b) => b > 0 && b !== spec.step)]
			for (const n of steps) add(`plus${idPart(String(n))}`, `${title}\n+${n}`, 'adjust', String(n))
			add('minus', `${title}\n−${spec.step}`, 'adjust', String(-spec.step))
		} else if (spec.kind === 'boolean') {
			add('toggle', `${title}\nON/OFF`, 'toggle', '')
		} else if (spec.kind === 'enum') {
			for (const option of spec.options)
				add(`opt${idPart(option.value)}`, `${title}\n${option.label}`, 'set', option.value)
		}
	}
	return out
}

/** A short, stable hash of a name (djb2), for preset ids. */
function nameHash(name: string): string {
	let h = 5381
	for (const ch of name) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0
	return h.toString(36)
}

export function BuildPresets(self: ModuleInstance, channels: ChannelRef[]): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const sections: CompanionPresetSection<ModuleSchema>[] = []

	for (const entry of channels) {
		const channel = entry.channel
		// Preset names, section names and button text all use this, so a channel
		// with no display name is never listed as " — PLAY".
		const label = entry.name || channel

		/*
		 * PLAY carries the on-air feedback and the missing-source warning.
		 *
		 * The warning is on PLAY rather than on its own button deliberately: it
		 * is the button someone is about to press, and it is the moment the
		 * information matters.
		 */
		presets[idFor(channel, 'play')] = {
			type: 'simple',
			name: `${label} — PLAY`,
			style: { text: buttonText(label, 'PLAY'), size: 'auto', color: WHITE, bgcolor: GREEN },
			steps: [{ down: [{ actionId: 'play', options: { channel } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'on_air',
					options: { channel },
					style: { bgcolor: RED, color: WHITE },
				},
				{
					feedbackId: 'source_connected',
					options: { channel },
					style: { bgcolor: AMBER, color: WHITE },
				},
			],
		}

		presets[idFor(channel, 'stop')] = {
			type: 'simple',
			name: `${label} — STOP`,
			style: { text: buttonText(label, 'STOP'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'stop', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'next')] = {
			type: 'simple',
			name: `${label} — NEXT`,
			style: { text: buttonText(label, 'NEXT'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'next', options: { channel, table: '' } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'clear')] = {
			type: 'simple',
			name: `${label} — CLEAR`,
			style: { text: buttonText(label, 'CLEAR'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'clear', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		const ids = [idFor(channel, 'play'), idFor(channel, 'next'), idFor(channel, 'stop'), idFor(channel, 'clear')]

		/*
		 * PREV only where the server has it (0.74+). The presets are rebuilt when
		 * the server's version changes, so an upgrade brings the button in; an
		 * older server is not offered one that would be refused on every press.
		 */
		if (self.supports('prev') === true) {
			presets[idFor(channel, 'prev')] = {
				type: 'simple',
				name: `${label} — PREV`,
				style: { text: buttonText(label, 'PREV'), size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'prev', options: { channel, table: '' } }], up: [] }],
				feedbacks: [],
			}
			ids.splice(1, 0, idFor(channel, 'prev'))
		}

		// CLEAR ALL only where it means something. On a plain scene it is the
		// same as CLEAR, and a button that duplicates its neighbour invites the
		// wrong one being pressed.
		const isScene = entry.sceneId === null
		if (isScene) {
			presets[idFor(channel, 'clear_all')] = {
				type: 'simple',
				name: `${label} — CLEAR ALL`,
				style: { text: buttonText(label, 'CLR ALL'), size: 'auto', color: WHITE, bgcolor: combineRgb(120, 0, 0) },
				steps: [{ down: [{ actionId: 'clear_all', options: { channel } }], up: [] }],
				feedbacks: [],
			}
			ids.push(idFor(channel, 'clear_all'))
		}

		/*
		 * PAGE: a status button for each table the graphic was built to page —
		 * the page showing and its key, e.g. "2/2" over "Peoria Pioneers".
		 * Pressing it does nothing; it only reports.
		 *
		 * Offered only where `/api/channels` lists a paged table (Breeze 0.77+),
		 * so a graphic with nothing to page gets no button that would sit blank.
		 * The two lines are local variables fed by the Table page feedback, so
		 * each button watches its own graphic rather than the connection default.
		 */
		const tables = listedTables(entry)
		for (const table of tables) {
			const id = `${channel}__page__${table.table.replace(/[^A-Za-z0-9_-]/g, '_')}__${nameHash(table.table)}`
			// With one table the graphic's name says which; with several, the table's.
			const title = tables.length > 1 ? table.name : label
			presets[id] = {
				type: 'simple',
				name: tables.length > 1 ? `${label} — PAGE (${table.name})` : `${label} — PAGE`,
				style: { text: `${title}\n$(local:page)\n$(local:key)`, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [], up: [] }],
				feedbacks: [],
				localVariables: [
					{
						variableType: 'feedback',
						variableName: 'page',
						feedbackId: 'table_page',
						options: { channel, table: table.table, show: 'page' },
					},
					{
						variableType: 'feedback',
						variableName: 'key',
						feedbackId: 'table_page',
						options: { channel, table: table.table, show: 'key' },
					},
				],
			}
			ids.push(id)
		}

		/*
		 * DEBUG: the output page's debug overlay on a button — a ring for the
		 * playhead through the composition, coloured by state, with the state,
		 * `t=` and the step inside. Pressing it does nothing.
		 */
		ids.push(debugPreset(presets, channel, label))

		/*
		 * Timers, rolls and typed fields (Breeze 0.79+), in the graphic's own
		 * section: they belong to the channel they run on.
		 */
		if (self.supports('timers') === true) {
			const base = `${channel}__clk`
			ids.push(...timerPresets(presets, base, channel, label, self.timerIds(channel)))
			ids.push(...rollPresets(presets, base, channel, label, self.rollIds(channel)))
			const fields = self.compositionFor(channel)?.fields
			if (fields && fields.size > 0) ids.push(...fieldPresets(presets, base, channel, label, fields))
		}

		sections.push({
			id: `channel-${channel}`,
			name: entry.sceneId ? `${label} (element of ${entry.sceneId})` : label,
			description: `Channel ${channel}`,
			keywords: [channel, entry.name, entry.ref].filter(Boolean),
			definitions: ids,
		})
	}

	/*
	 * One BACKUP button per data source that has a backup (Breeze 0.74+).
	 * Toggles between the backup and automatic, and lights while the backup is
	 * on air for any reason — an operator's press or the source's own rules —
	 * because either way the rows on air are not the source's own.
	 */
	const backed = self.backedSources()
	if (backed.length > 0) {
		const ids: string[] = []
		for (const source of backed) {
			const id = `source__${source.def.id}__backup`
			presets[id] = {
				type: 'simple',
				name: `${source.def.name} — BACKUP`,
				style: { text: buttonText(source.def.name, 'BACKUP'), size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'source_use', options: { source: source.def.id, mode: 'toggle' } }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'source_state',
						options: { source: source.def.id, state: 'backup' },
						style: { bgcolor: AMBER, color: WHITE },
					},
				],
			}
			ids.push(id)
		}
		sections.push({
			id: 'data-sources',
			name: 'Data sources',
			description: 'Put a source’s backup on air, and see when it is',
			keywords: ['backup', 'data', 'source', 'fallback'],
			definitions: ids,
		})
	}

	/*
	 * One CHECK button per camera list (Breeze 0.74+, Wave 8): checks every
	 * camera now, and lights red while any camera is down.
	 */
	const cameraLists = self.mediaSources()
	if (cameraLists.length > 0) {
		const ids: string[] = []
		for (const source of cameraLists) {
			const id = `media__${source.def.id.replace(/[^A-Za-z0-9_-]/g, '_')}__check`
			presets[id] = {
				type: 'simple',
				name: `${source.def.name} — CHECK CAMERAS`,
				style: { text: buttonText(source.def.name, 'CAMERAS'), size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'media_check', options: { source: source.def.id } }], up: [] }],
				feedbacks: [
					{
						feedbackId: 'media_state',
						options: { source: source.def.id, state: 'down' },
						style: { bgcolor: RED, color: WHITE },
					},
				],
			}
			ids.push(id)
		}
		sections.push({
			id: 'camera-lists',
			name: 'Camera lists',
			description: 'Check every camera now, and see when one is down',
			keywords: ['camera', 'media', 'webcam', 'stream', 'frozen'],
			definitions: ids,
		})
	}

	/*
	 * One toggle per mode the project's rules name (Breeze 0.74+), lit red
	 * while that mode is on. Rebuilt with the rest at connect, so a mode added
	 * to a rule appears after the connection is saved again.
	 */
	const modes = self.knownModes()
	if (modes.length > 0) {
		const ids: string[] = []
		for (const mode of modes) {
			// A hash of the exact name keeps ids apart where sanitising would not
			// ("First.Alert" and "First Alert" both become First_Alert) and, unlike
			// a position, stays the same when another mode is added.
			const id = `mode__${mode.replace(/[^A-Za-z0-9_-]/g, '_')}__${nameHash(mode)}`
			presets[id] = {
				type: 'simple',
				name: `Mode — ${mode}`,
				style: { text: buttonText(mode, 'MODE'), size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'mode', options: { value: mode, how: 'toggle' } }], up: [] }],
				feedbacks: [{ feedbackId: 'mode_is', options: { mode }, style: { bgcolor: RED, color: WHITE } }],
			}
			ids.push(id)
		}
		sections.push({
			id: 'modes',
			name: 'Modes',
			description: 'Put the whole project into a mode, and see when it is',
			keywords: ['mode', 'first alert', 'alert'],
			definitions: ids,
		})
	}

	if (self.supports('rundowns') === true) sections.push(...rundownSections(self, presets))
	if (self.supports('game') === true) sections.push(...gameSections(self, presets))
	if (self.supports('polls') === true) sections.push(...pollSections(self, presets))

	self.setPresetDefinitions(sections, presets)
}

/**
 * Per rundown: TAKE showing the armed item, ARM NEXT / PREV, OUT, and one Arm
 * button per item, amber while armed and red while on air. Then one section per
 * output the rundowns use: STOP, CLEAR, and the output's timers and rolls,
 * which every graphic mounted on it shares.
 */
function rundownSections(self: ModuleInstance, presets: Presets): CompanionPresetSection<ModuleSchema>[] {
	const sections: CompanionPresetSection<ModuleSchema>[] = []
	for (const rundown of self.rundowns()) {
		const base = `rundown__${rundown.id}`
		const ids: string[] = []
		presets[`${base}__take`] = {
			type: 'simple',
			name: `${rundown.name} — TAKE`,
			style: { text: 'TAKE\n$(local:cued)', size: 'auto', color: WHITE, bgcolor: RED },
			steps: [
				{ down: [{ actionId: 'rundown_take', options: { rundown: rundown.id, item: '', advance: true } }], up: [] },
			],
			feedbacks: [],
			localVariables: [
				{
					variableType: 'feedback',
					variableName: 'cued',
					feedbackId: 'rundown_value',
					options: { rundown: rundown.id, show: 'cued' },
				},
			],
		}
		ids.push(`${base}__take`)
		const verb = (suffix: string, text: string, how: string) => {
			presets[`${base}__${suffix}`] = {
				type: 'simple',
				name: `${rundown.name} — ${text.replace('\n', ' ')}`,
				style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'rundown_arm', options: { rundown: rundown.id, how, item: '' } }], up: [] }],
				feedbacks: [],
			}
			ids.push(`${base}__${suffix}`)
		}
		verb('next', 'ARM\nNEXT', 'next')
		verb('prev', 'ARM\nPREV', 'prev')
		presets[`${base}__out`] = {
			type: 'simple',
			name: `${rundown.name} — OUT`,
			style: { text: 'OUT\n$(local:onair)', size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'rundown_out', options: { rundown: rundown.id, target: '' } }], up: [] }],
			feedbacks: [],
			localVariables: [
				{
					variableType: 'feedback',
					variableName: 'onair',
					feedbackId: 'rundown_value',
					options: { rundown: rundown.id, show: 'on_air' },
				},
			],
		}
		ids.push(`${base}__out`)

		for (const item of rundown.items.slice(0, MAX_ITEM_PRESETS)) {
			const id = `${base}__item__${item.id}`
			const title = self.itemTitle(item)
			presets[id] = {
				type: 'simple',
				name: `${rundown.name} — arm ${title}`,
				style: { text: title, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [
					{ down: [{ actionId: 'rundown_arm', options: { rundown: rundown.id, how: 'item', item: item.id } }], up: [] },
				],
				feedbacks: [
					{
						feedbackId: 'rundown_item',
						options: { rundown: rundown.id, item: item.id, state: 'armed' },
						style: { bgcolor: AMBER, color: WHITE },
					},
					{
						feedbackId: 'rundown_item',
						options: { rundown: rundown.id, item: item.id, state: 'on_air' },
						style: { bgcolor: RED, color: WHITE },
					},
				],
			}
			ids.push(id)
		}
		sections.push({
			id: `rundown-${rundown.id}`,
			name: `Rundown — ${rundown.name}`,
			description: 'Arm an item, then TAKE it to air',
			keywords: ['rundown', 'take', 'cue', 'arm', rundown.name],
			definitions: ids,
		})
	}

	if (self.supports('outputs') === true) {
		for (const output of self.outputNames()) {
			const channel = `@${output}`
			const base = `output__${output}`
			const ids: string[] = []
			for (const [verb, text] of [
				['stop', 'STOP'],
				['clear', 'CLEAR'],
			] as const) {
				presets[`${base}__${verb}`] = {
					type: 'simple',
					name: `@${output} — ${text}`,
					style: { text: buttonText(`@${output}`, text), size: 'auto', color: WHITE, bgcolor: BLACK },
					steps: [{ down: [{ actionId: 'output', options: { output, verb, mount: '' } }], up: [] }],
					feedbacks: [],
				}
				ids.push(`${base}__${verb}`)
			}
			if (self.supports('timers') === true) {
				ids.push(...timerPresets(presets, base, channel, `@${output}`, self.timerIds(channel)))
				ids.push(...rollPresets(presets, base, channel, `@${output}`, self.rollIds(channel)))
			}
			sections.push({
				id: `output-${output}`,
				name: `Output @${output}`,
				description: `/out/<project>/${output} — every graphic the rundowns take onto it`,
				keywords: ['output', output, 'stop', 'clear', 'timer'],
				definitions: ids,
			})
		}
	}
	return sections
}

/**
 * Per sport game table: a score button per side showing the score, one per
 * scoring action per side (or a Point per side for the racket sports),
 * possession, and the period.
 */
function gameSections(self: ModuleInstance, presets: Presets): CompanionPresetSection<ModuleSchema>[] {
	const sections: CompanionPresetSection<ModuleSchema>[] = []
	for (const source of self.gameSources()) {
		const sport = source.def.template ? self.sport(source.def.template.sport) : undefined
		if (!sport) continue
		const sourceId = source.def.id
		const base = `game__${idPart(sourceId)}`
		const ids: string[] = []
		const add = (
			suffix: string,
			name: string,
			text: string,
			options: Record<string, unknown>,
			extra: Partial<Presets[string]> = {},
		) => {
			presets[`${base}__${suffix}`] = {
				type: 'simple',
				name: `${source.def.name} — ${name}`,
				style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [
					{
						down: [
							{
								actionId: 'game',
								options: {
									source: sourceId,
									type: 'score',
									side: 'home',
									scoring: '',
									column: '',
									value: '1',
									...options,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
				...extra,
			} as Presets[string]
			ids.push(`${base}__${suffix}`)
		}
		for (const side of ['home', 'away'] as const) {
			const SIDE = side.toUpperCase()
			// The score itself: pressing it does nothing.
			presets[`${base}__${side}__score`] = {
				type: 'simple',
				name: `${source.def.name} — ${SIDE} score`,
				style: { text: `${SIDE}\n$(local:score)`, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [], up: [] }],
				feedbacks: [
					{
						feedbackId: 'game_column_is',
						options: { source: sourceId, column: 'possession', value: side },
						style: { bgcolor: AMBER, color: WHITE },
					},
				],
				localVariables: [
					{
						variableType: 'feedback',
						variableName: 'score',
						feedbackId: 'game_value',
						options: { source: sourceId, column: `${side}Score` },
					},
				],
			}
			ids.push(`${base}__${side}__score`)
			if (sport.scoring === 'points' || sport.scoring === 'cricket') {
				for (const action of sport.actions) {
					add(`${side}__${idPart(action.id)}`, `${SIDE} ${action.label}`, `${SIDE}\n${action.label}`, {
						side,
						scoring: action.id,
					})
				}
			} else {
				add(`${side}__point`, `${SIDE} point`, `${SIDE}\nPOINT`, { type: 'point', side })
			}
			add(
				`${side}__possession`,
				`${SIDE} possession`,
				`${SIDE}\nPOSS`,
				{
					type: 'set',
					column: 'possession',
					value: side,
				},
				{
					feedbacks: [
						{
							feedbackId: 'game_column_is',
							options: { source: sourceId, column: 'possession', value: side },
							style: { bgcolor: AMBER, color: WHITE },
						},
					],
				},
			)
		}
		const period = {
			localVariables: [
				{
					variableType: 'feedback' as const,
					variableName: 'period',
					feedbackId: 'game_value' as const,
					options: { source: sourceId, column: 'periodLabel' },
				},
			],
		}
		add('period__prev', 'previous period', '◀ PERIOD\n$(local:period)', { type: 'period', value: '-1' }, period)
		add('period__next', 'next period', 'PERIOD ▶\n$(local:period)', { type: 'period', value: '1' }, period)
		sections.push({
			id: `game-${idPart(sourceId)}`,
			name: `Game — ${source.def.name}`,
			description: 'Score, possession and period for a sport game table',
			keywords: ['game', 'score', 'sport', sport.id, 'period', 'possession'],
			definitions: ids,
		})
	}
	return sections
}

/** Per poll: a vote button per option showing its count (amber while leading), a −1, open/close and reset. */
function pollSections(self: ModuleInstance, presets: Presets): CompanionPresetSection<ModuleSchema>[] {
	const sections: CompanionPresetSection<ModuleSchema>[] = []
	for (const source of self.pollList()) {
		const sourceId = source.def.id
		const base = `poll__${idPart(sourceId)}`
		const ids: string[] = []
		for (const option of source.def.options ?? []) {
			const key = `${base}__${idPart(option.id)}`
			presets[`${key}__vote`] = {
				type: 'simple',
				name: `${source.def.name} — vote ${option.label}`,
				style: { text: `${option.label}\n$(local:votes)`, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [
					{
						down: [{ actionId: 'poll', options: { source: sourceId, type: 'vote', option: option.id, value: '1' } }],
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'poll_leading',
						options: { source: sourceId, option: option.id },
						style: { bgcolor: AMBER, color: WHITE },
					},
				],
				localVariables: [
					{
						variableType: 'feedback',
						variableName: 'votes',
						feedbackId: 'poll_value',
						options: { source: sourceId, option: option.id, show: 'votes' },
					},
				],
			}
			presets[`${key}__unvote`] = {
				type: 'simple',
				name: `${source.def.name} — take a vote off ${option.label}`,
				style: { text: `${option.label}\n−1`, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [
					{
						down: [{ actionId: 'poll', options: { source: sourceId, type: 'vote', option: option.id, value: '-1' } }],
						up: [],
					},
				],
				feedbacks: [],
			}
			ids.push(`${key}__vote`, `${key}__unvote`)
		}
		presets[`${base}__toggle`] = {
			type: 'simple',
			name: `${source.def.name} — OPEN/CLOSE`,
			style: { text: 'POLL\nOPEN/CLOSE', size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [
				{ down: [{ actionId: 'poll', options: { source: sourceId, type: 'toggle', option: '', value: '' } }], up: [] },
			],
			feedbacks: [{ feedbackId: 'poll_open', options: { source: sourceId }, style: { bgcolor: GREEN, color: WHITE } }],
		}
		presets[`${base}__reset`] = {
			type: 'simple',
			name: `${source.def.name} — RESET`,
			style: { text: 'POLL\nRESET', size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [
				{ down: [{ actionId: 'poll', options: { source: sourceId, type: 'reset', option: '', value: '' } }], up: [] },
			],
			feedbacks: [],
		}
		ids.push(`${base}__toggle`, `${base}__reset`)
		sections.push({
			id: `poll-${idPart(sourceId)}`,
			name: `Poll — ${source.def.name}`,
			description: source.def.question ?? 'Tally a poll',
			keywords: ['poll', 'vote', 'tally'],
			definitions: ids,
		})
	}
	return sections
}
