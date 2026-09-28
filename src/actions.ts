// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import { InstanceStatus } from '@companion-module/base'

import type { PageTarget, VerbResult } from './api.js'
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
	 */
	const send = async (
		actionId: string,
		channel: string,
		what: string,
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
			self.updateStatus(InstanceStatus.Ok)
			// The graphic has just changed; do not wait up to a poll interval to
			// say so on the button. (Live channels are pushed anyway; this only
			// polls the ones that are not.)
			self.pollNow()
		} catch (error) {
			self.reportError(`${what} ${target.project}/${target.channel}`, error)
		}
	}

	const run = async (actionId: string, channel: string, verb: string): Promise<void> =>
		send(actionId, channel, verb, async (project, name) => self.api.verb(project, name, verb))

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

	self.setActionDefinitions({
		play: {
			name: 'PLAY — roll in, or advance to the next hold',
			options: [channelOption],
			...hooks,
			callback: async (event) => run(`action:${event.id}`, event.options.channel, 'play'),
		},
		next: {
			name: 'NEXT — next page of a paged table while holding, otherwise the next hold',
			options: [channelOption, tableOption],
			...hooks,
			callback: async (event) => {
				const table = event.options.table?.trim() ?? ''
				// A plain NEXT stays exactly the request every server version
				// understands; only an aimed one needs 0.74.
				await send(
					`action:${event.id}`,
					event.options.channel,
					table ? `NEXT on table ${table}` : 'next',
					async (project, channel) => self.api.verb(project, channel, 'next', table || undefined),
					table ? 'prev' : undefined,
				)
			},
		},
		prev: {
			name: 'PREV — previous page while holding, otherwise back to the previous hold',
			description: 'Never takes a graphic off air. Needs Breeze 0.74 or later.',
			options: [channelOption, tableOption],
			...hooks,
			callback: async (event) => {
				const table = event.options.table?.trim() ?? ''
				await send(
					`action:${event.id}`,
					event.options.channel,
					table ? `PREV on table ${table}` : 'prev',
					async (project, channel) => self.api.verb(project, channel, 'prev', table || undefined),
					'prev',
				)
			},
		},
		stop: {
			name: 'STOP — run the outro',
			options: [channelOption],
			...hooks,
			callback: async (event) => run(`action:${event.id}`, event.options.channel, 'stop'),
		},
		clear: {
			name: 'CLEAR — hard reset, nothing on screen',
			options: [channelOption],
			...hooks,
			callback: async (event) => run(`action:${event.id}`, event.options.channel, 'clear'),
		},
		clear_all: {
			name: 'CLEAR ALL — every element of a scene down at once',
			options: [channelOption],
			...hooks,
			callback: async (event) => run(`action:${event.id}`, event.options.channel, 'clear-all'),
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
			callback: async (event) => {
				const fields = parseFields(event.options.fields)
				if (Object.keys(fields).length === 0) {
					// Still claim the channel, so the variables follow this button.
					self.track(`action:${event.id}`, event.options.channel)
					self.log('warn', 'Update had no name=value lines, so nothing was sent')
					return
				}
				await send(`action:${event.id}`, event.options.channel, 'update', async (project, channel) =>
					self.api.update(project, channel, fields),
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
			callback: async (event) => {
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
					async (project, channel) => self.api.page(project, channel, target, table),
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
				},
			],
			...hooks,
			callback: async (event) => {
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
					async (project, channel) => self.api.cycle(project, channel, state, table),
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
			callback: async (event) => {
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
					await self.api.useSource(project, source, mode)
					self.updateStatus(InstanceStatus.Ok)
					self.pollSourcesNow()
				} catch (error) {
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
			callback: async (event) => {
				const project = self.config.project?.trim() ?? ''
				const source = event.options.source?.trim() ?? ''
				if (!project || !source) {
					self.log('warn', 'Camera check: no project in the connection config, or no source id, so nothing was sent')
					return
				}
				if (!self.requireFeature('media', 'Camera check')) return
				try {
					await self.api.checkMedia(project, source)
					self.updateStatus(InstanceStatus.Ok)
					self.pollSourcesNow()
				} catch (error) {
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
			callback: async (event) => {
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
					const result = await self.api.setMode(project, value)
					self.noteMode(result.mode)
					self.updateStatus(InstanceStatus.Ok)
				} catch (error) {
					self.reportError(`Mode → ${value || '(none)'}`, error)
				}
			},
		},
	})
}
