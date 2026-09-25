// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type FeedbacksSchema = {
	on_air: { type: 'boolean'; options: { channel: string } }
	playback_state: { type: 'boolean'; options: { channel: string; state: string } }
	source_connected: { type: 'boolean'; options: { channel: string } }
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
	})
}
