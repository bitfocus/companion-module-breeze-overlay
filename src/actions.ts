// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import { BreezeError, type PageTarget, type VerbResult } from './api.js'
import type ModuleInstance from './main.js'
import { toggleUse } from './sources.js'
import { findTable } from './tables.js'
import type { Feature } from './versions.js'

export type ActionsSchema = {
	play: { options: { channel: string } }
	next: { options: { channel: string; table: string } }
	prev: { options: { channel: string; table: string } }
	stop: { options: { channel: string } }
	clear: { options: { channel: string } }
	clear_all: { options: { channel: string } }
	update: { options: { channel: string; fields: string } }
	page: { options: { channel: string; table: string; by: string; page: string } }
	cycle: { options: { channel: string; table: string; state: string } }
	source_use: { options: { source: string; mode: string } }
	media_check: { options: { source: string } }
	mode: { options: { value: string; how: string } }
	rundown_take: { options: { rundown: string; item: string; advance: boolean } }
	rundown_arm: { options: { rundown: string; how: string; item: string } }
	rundown_out: { options: { rundown: string; target: string } }
	output: { options: { output: string; verb: string; mount: string } }
	timer: { options: { channel: string; timer: string; action: string; value: string } }
	scroll: { options: { channel: string; roll: string; action: string; value: string } }
	game: { options: { source: string; type: string; side: string; scoring: string; column: string; value: string } }
	poll: { options: { source: string; type: string; option: string; value: string } }
	field: { options: { channel: string; field: string; how: string; value: string } }
}

/** Timer actions Breeze takes, with their labels. */
export const TIMER_ACTIONS = [
	{ id: 'toggle', label: 'Start / pause' },
	{ id: 'start', label: 'Start' },
	{ id: 'pause', label: 'Pause' },
	{ id: 'reset', label: 'Reset' },
	{ id: 'set', label: 'Set to… (Value, e.g. 8:00)' },
	{ id: 'add', label: 'Add or take away… (Value, e.g. 10 or -10)' },
] as const

/** Roll transport actions, with their labels. */
export const SCROLL_ACTIONS = [
	{ id: 'toggle', label: 'Play / pause' },
	{ id: 'play', label: 'Play' },
	{ id: 'pause', label: 'Pause' },
	{ id: 'forward', label: 'Run forward' },
	{ id: 'backward', label: 'Run backward' },
	{ id: 'reverse', label: 'Reverse direction' },
	{ id: 'faster', label: 'Faster' },
	{ id: 'slower', label: 'Slower' },
	{ id: 'speed', label: 'Speed ×… (Value, e.g. 1.5)' },
	{ id: 'jog', label: 'Jog… (Value in seconds, e.g. -3)' },
	{ id: 'seek', label: 'Go to… (Value, e.g. 1:30 or 50%)' },
	{ id: 'restart', label: 'Back to the start' },
	{ id: 'end', label: 'To the end' },
	{ id: 'reset', label: 'Reset to as designed' },
] as const

/** Actions that need a Value; the rest send none. */
const TIMER_VALUE = new Set(['set', 'add'])
const SCROLL_VALUE = new Set(['speed', 'jog', 'seek'])

/**
 * A typed field's value as Breeze stores it: a number field takes a number,
 * an on/off field a boolean, everything else the text as typed.
 */
export function typedValue(kind: string | undefined, raw: string): unknown {
	const value = raw.trim()
	if (kind === 'number') {
		const n = Number(value)
		return value !== '' && Number.isFinite(n) ? n : null
	}
	if (kind === 'boolean') return ['true', '1', 'on', 'yes'].includes(value.toLowerCase())
	return raw
}

/** Whether a stored value reads as on — what Breeze's own toggle reads. */
export function isOn(value: unknown): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value !== 0
	if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase())
	return false
}

/**
 * Parse the field editor's `name=value` lines.
 *
 * One pair per line rather than a query string: a lower third carries prose,
 * and prose contains ampersands. Split on the *first* `=` only, so a value may
 * contain one — `title=Head of R&D = Research` is a real thing someone types.
 */
export function parseFields(raw: string): Record<string, string> {
	const fields: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		const eq = trimmed.indexOf('=')
		if (eq <= 0) continue
		/*
		 * The value is trimmed too. `name = Jane` is what people type, and a
		 * leading space on a lower third is visible on air — a stray one is far
		 * more likely than a deliberate one.
		 */
		fields[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
	}
	return fields
}

/**
 * Where Go to page is asked to land, or an error sentence.
 *
 * By number, the field must be a whole number from 1: Breeze would answer a
 * `0` or a `2.5` with a 400 anyway, and saying so here names the field that is
 * wrong. By key, anything non-blank goes — keys are whatever the table's key
 * column holds, `Group C` or `Flagstaff` or `85004`.
 */
