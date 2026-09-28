# Changelog

All notable changes to the Breeze Overlay module for Bitfocus Companion are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release is tagged `vX.Y.Z` and submitted through the Bitfocus developer portal. Features marked **0.74+** need Breeze Overlay 0.74.0 or later; against an older server they log _"needs Breeze 0.74 or later"_ and send nothing.

## [1.1.0] - 2026-09-28

> Live state and table paging, data sources, project modes and camera lists, for Breeze Overlay 0.74.

### Added

- Each watched channel gets a live, read-only WebSocket connection to Breeze (**0.74+**), so feedbacks and variables change the moment the server does instead of on the next poll.
- The module falls back to polling against an older server or while a live connection reconnects, and a 5-second health check catches a server that dies without closing its sockets.
- The server version is re-checked on every reconnect, so upgrading Breeze or failing over to an older machine needs no change in Companion.
- **PREV** action (**0.74+**): the previous page while holding, otherwise back to the previous hold, never taking a graphic off air.
- **Go to page** action (**0.74+**) jumps a paged table to a page by number or by its key, such as `Group C`.
- **Cycle** action (**0.74+**) holds, resumes or toggles a self-paging table.
- **NEXT**, **PREV**, **Go to page** and **Cycle** take an optional **Table**: a binding name, layer id or cycle group.
- **Table cycle is held** and **Table is showing page…** feedbacks (**0.74+**).
- Variables `table`, `page`, `page_count`, `page_key`, `cycle_state` and `cycle_seconds_left` for the first paged table on the default channel (**0.74+**), with the countdown run locally.
- Variable `state_source` shows whether the default channel is `live` or on `poll`.
- **Data source** action (**0.74+**) puts a source's backup on air, keeps its own rows on air, toggles between them, or hands the choice back to automatic.
- **Data source is…** feedback (**0.74+**) for a source that is on its backup, failing, expired or frozen, live, has any problem, or was set by an operator.
- Variables `sources_failing` and `sources_on_backup`, and a **BACKUP** preset for every source that has a backup.
- **Mode** action (**0.74+**) sets, clears or toggles the project mode, with a **Project mode is…** feedback, a `mode` variable and a toggle preset per mode.
- **Camera list — check now** action (**0.74+**) checks every camera in a camera list at once, with a **Camera list is…** feedback, `media_up` and `media_down` variables and a **CAMERAS** preset per list.

### Changed

- **State poll** is now the fallback interval, used only when state cannot be pushed.
- An upgrade script gives every **NEXT** placed under 1.0 a blank **Table**, which is exactly what those buttons already did.
- Only the presets a server supports are offered, so **PREV** appears only against Breeze 0.74 or later.
- Table options for the new actions are sent in the request body, leaving nothing but the path in the URL.
- The live connection identifies itself as Companion, so Breeze lists it on the peers page and does not count it as an open control panel.

## [1.0.1] - 2026-09-25

### Changed

- Only channels that a placed action or feedback points at are polled, and deleting or disabling the button stops polling its channel.
- If every button on the default channel is removed, the variables move to the next channel in the project that a button still uses.
- The help file's examples use the Breeze Demo's project key (`demo-1iixd`).

### Fixed

- An action with a blank channel, placed before the connection had a default channel, never polled its channel once one was set.
- Feedbacks on a `project/channel` address read state from the connection's own project instead of the one named.
- Changing the connection's project left blank-channel buttons pointed at the old project.
- A channel released while a request was in flight could be polled again when the answer arrived.

## [1.0.0] - 2026-09-21

### Added

- First release: control a Breeze Overlay project from Companion, one connection per project.
- Actions **PLAY**, **NEXT**, **STOP**, **CLEAR**, **CLEAR ALL** and **Update fields on air**, with Companion variables accepted in the channel and fields.
- Channels addressed by URL key, element channel or `project/channel`, with a blank channel meaning the connection's default.
- Feedbacks **Graphic is on air**, **Playback state is…** and **No browser source attached**.
- Variables `playback_state`, `playback_step`, `playback_steps`, `sources_connected`, `panels_connected`, `project`, `channel` and `server_version`.
- Presets for every graphic in the project, grouped by graphic.
- Separate **Connection failure** and **Authentication failure** statuses, and log warnings when a call reaches no browser source, names an unknown channel or has its API key rejected.

[1.1.0]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bitfocus/companion-module-breeze-overlay/releases/tag/v1.0.0
