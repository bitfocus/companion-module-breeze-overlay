// Copyright (C) 2026 Dave Clark
// SPDX-License-Identifier: MIT

/**
 * Live channel state over the Breeze control hub (Breeze 0.74+).
 *
 * The hub pushes a channel's state the moment it changes — a graphic reaching
 * its hold, a table turning a page — so a button colours on the event rather
 * than up to a poll interval later, and nothing is fetched while nothing
 * changes. One socket per watched channel, because that is how the hub
 * subscribes: a socket follows one channel.
 *
 * Read-only. The module subscribes as a `companion` controller, which the
 * server shows on its peers page but leaves out of the panel count and the
 * activity log, and with `data: false`, which leaves the channel's retained
 * field data out of every message. Commands still go over HTTP with the API
 * key in a header; nothing is ever sent on this socket but the subscription.
 *
 * Node 22's global `WebSocket` — no dependency. Where it is missing the module
 * simply keeps polling, as 1.0 did.
 */

import type { ChannelState } from './api.js'

export const hasWebSocket = typeof globalThis.WebSocket === 'function'

export interface LiveChannelEvents {
	/** A welcome or state message arrived. */
	state(key: string, state: ChannelState): void
	/** The subscription was answered — the socket can now be trusted for this channel. */
	open(key: string): void
	/** A trusted socket dropped. It retries on its own; the poll covers the gap. */
	close(key: string): void
}

const FIRST_RETRY_MS = 1000
const MAX_RETRY_MS = 10_000

export class LiveChannel {
	private socket: WebSocket | undefined
	private retry: NodeJS.Timeout | undefined
	private delay = FIRST_RETRY_MS
	private stopped = true

	/**
	 * Subscribed and answered.
	 *
	 * Not merely "open": a socket can connect to something that is not a Breeze
	 * hub — a proxy, an older server — and never say anything useful. Only a
	 * welcome proves the channel's state is arriving, so only then does the poll
	 * stand down for it.
	 */
	live = false

	constructor(
		private readonly url: string,
		/** `project/channel` — the hub's own channel name. */
		readonly key: string,
		private readonly events: LiveChannelEvents,
	) {}

	start(): void {
		if (!this.stopped) return
		this.stopped = false
		this.connect()
	}

	stop(): void {
		this.stopped = true
		if (this.retry) clearTimeout(this.retry)
		this.retry = undefined
		this.drop()
	}

	/** Drop the socket and dial again at once — used when the watchdog loses the server. */
	restart(): void {
		if (this.stopped) return
		const wasLive = this.live
		this.drop()
		if (wasLive) this.events.close(this.key)
		this.scheduleRetry()
	}

	private drop(): void {
		const socket = this.socket
		this.socket = undefined
		this.live = false
		if (!socket) return
		socket.onopen = null
		socket.onmessage = null
		socket.onclose = null
		socket.onerror = null
		try {
			socket.close()
		} catch {
			// Already closing; nothing to do.
		}
	}

	private connect(): void {
		let socket: WebSocket
		try {
			socket = new WebSocket(this.url)
		} catch {
			this.scheduleRetry()
			return
		}
		this.socket = socket

		socket.onopen = () => {
			socket.send(
				JSON.stringify({
					type: 'subscribe',
					channel: this.key,
					role: 'controller',
					client: 'companion',
					data: false,
				}),
			)
		}

		socket.onmessage = (event: MessageEvent) => {
			let message: unknown
			try {
				message = JSON.parse(String(event.data))
			} catch {
				return
			}
			const state = stateOf(message)
			if (!state) return
			if (!this.live) {
				this.live = true
				this.delay = FIRST_RETRY_MS
				this.events.open(this.key)
			}
			this.events.state(this.key, state)
		}

		// `error` is always followed by `close`; the retry lives there.
		socket.onerror = () => undefined

		socket.onclose = () => {
			if (this.socket !== socket) return
			const wasLive = this.live
			this.socket = undefined
			this.live = false
			if (wasLive) this.events.close(this.key)
			this.scheduleRetry()
		}
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retry) return
		this.retry = setTimeout(() => {
			this.retry = undefined
			if (!this.stopped) this.connect()
		}, this.delay)
		// Back off, so a server that is down for the whole break is not dialled
		// once a second per button by every Companion in the building.
		this.delay = Math.min(this.delay * 2, MAX_RETRY_MS)
	}
}

/** The state carried by a `welcome` or `state` message, or null for anything else. */
function stateOf(message: unknown): ChannelState | null {
	if (typeof message !== 'object' || message === null) return null
	const { type, state } = message as { type?: unknown; state?: unknown }
	if (type !== 'welcome' && type !== 'state') return null
	if (typeof state !== 'object' || state === null) return null
	return state as ChannelState
}
