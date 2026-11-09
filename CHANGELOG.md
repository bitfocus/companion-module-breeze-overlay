# Changelog

All notable changes to the Breeze Overlay module for Bitfocus Companion are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release is tagged `vX.Y.Z` and submitted through the Bitfocus developer portal. Features marked **0.74+** need Breeze Overlay 0.74.0 or later; against an older server they log _"needs Breeze 0.74 or later"_ and send nothing.

## [1.2.0]

> Rundowns, outputs, timers, sport game tables, typed fields, rolls and polls, for Breeze Overlay 0.79.

**Needs Companion 5.1 or later.** The module now uses Companion's module API 2.2 (`@companion-module/base` 2.2.2), which Companion 5.0 does not load. On Companion 5.0, stay on 1.1.1. Features marked **0.79+** need Breeze Overlay 0.79.0 or later; against an older server they log _"needs Breeze 0.79.0 or later"_ and send nothing, and their presets are not offered.

### Added

- **Rundown** actions (**0.79+**): **TAKE** the armed item (or a given one) and arm the next, **arm** the next, previous or a given item, and **take a target off air**.
- **Rundown item is armed or on air**, **Rundown: armed item is not on air yet** and **Rundown** value feedbacks, and variables `rundown`, `cued_item`, `cued_composition`, `cued_position` and `on_air_item` for the project's first rundown. Armed and on-air state arrives live from the server.
- A preset section per rundown: TAKE showing the armed item, ARM NEXT, ARM PREV, OUT, and an Arm button per item, lit amber while armed and red while on air. Rebuilt when the rundown is saved in Breeze.
- **Output** action (**0.79+**): STOP, NEXT, PREV or CLEAR on an output, for one graphic on it or all, with an _Output @name_ preset section per output the rundowns use.
- **Timer** action (**0.79+**): start/pause, start, pause, reset, set or add, on a graphic's timers or an output's (`@main`).
- **Timer is running**, **Timer at or under N seconds** and **Timer** value feedbacks, and variables `timer`, `timer_remaining`, `timer_seconds` and `timer_running` for the default channel. The clock is worked out on the Companion side from the server's state, in the graphic's own format, so it counts without polling.
- Timer presets for every timer a graphic shows: START/PAUSE showing the clock, RESET, +10, −10, +1, −1.
- **Roll** action (**0.79+**): the roll transport — play/pause, forward, backward, reverse, faster, slower, speed, jog, go to, restart, end and reset — with **Roll is…** and **Roll** value feedbacks and a transport row of presets per roll.
- A **DEBUG** status preset for every graphic: the output page's debug view on a button, with a ring for the playhead coloured by playback state, and the state, time and step inside. The new **Playhead** and **Playback — colour by state** value feedbacks drive it; the time is carried forward between output reports while the graphic plays. Works on any Breeze version.
- A **PROGRESS** preset per roll: a ring that fills in step with the control panel's position bar, with the time left in the middle, turning from green to yellow with 30 s left and to red with 10 s. The **Roll — colour by time left** value feedback sets the colours and the seconds, and the **Roll** feedback can show the time left and a number for a gauge.
- **Game** action (**0.79+**): scoring actions, points, the period, and adding to or setting any column of a sport game table, with **Game** value and **Game column is…** feedbacks, variables `home_score`, `away_score` and `period_label`, and a preset section per game table laid out for its sport.
- **Poll** action (**0.79+**): vote, set a count, open, close, toggle and reset, with **Poll** value, **Poll is open** and **Poll option is leading** feedbacks and a preset section per poll.
- **Field** action (**0.79+** for typed fields): set a field, add to a number within its min and max, toggle an on/off field or switch it on or off, with presets for every typed field a graphic declares.

### Changed

- Built on `@companion-module/base` 2.2.2 (module API 2.2), so it needs Companion 5.1 or later.
- The server address field is required with `minLength` instead of the deprecated `Regex.SOMETHING`. It accepts exactly what it did before.

### Fixed

- **Data source is… Live** is now true for a poll or a text source held in the project. These sources never fetch, and 1.1.1 read them as still waiting for their first fetch.

## [1.1.1] - 2026-10-30

### Added

- **PAGE** preset (**0.77+**) for every table a graphic was built to page: a status button showing the page on screen out of how many (`2/2`) with the page's key under it (`Peoria Pioneers`). Pressing it does nothing. Offered only for graphics Breeze lists with a paged table, and each button watches its own graphic, not the connection's default channel.
- **Table page** value feedback (**0.74+**) — the page number, page count, both (`2/3`), or the page key — for showing a page in a button's text through a local variable.

### Changed

- Runs on Node 26 (`runtime.type: node26`), following the current Bitfocus module template. Still needs Companion 5.0 or later, as 1.1.0 did.

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

[1.2.0]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/bitfocus/companion-module-breeze-overlay/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bitfocus/companion-module-breeze-overlay/releases/tag/v1.0.0
