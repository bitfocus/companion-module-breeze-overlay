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

import { combineRgb } from '@companion-module/base'
import type { CompanionPresetDefinitions, CompanionPresetSection } from '@companion-module/base'

import type { ChannelRef } from './api.js'
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
			name: `${entry.name} — PLAY`,
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
			name: `${entry.name} — STOP`,
			style: { text: buttonText(label, 'STOP'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'stop', options: { channel } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'next')] = {
			type: 'simple',
			name: `${entry.name} — NEXT`,
			style: { text: buttonText(label, 'NEXT'), size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'next', options: { channel, table: '' } }], up: [] }],
			feedbacks: [],
		}

		presets[idFor(channel, 'clear')] = {
			type: 'simple',
			name: `${entry.name} — CLEAR`,
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
				name: `${entry.name} — PREV`,
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
				name: `${entry.name} — CLEAR ALL`,
				style: { text: buttonText(label, 'CLR ALL'), size: 'auto', color: WHITE, bgcolor: combineRgb(120, 0, 0) },
				steps: [{ down: [{ actionId: 'clear_all', options: { channel } }], up: [] }],
				feedbacks: [],
			}
			ids.push(idFor(channel, 'clear_all'))
		}

		sections.push({
			id: `channel-${channel}`,
			name: entry.sceneId ? `${entry.name} (element of ${entry.sceneId})` : entry.name,
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

	self.setPresetDefinitions(sections, presets)
}