export function pageTarget(by: string, raw: string): PageTarget | string {
	const value = raw.trim()
	if (by === 'name') return value ? { name: value } : 'no page key given'
	if (!/^\d+$/.test(value) || Number(value) < 1) return `"${value}" is not a page number (1 or more)`
	return { n: Number(value) }
}

export function UpdateActions(self: ModuleInstance): void {
	/**
	 * Send one control call and report honestly.
	 *
	 * `delivered: 0` is the case worth surfacing: the call succeeded and nothing
	 * was listening, so nothing happened on screen. Companion would otherwise
	 * show a perfectly green button for a graphic that never appeared, which is
	 * the exact confusion this module should be removing.
	 *
	 * `signal` is Companion's: it aborts when the press is no longer wanted — the
	 * running actions were cancelled, or the connection is being removed. The
	 * request stops waiting, and nothing is reported for a press nobody is
	 * waiting on any more.
	 */
	const send = async (
		actionId: string,
		channel: string,
		what: string,
		signal: AbortSignal,
		call: (project: string, channel: string) => Promise<VerbResult>,
		feature?: Feature,
	): Promise<void> => {
		// `track`, not just resolve: a blank-channel action placed before any
		// default existed resolved to nothing at subscribe time.
		const target = self.track(actionId, channel)
		if (!target) {
			self.log('warn', `No channel given for ${what}, and no default set in the connection config`)
			return
		}
		if (feature && !self.requireFeature(feature, what)) return

		try {
			const result = await call(target.project, target.channel)
			if (result.delivered === 0) {
				self.log(
					'warn',
					`${what} ${target.project}/${target.channel} reached no browser sources — is the output open in OBS or vMix?`,
				)
			}
			self.commandSucceeded()
			// The graphic has just changed; do not wait up to a poll interval to
			// say so on the button. (Live channels are pushed anyway; this only
			// polls the ones that are not.)
			self.pollNow()
		} catch (error) {
			if (signal.aborted) return
			self.reportError(`${what} ${target.project}/${target.channel}`, error)
		}
	}

	const run = async (actionId: string, channel: string, verb: string, signal: AbortSignal): Promise<void> =>
		send(actionId, channel, verb, signal, async (project, name) =>
			self.api.verb(project, name, verb, undefined, signal),
		)

	/*
	 * `useVariables: true` is all that is needed to support `$(internal:…)` in
	 * these fields. Companion resolves them before the callback runs, so the
	 * option arrives as a plain string — module-base v2 dropped the
	 * `context.parseVariablesInString` that v1 modules had to call by hand.
	 */
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
		label: 'Table (blank = every paged table)',
		description: 'A table’s binding name, its layer id, or its cycle group. Needs Breeze 0.74 or later when set.',
		default: '',
		useVariables: true,
	}

	/*
	 * Placed actions claim their channel so its state is watched — that is what
	 * keeps the default-channel variables live for a button with no feedback.
	 * `unsubscribe` fires when the action is removed, disabled or its channel
	 * edited, and releases the claim; without it a deleted button's channel
	 * would be watched for the life of the connection.
	 */
	const hooks = {
		optionsToMonitorForSubscribe: ['channel' as const],
		subscribe: (action: { id: string; options: { channel: string } }) => {
			self.track(`action:${action.id}`, action.options.channel)
		},
		unsubscribe: (action: { id: string }) => {
			self.untrack(`action:${action.id}`)
		},
	}

	/** An output's timers and rolls are the output's: `@main` as the channel reaches them. */
	const clockChannelOption = {
		...channelOption,
		label: 'Channel — a graphic, or @output (blank = connection default)',
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

	/**
	 * Send a rundown verb, and take the armed item the server answers with so
	 * the next press reads it. TAKE reaching no output is said, as PLAY's is.
	 */
	const rundownVerb = async (
		raw: string | undefined,
		verb: 'cue' | 'next' | 'prev' | 'take' | 'out',
		body: Record<string, unknown>,
		what: string,
		signal: AbortSignal,
	): Promise<void> => {
		const project = self.config.project?.trim() ?? ''
		const rundown = self.rundownId(raw)
		if (!project || !rundown) {
			self.log('warn', `${what}: no project in the connection config, or no rundown in it, so nothing was sent`)
			return
		}
		if (!self.requireFeature('rundowns', 'Rundowns')) return
		try {
			const result = await self.api.rundownVerb(project, rundown, verb, body, signal)
			if (verb === 'take' && result.delivered === 0) {
				self.log('warn', `${what} in ${rundown} reached no browser sources — is the output open in OBS or vMix?`)
			}
			self.commandSucceeded()
			self.noteArmed(rundown, result.armed)
		} catch (error) {
			if (signal.aborted) return
			// 409 is Breeze's "nothing is armed": an operator's slip, not a fault.
			if (error instanceof BreezeError && error.status === 409) {
				self.log('warn', `${what}: nothing is armed in ${rundown}`)
				return
			}
			self.reportError(`${what} in ${rundown}`, error)
		}
	}

	self.setActionDefinitions({
		play: {
			name: 'PLAY — roll in, or advance to the next hold',
			options: [channelOption],
			...hooks,
			callback: async (event, context) => run(`action:${event.id}`, event.options.channel, 'play', context.signal),
		},
		next: {
			name: 'NEXT — next page of a paged table while holding, otherwise the next hold',
			options: [channelOption, tableOption],
			...hooks,
			callback: async (event, context) => {
				const table = event.options.table?.trim() ?? ''
				// A plain NEXT stays exactly the request every server version
				// understands; only an aimed one needs 0.74.
				await send(
					`action:${event.id}`,
					event.options.channel,
					table ? `NEXT on table ${table}` : 'next',
					context.signal,
					async (project, channel) => self.api.verb(project, channel, 'next', table || undefined, context.signal),
					table ? 'prev' : undefined,
				)
			},
		},
		prev: {
			name: 'PREV — previous page while holding, otherwise back to the previous hold',
			description: 'Never takes a graphic off air. Needs Breeze 0.74 or later.',
			options: [channelOption, tableOption],
			...hooks,
			callback: async (event, context) => {
				const table = event.options.table?.trim() ?? ''
				await send(
					`action:${event.id}`,
					event.options.channel,
					table ? `PREV on table ${table}` : 'prev',
					context.signal,
					async (project, channel) => self.api.verb(project, channel, 'prev', table || undefined, context.signal),
					'prev',
				)
			},
		},
		stop: {
			name: 'STOP — run the outro',
			options: [channelOption],
			...hooks,
			callback: async (event, context) => run(`action:${event.id}`, event.options.channel, 'stop', context.signal),
		},
		clear: {
			name: 'CLEAR — hard reset, nothing on screen',
			options: [channelOption],
			...hooks,
			callback: async (event, context) => run(`action:${event.id}`, event.options.channel, 'clear', context.signal),
		},
		clear_all: {
			name: 'CLEAR ALL — every element of a scene down at once',
			options: [channelOption],
			...hooks,
			callback: async (event, context) => run(`action:${event.id}`, event.options.channel, 'clear-all', context.signal),
		},
		update: {
			name: 'Update fields on air',
			options: [
				channelOption,
				{
					id: 'fields',
					type: 'textinput',
					label: 'Fields, one name=value per line',
					default: 'name=Jane Doe\ntitle=Reporter',
					useVariables: true,
					multiline: true,
				},
			],
			...hooks,
			callback: async (event, context) => {
				const fields = parseFields(event.options.fields)
				if (Object.keys(fields).length === 0) {
					// Still claim the channel, so the variables follow this button.
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', 'Update had no name=value lines, so nothing was sent')
					return
				}
				await send(`action:${event.id}`, event.options.channel, 'update', context.signal, async (project, channel) =>
					self.api.update(project, channel, fields, context.signal),
				)
			},
		},

		/**
		 * Jump a paged table to one page.
		 *
		 * Works whether or not the graphic is on air: choosing Group C before
		 * rolling in is a real operator move, and the table opens on it. No
		 * result value — the call is delivered to the output page and answered
		 * before the page has turned, so the server cannot say where it landed;
		 * the `page` and `page_key` variables do, a moment later.
		 */
		page: {
			name: 'Go to page — a paged table, by number or by key',
			description: 'Needs Breeze 0.74 or later.',
			options: [
				channelOption,
				tableOption,
				{
					id: 'by',
					type: 'dropdown',
					label: 'Go to',
					default: 'number',
					choices: [
						{ id: 'number', label: 'Page number (from 1)' },
						{ id: 'name', label: 'Page key — the value in the table’s key column' },
					],
					// Chooses how the next field is read, so it is never an expression.
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
			...hooks,
			callback: async (event, context) => {
				const target = pageTarget(event.options.by, event.options.page ?? '')
				if (typeof target === 'string') {
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', `Go to page: ${target}, so nothing was sent`)
					return
				}
				const table = event.options.table?.trim() || undefined
				const label = 'n' in target ? `page ${target.n}` : `page "${target.name}"`
				await send(
					`action:${event.id}`,
					event.options.channel,
					`Go to ${label}`,
					context.signal,
					async (project, channel) => self.api.page(project, channel, target, table, context.signal),
					'page',
				)
			},
		},

		/**
		 * Freeze a self-paging table on the page it shows, or set it going again.
		 *
		 * Toggle reads the table's last reported state: any matching table still
		 * cycling means hold, otherwise resume. With no report yet it holds —
		 * freezing is the safe guess for a button pressed during an interview.
		 */
		cycle: {
			name: 'Cycle — hold or resume a self-paging table',
			description: 'Needs Breeze 0.74 or later.',
			options: [
				channelOption,
				tableOption,
				{
					id: 'state',
					type: 'dropdown',
					label: 'Cycle',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle hold / resume' },
						{ id: 'hold', label: 'Hold — stay on this page' },
						{ id: 'resume', label: 'Resume — carry on from this page' },
					],
					disableAutoExpression: true,
				},
			],
			...hooks,
			callback: async (event, context) => {
				const table = event.options.table?.trim() || undefined
				let state: 'hold' | 'resume' = event.options.state === 'resume' ? 'resume' : 'hold'

				if (event.options.state === 'toggle') {
					const target = self.resolveChannel(event.options.channel)
					const reports = target ? self.cachedState(target)?.playback?.tables : undefined
					const cycles = (table ? findTable(reports, table) : (reports ?? [])).filter((t) => t.hasCycle)
					if (cycles.length > 0 && cycles.every((t) => t.held)) state = 'resume'
				}

				await send(
					`action:${event.id}`,
					event.options.channel,
					`Cycle ${state}${table ? ` on table ${table}` : ''}`,
					context.signal,
					async (project, channel) => self.api.cycle(project, channel, state, table, context.signal),
					'cycle',
				)
			},
		},

		/**
		 * Put a data source's backup on air, or hand it back.
		 *
		 * For a feed that is up and wrong — nothing a guard can see. Addressed
		 * to the connection's project, not a channel: a source feeds every
		 * graphic that reads it. The choice lasts until changed or the server
		 * restarts.
		 */
		source_use: {
			name: 'Data source — use its backup, its own rows, or decide automatically',
			description: 'Needs Breeze 0.74 or later, and a source with a backup set in the editor.',
			options: [
				{
					id: 'source',
					type: 'textinput',
					label: 'Data source id',
					default: '',
					useVariables: true,
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Rows on air',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle backup / automatic' },
						{ id: 'backup', label: 'Backup' },
						{ id: 'primary', label: 'Own rows — even stale or frozen' },
						{ id: 'auto', label: 'Automatic' },
					],
					disableAutoExpression: true,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				const source = event.options.source?.trim() ?? ''
				if (!project || !source) {
					self.log('warn', 'Data source: no project in the connection config, or no source id, so nothing was sent')
					return
				}
				if (!self.requireFeature('sources', 'Data source backup')) return
				const mode =
					event.options.mode === 'toggle'
						? toggleUse(self.sourceFor(source))
						: event.options.mode === 'backup' || event.options.mode === 'primary'
							? event.options.mode
							: 'auto'
				try {
					await self.api.useSource(project, source, mode, context.signal)
					self.commandSucceeded()
					self.pollSourcesNow()
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`Data source ${source} → ${mode}`, error)
				}
			},
		},

		/**
		 * Check every camera in a camera list now (Wave 8) — after one has been
		 * fixed, or before going on air — instead of waiting for its next round.
		 */
		media_check: {
			name: 'Camera list — check every camera now',
			description: 'Needs Breeze 0.74 or later, and a data source with media checks set in the editor.',
			options: [
				{
					id: 'source',
					type: 'textinput',
					label: 'Data source id',
					default: '',
					useVariables: true,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				const source = event.options.source?.trim() ?? ''
				if (!project || !source) {
					self.log('warn', 'Camera check: no project in the connection config, or no source id, so nothing was sent')
					return
				}
				if (!self.requireFeature('media', 'Camera check')) return
				try {
					await self.api.checkMedia(project, source, context.signal)
					self.commandSucceeded()
					self.pollSourcesNow()
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`Camera check ${source}`, error)
				}
			},
		},

		/**
		 * Set the project's mode — First Alert, election night — which every
		 * graphic with a rule for it follows at once. Toggle goes back to no
		 * mode when this one is already set, so one button can be both.
		 */
		mode: {
			name: 'Mode — set, toggle or clear the project mode',
			description:
				'Needs Breeze 0.74 or later. Every graphic in the project with a rule for the mode changes together.',
			options: [
				{
					id: 'value',
					type: 'textinput',
					label: 'Mode',
					default: 'first-alert',
					useVariables: true,
				},
				{
					id: 'how',
					type: 'dropdown',
					label: 'Action',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle this mode / no mode' },
						{ id: 'set', label: 'Set this mode' },
						{ id: 'clear', label: 'Clear — no mode' },
					],
					disableAutoExpression: true,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				if (!project) {
					self.log('warn', 'Mode: no project in the connection config, so nothing was sent')
					return
				}
				if (!self.requireFeature('mode', 'Mode')) return
				const wanted = event.options.value?.trim() ?? ''
				const current = self.currentMode() ?? ''
				const value =
					event.options.how === 'clear'
						? ''
						: event.options.how === 'toggle' && current.toLowerCase() === wanted.toLowerCase()
							? ''
							: wanted
				try {
					const result = await self.api.setMode(project, value, context.signal)
					self.noteMode(result.mode)
					self.commandSucceeded()
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`Mode → ${value || '(none)'}`, error)
				}
			},
		},

		/* ------------------------------------------------ 0.79: rundowns */

		/**
		 * TAKE: the armed item on air, values and PLAY in one command, then the
		 * next item armed — so one button walks a list of fifteen names. An Item
		 * takes that one instead, whatever is armed.
		 */
		rundown_take: {
			name: 'Rundown — TAKE the armed item',
			description: 'Needs Breeze 0.79 or later.',
			options: [
				rundownOption,
				{
					id: 'item',
					type: 'textinput',
					label: 'Item id (blank = the armed item)',
					default: '',
					useVariables: true,
				},
				{
					id: 'advance',
					type: 'checkbox',
					label: 'Arm the next item afterwards',
					default: true,
				},
			],
			callback: async (event, context) => {
				const item = event.options.item?.trim() ?? ''
				await rundownVerb(
					event.options.rundown,
					'take',
					{ ...(item ? { item } : {}), advance: event.options.advance !== false },
					item ? `TAKE ${item}` : 'TAKE',
					context.signal,
				)
			},
		},

		/** Arm the next, the previous or a given item. Nothing changes on air. */
		rundown_arm: {
			name: 'Rundown — arm the next, previous or a given item',
			description: 'Changes nothing on air: TAKE does. Needs Breeze 0.79 or later.',
			options: [
				rundownOption,
				{
					id: 'how',
					type: 'dropdown',
					label: 'Arm',
					default: 'next',
					choices: [
						{ id: 'next', label: 'The next item' },
						{ id: 'prev', label: 'The previous item' },
						{ id: 'item', label: 'This item' },
						{ id: 'none', label: 'Nothing' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'item',
					type: 'textinput',
					label: 'Item id',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:how) == 'item'`,
				},
			],
			callback: async (event, context) => {
				const how = event.options.how
				if (how === 'next' || how === 'prev') {
					await rundownVerb(event.options.rundown, how, {}, `Arm ${how}`, context.signal)
					return
				}
				const item = how === 'item' ? (event.options.item?.trim() ?? '') : ''
				if (how === 'item' && !item) {
					self.log('warn', 'Arm item: no item id given, so nothing was sent')
					return
				}
				await rundownVerb(
					event.options.rundown,
					'cue',
					item ? { item } : {},
					item ? `Arm ${item}` : 'Disarm',
					context.signal,
				)
			},
		},

		/** Take a target off air: the armed item's, or the one named. */
		rundown_out: {
			name: 'Rundown — take a target off air',
			description: 'Runs the outro of what the rundown put there. Needs Breeze 0.79 or later.',
			options: [
				rundownOption,
				{
					id: 'target',
					type: 'textinput',
					label: 'Target — @output or graphic id (blank = the armed item’s)',
					default: '',
					useVariables: true,
				},
			],
			callback: async (event, context) => {
				const target = event.options.target?.trim() ?? ''
				await rundownVerb(
					event.options.rundown,
					'out',
					target ? { target } : {},
					target ? `Take ${target} out` : 'Take out',
					context.signal,
				)
			},
		},

		/**
		 * An output's own verbs: one browser source carrying several graphics.
		 * A Graphic aims at one of them; blank acts on every graphic on it.
		 */
		output: {
			name: 'Output — STOP, NEXT, PREV or CLEAR',
			description: 'Needs Breeze 0.79 or later.',
			options: [
				{
					id: 'output',
					type: 'textinput',
					label: 'Output name (main, not @main)',
					default: 'main',
					useVariables: true,
				},
				{
					id: 'verb',
					type: 'dropdown',
					label: 'Verb',
					default: 'stop',
					choices: [
						{ id: 'stop', label: 'STOP — run the outro' },
						{ id: 'next', label: 'NEXT' },
						{ id: 'prev', label: 'PREV' },
						{ id: 'clear', label: 'CLEAR — off at once, and unmounted' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'mount',
					type: 'textinput',
					label: 'Graphic id on it (blank = every graphic on the output)',
					default: '',
					useVariables: true,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				const output = (event.options.output ?? '').trim().replace(/^@/, '')
				if (!project || !output) {
					self.log('warn', 'Output: no project in the connection config, or no output name, so nothing was sent')
					return
				}
				if (!self.requireFeature('outputs', 'Output verbs')) return
				const verb = (['stop', 'next', 'prev', 'clear'] as const).find((v) => v === event.options.verb) ?? 'stop'
				const mount = event.options.mount?.trim() || undefined
				try {
					const result = await self.api.outputVerb(project, output, verb, mount, context.signal)
					if (result.delivered === 0) {
						self.log('warn', `${verb} on @${output} reached no browser sources — is /out/${project}/${output} open?`)
					}
					self.commandSucceeded()
					self.queueClocks(`${project}/@${output}`)
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`${verb} on @${output}`, error)
				}
			},
		},

		/* ----------------------------------------- 0.79: timers and rolls */

		/**
		 * An operator timer on a graphic, or on an output (`@main`), which every
		 * graphic mounted on it shares. Blank Timer is `main`.
		 */
		timer: {
			name: 'Timer — start, pause, reset, set or add',
			description: 'For a graphic’s timers, or an output’s with @main as the channel. Needs Breeze 0.79 or later.',
			options: [
				clockChannelOption,
				{
					id: 'timer',
					type: 'textinput',
					label: 'Timer id (blank = main)',
					default: '',
					useVariables: true,
				},
				{
					id: 'action',
					type: 'dropdown',
					label: 'Action',
					default: 'toggle',
					choices: TIMER_ACTIONS.map(({ id, label }) => ({ id, label })),
					disableAutoExpression: true,
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:action) == 'set' || $(options:action) == 'add'`,
				},
			],
			...hooks,
			callback: async (event, context) => {
				const action = event.options.action
				const value = TIMER_VALUE.has(action) ? (event.options.value ?? '').trim() : undefined
				if (value === '') {
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', `Timer ${action}: no Value given, so nothing was sent`)
					return
				}
				const id = event.options.timer?.trim() || 'main'
				await send(
					`action:${event.id}`,
					event.options.channel,
					`Timer ${id} ${action}`,
					context.signal,
					async (project, channel) => self.api.timer(project, channel, action, id, value, context.signal),
					'timers',
				)
				const target = self.resolveChannel(event.options.channel)
				if (target) self.queueClocks(`${target.project}/${target.channel}`)
			},
		},

		/** The roll transport: a credits roll or a lyric crawl, from the button. */
		scroll: {
			name: 'Roll — play, pause, direction and speed',
			description: 'For a graphic’s rolls, or an output’s with @main as the channel. Needs Breeze 0.79 or later.',
			options: [
				clockChannelOption,
				{
					id: 'roll',
					type: 'textinput',
					label: 'Roll id (blank = main)',
					default: '',
					useVariables: true,
				},
				{
					id: 'action',
					type: 'dropdown',
					label: 'Action',
					default: 'toggle',
					choices: SCROLL_ACTIONS.map(({ id, label }) => ({ id, label })),
					disableAutoExpression: true,
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:action) == 'speed' || $(options:action) == 'jog' || $(options:action) == 'seek'`,
				},
			],
			...hooks,
			callback: async (event, context) => {
				const action = event.options.action
				const value = SCROLL_VALUE.has(action) ? (event.options.value ?? '').trim() : undefined
				if (value === '') {
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', `Roll ${action}: no Value given, so nothing was sent`)
					return
				}
				const id = event.options.roll?.trim() || 'main'
				await send(
					`action:${event.id}`,
					event.options.channel,
					`Roll ${id} ${action}`,
					context.signal,
					async (project, channel) => self.api.scroll(project, channel, action, id, value, context.signal),
					'scroll',
				)
				const target = self.resolveChannel(event.options.channel)
				if (target) self.queueClocks(`${target.project}/${target.channel}`)
			},
		},

		/* --------------------------------------- 0.79: games and polls */

		/**
		 * A tap on a sport game table: the score, the period and every counter
		 * the sport keeps. Every graphic reading the table follows — the scorebug,
		 * the recap and the lower third show one score.
		 */
		game: {
			name: 'Game — score, period, or a column of a sport game table',
			description: 'Needs Breeze 0.79 or later, and a game table made from a sport template.',
			options: [
				sourceOption,
				{
					id: 'type',
					type: 'dropdown',
					label: 'Action',
					default: 'score',
					choices: [
						{ id: 'score', label: 'Score — a scoring action (e.g. 3PT, TD, try)' },
						{ id: 'unscore', label: 'Take back a scoring action' },
						{ id: 'point', label: 'Point to a side (racket sports)' },
						{ id: 'period', label: 'Period — next or previous (Value 1 or -1)' },
						{ id: 'adjust', label: 'Add to a column (Value, e.g. 1 or -1)' },
						{ id: 'set', label: 'Set a column (Value)' },
						{ id: 'reset', label: 'Reset the game' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'side',
					type: 'dropdown',
					label: 'Side',
					default: 'home',
					choices: [
						{ id: 'home', label: 'Home' },
						{ id: 'away', label: 'Away' },
					],
					disableAutoExpression: true,
					isVisibleExpression: `$(options:type) == 'score' || $(options:type) == 'unscore' || $(options:type) == 'point'`,
				},
				{
					id: 'scoring',
					type: 'textinput',
					label: 'Scoring action id (as the sport names it, e.g. 3pt)',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:type) == 'score' || $(options:type) == 'unscore'`,
				},
				{
					id: 'column',
					type: 'textinput',
					label: 'Column (e.g. homeFouls, possession)',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:type) == 'adjust' || $(options:type) == 'set'`,
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '1',
					useVariables: true,
					isVisibleExpression: `$(options:type) == 'adjust' || $(options:type) == 'set' || $(options:type) == 'period'`,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				const source = event.options.source?.trim() ?? ''
				if (!project || !source) {
					self.log('warn', 'Game: no project in the connection config, or no source id, so nothing was sent')
					return
				}
				if (!self.requireFeature('game', 'Game')) return
				const o = event.options
				const raw = (o.value ?? '').trim()
				let action: Record<string, unknown>
				switch (o.type) {
					case 'score':
					case 'unscore':
						if (!o.scoring?.trim()) {
							self.log('warn', 'Game: no scoring action id given, so nothing was sent')
							return
						}
						action = { type: o.type, side: o.side, action: o.scoring.trim() }
						break
					case 'point':
						action = { type: 'point', side: o.side }
						break
					case 'period':
						action = { type: 'period', delta: Number(raw) < 0 ? -1 : 1 }
						break
					case 'adjust': {
						const delta = Number(raw)
						if (!o.column?.trim() || raw === '' || !Number.isFinite(delta)) {
							self.log('warn', 'Game: Add needs a column and a number, so nothing was sent')
							return
						}
						action = { type: 'adjust', column: o.column.trim(), delta }
						break
					}
					case 'set': {
						if (!o.column?.trim()) {
							self.log('warn', 'Game: Set needs a column, so nothing was sent')
							return
						}
						const n = Number(raw)
						action = { type: 'set', column: o.column.trim(), value: raw !== '' && Number.isFinite(n) ? n : raw }
						break
					}
					default:
						action = { type: 'reset' }
				}
				try {
					const row = await self.api.game(project, source, action, context.signal)
					self.commandSucceeded()
					if (row) {
						const rows = self.rowsFor(`action:${event.id}`, source) ?? []
						self.noteRows(source, [row, ...rows.slice(1)])
					}
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`Game ${source} ${String(action['type'])}`, error)
				}
			},
		},

		/** Tally a poll from the button: votes come from the operator, never the audience. */
		poll: {
			name: 'Poll — vote, set a count, open, close or reset',
			description: 'Needs Breeze 0.79 or later, and a poll data source.',
			options: [
				sourceOption,
				{
					id: 'type',
					type: 'dropdown',
					label: 'Action',
					default: 'vote',
					choices: [
						{ id: 'vote', label: 'Vote — add to an option (Value, default 1; -1 takes one off)' },
						{ id: 'set', label: 'Set an option’s count (Value)' },
						{ id: 'toggle', label: 'Open / close' },
						{ id: 'open', label: 'Open' },
						{ id: 'close', label: 'Close' },
						{ id: 'reset', label: 'Reset every count to zero' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'option',
					type: 'textinput',
					label: 'Option id',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:type) == 'vote' || $(options:type) == 'set'`,
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '1',
					useVariables: true,
					isVisibleExpression: `$(options:type) == 'vote' || $(options:type) == 'set'`,
				},
			],
			callback: async (event, context) => {
				const project = self.config.project?.trim() ?? ''
				const source = event.options.source?.trim() ?? ''
				if (!project || !source) {
					self.log('warn', 'Poll: no project in the connection config, or no source id, so nothing was sent')
					return
				}
				if (!self.requireFeature('polls', 'Poll')) return
				const o = event.options
				let action: Record<string, unknown>
				if (o.type === 'vote' || o.type === 'set') {
					const option = o.option?.trim() ?? ''
					const raw = (o.value ?? '').trim()
					const n = raw === '' && o.type === 'vote' ? 1 : Number(raw)
					if (!option || !Number.isFinite(n) || (raw === '' && o.type === 'set')) {
						self.log('warn', `Poll ${o.type}: needs an option id and a number, so nothing was sent`)
						return
					}
					action = o.type === 'vote' ? { type: 'vote', option, delta: n } : { type: 'set', option, value: n }
				} else if (o.type === 'toggle') {
					const status = self.rowsFor(`action:${event.id}`, source)?.[0]?.['status']
					action = { type: status === 'open' ? 'close' : 'open' }
				} else {
					action = { type: o.type === 'open' || o.type === 'close' ? o.type : 'reset' }
				}
				try {
					const rows = await self.api.poll(project, source, action, context.signal)
					self.commandSucceeded()
					if (rows) self.noteRows(source, rows)
				} catch (error) {
					if (context.signal.aborted) return
					self.reportError(`Poll ${source} ${String(action['type'])}`, error)
				}
			},
		},

		/* ------------------------------------------- 0.79: typed fields */

		/**
		 * Set, toggle or step one field on air. A toggle or a step reads the
		 * value on air first, so it starts from what the panel or another button
		 * last set, not from what this button last sent.
		 */
		field: {
			name: 'Field — set, toggle or step one field on air',
			description:
				'For a graphic’s typed fields (Breeze 0.79+): a number’s +/−, an on/off toggle, an option. Set works for any field.',
			options: [
				channelOption,
				{
					id: 'field',
					type: 'textinput',
					label: 'Field name (its binding, e.g. homeFouls)',
					default: '',
					useVariables: true,
				},
				{
					id: 'how',
					type: 'dropdown',
					label: 'Action',
					default: 'set',
					choices: [
						{ id: 'set', label: 'Set to Value' },
						{ id: 'adjust', label: 'Add Value to a number (e.g. 1 or -1)' },
						{ id: 'toggle', label: 'Toggle on / off' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
					disableAutoExpression: true,
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:how) == 'set' || $(options:how) == 'adjust'`,
				},
			],
			...hooks,
			callback: async (event, context) => {
				const name = event.options.field?.trim() ?? ''
				if (!name) {
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', 'Field: no field name given, so nothing was sent')
					return
				}
				const how = event.options.how
				const raw = event.options.value ?? ''
				const target = self.resolveChannel(event.options.channel)
				const spec = target ? self.compositionFor(target.channel)?.fields.get(name) : undefined
				const delta = Number(raw.trim())
				const set = how === 'set' ? typedValue(spec?.kind, raw) : undefined
				// Said here, not sent: Breeze would store a typo as the field's value.
				if ((how === 'adjust' && (raw.trim() === '' || !Number.isFinite(delta))) || set === null) {
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', `Field ${name}: "${raw}" is not a number, so nothing was sent`)
					return
				}
				await send(
					`action:${event.id}`,
					event.options.channel,
					`Field ${name} ${how}`,
					context.signal,
					async (project, channel) => {
						let value: unknown
						if (how === 'on' || how === 'off') value = how === 'on'
						else if (how === 'set') value = set
						else {
							const current = (await self.api.fieldValues(project, channel, context.signal))[name]
							value = how === 'toggle' ? !isOn(current) : stepped(spec, current, delta)
						}
						return self.api.update(project, channel, { [name]: value }, context.signal)
					},
				)
			},
		},
	})
}

/** A number field's value after a step, kept inside its min and max and free of float tails. */
function stepped(
	spec: { kind: string; min?: number; max?: number } | undefined,
	current: unknown,
	delta: number,
): number {
	const now = typeof current === 'number' ? current : Number(current)
	const from = Number.isFinite(now)
		? now
		: spec?.kind === 'number' && spec.min !== undefined && spec.min > 0
			? spec.min
			: 0
	const places = Math.max(decimals(from), decimals(delta))
	let next = Number((from + delta).toFixed(places))
	if (spec?.kind === 'number') {
		if (spec.min !== undefined) next = Math.max(spec.min, next)
		if (spec.max !== undefined) next = Math.min(spec.max, next)
	}
	return next
}

function decimals(n: number): number {
	const text = String(n)
	const dot = text.indexOf('.')
	return dot === -1 ? 0 : text.length - dot - 1
}
