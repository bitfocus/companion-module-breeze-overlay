# Breeze Overlay

Controls a [Breeze Overlay](https://github.com/dwclarkphx/breeze-overlay) server — a
self-hosted HTML5 graphics system that feeds browser sources to OBS and vMix.

One connection points at **one project**. If a show uses two projects on the same
server, add two connections; that also tends to be how the buttons want organising.

**Name each connection after its project.** The connection's label is what Companion
shows in the preset list, in every action and feedback dropdown, and as the prefix on
its variables — so with several projects in play, a label like `election` or
`sports_scores` tells you at a glance which show a button drives, and a variable
reads as `$(election:playback_state)` rather than `$(breeze_2:playback_state)`.
Companion only accepts letters, numbers, `-` and `_` in a label, so use a short form
of the project name rather than its full display name.

## Configuration

| Field | |
|---|---|
| **Server address** | The machine running Breeze — the address it prints at startup. A hostname is fine. Do not use `localhost` unless Companion is on that same machine |
| **Port** | `7331` unless `BREEZE_PORT` was changed |
| **Project URL key** | The short key shown in the editor's app bar and on each portal tile — `demo-1iixd` for the bundled Breeze Demo, not the display name |
| **API key** | Only if the server was started with `BREEZE_API_KEY`. Leave blank otherwise |
| **State poll** | How often to read playback state back, in ms, when it cannot be pushed (see below). `1000` is plenty |

The connection reports **Connection failure** if the server cannot be reached and
**Authentication failure** if the key is wrong — those are different problems and
worth telling apart before you start checking cables.

### Live state and older servers

Against **Breeze 0.74 or later**, each channel a button watches gets a live
connection and the server pushes changes the moment they happen — a graphic reaching
its hold, a table turning a page. Against an older server, or for a moment while a
live connection reconnects, the module polls instead, exactly as 1.0 did.
`$(breeze:state_source)` says which is in use for the default channel: `live` or
`poll`.

The live connection only reads. It needs no API key (commands still send the key,
in a header), it carries no field data, and it is listed on the server's peers page
as Companion rather than counted as an open control panel.

The server's version is checked again every time the connection comes back, so
upgrading Breeze — or falling back to an older spare machine — needs nothing done
here. The actions below marked **0.74+** log a plain *"needs Breeze 0.74 or later"*
against an older server instead of sending a request it would not understand.

## Channels

Every action and feedback takes a **channel**. That is a scene's URL key, or — for a
scene made of independently triggered elements — the element's **Channel** as set in
the properties panel.

- Leave it blank to use the connection's default channel — the first one any button
  named in this connection's project.
- `project/channel` also works, so one connection can reach a second project without
  being reconfigured. Feedbacks on such an address read state from that project, the
  same as actions send to it.

Only channels that a placed action or feedback points at are watched. Deleting or
disabling the button releases its channel and closes its live connection.

The authoritative list of what a project answers to is
`http://<host>:7331/api/projects/<project>/channels` — for the Breeze Demo,
`http://<host>:7331/api/projects/demo-1iixd/channels`. Anything absent from it will 404.

## Actions

| Action | |
|---|---|
| **PLAY** | Rolls in and holds at the next STOP marker. Press again to advance. Never takes a graphic off air |
| **NEXT** | While holding on a table with more rows than fit, the next page; otherwise the next hold. With a **Table** set (0.74+), only that table turns, and the graphic itself never moves |
| **PREV** (0.74+) | The mirror of NEXT: the previous page while holding, otherwise back to the previous hold. Never takes a graphic off air |
| **STOP** | Runs the outro. This is how a graphic leaves air |
| **CLEAR** | Hard reset — nothing on screen, immediately |
| **CLEAR ALL** | Every element of a scene down at once |
| **Update fields on air** | Push text, one `name=value` per line. Applies live; no re-play needed |
| **Go to page** (0.74+) | Jump a paged table to a page — by number (from 1), or by **key**, the value in the table's key column (`Group C`, `Flagstaff`). Keys ignore case. Works before the graphic is on air too, so it rolls in on that page |
| **Cycle** (0.74+) | **Hold** a self-paging table on the page it shows, **Resume** it from there, or **Toggle** between the two |
| **Mode** (0.74+) | Put the whole project into a mode — `first-alert`, `election-night` — or out of it. **Toggle** switches between that mode and none, so one button does both. Every graphic with a rule for the mode changes at once |
| **Camera list — check now** (0.74+) | Check every camera in a camera list straight away instead of at its next round — after fixing one, or before going on air. Takes the source's id |
| **Data source** (0.74+) | Put a data source's **Backup** on air, keep its **Own rows** on air even when they are stale or frozen (not once they have expired), or hand the choice back to **Automatic**. **Toggle** switches between Backup and Automatic |

Field names are the **binding names** from the editor's properties panel — the same
ones the web control panel shows. Both the channel and the field box accept Companion
variables.

### Tables

NEXT, PREV, Go to page and Cycle take an optional **Table**. Leave it blank to act on
every paged table in the graphic. Otherwise give the table's **binding name** from the
properties panel, its layer id, or — for tables set to cycle together — the **cycle
group**, which moves every table in the group as one. A name the graphic does not have
is ignored by the output page; nothing moves.

A hold survives the graphic leaving air and coming back: a table frozen for an
interview stays frozen until something resumes it. Put the **Table cycle is held**
feedback on the Cycle button so the button remembers.

Fields fed by a data source are read-only in Breeze and cannot be pushed this way.
That is deliberate: it stops a button overwriting a live temperature with a
placeholder.

### Data sources and backups

In Breeze a data source can have a **backup** — another source whose rows go on air
when the first has nothing fit to show, set under *When the data is bad* in the
editor's data panel. The **Data source** action is the operator's switch for the
case no rule can see: a feed that is up and answering, and wrong.

It takes the source's **id** (shown beside its name in the data panel), not a
channel: one source feeds every graphic that reads it, so switching it switches all
of them. The choice lasts until it is changed or the Breeze server restarts. Every
source with a backup gets a **BACKUP** preset in the *Data sources* section, lit
amber while its backup is on air.

### Camera lists

A data source can be a list of cameras and streams — snapshot URLs, MJPEG cameras,
YouTube, HLS — with **media checks** switched on in the editor. Breeze then checks
every camera on a schedule, drops one that has failed or frozen out of the rotation,
and plays snapshots and streams through the server. Each camera list gets a **CAMERAS**
preset in the *Camera lists* section: pressing it checks every camera now, and it
lights red while any camera is down.

## Nested compositions

A composition can mount other compositions inside it, but actions do not cascade
through that nesting. **PLAY and NEXT on the parent play and advance the parent
only — they do not trigger the compositions nested inside it.** Each nested
composition needs its own buttons.

Every graphic gets its own section in the preset list, named after it. For a parent
with nested compositions:

1. **For each nested composition,** take **PLAY**, **NEXT** and **CLR ALL** from
   its own section.
2. **For the parent,** take only **CLR ALL**. It is the one parent action that
   reaches the nested compositions, so it takes the whole stack off air in one
   press.

For example, a parent **Lower Third + Bug** nesting **Screen Bug — Logo, Time &
Temp** and **Lower Third — Name**:

| | Clear | Play | Advance |
|---|---|---|---|
| Screen Bug — Logo, Time & Temp | CLR ALL | PLAY | NEXT |
| Lower Third — Name | CLR ALL | PLAY | NEXT |
| Lower Third + Bug *(parent)* | CLR ALL | | |

The bug and the lower third play and advance independently; the parent's CLR ALL
clears both.

Presets are only generated for this connection's project. If a nested composition
lives in a different project, add a connection for that project, or type
`project/channel` into the action's channel field.

## Feedbacks

| Feedback | |
|---|---|
| **Graphic is on air** | True whenever playback is anything other than idle or finished. Red by default |
| **Playback state is…** | Match one specific state — useful to distinguish rolling in from holding |
| **No browser source attached** | A *warning*, true when nothing is listening on that channel |
| **Table cycle is held** (0.74+) | True while a self-paging table is frozen. Blue by default |
| **Table is showing page…** (0.74+) | True while a table shows a given page, by number or key — for a bank of Go to page buttons where the one on screen lights up, whoever turned to it |
| **Project mode is…** (0.74+) | True while the project is in the mode you name (blank: no mode). Red by default |
| **Camera list is…** (0.74+) | True while a camera in the list is **down** (failed or frozen), while one is **frozen**, or while **every camera is up**. Takes the source's id. Red by default |
| **Data source is…** (0.74+) | True while a data source is **on its backup**, **failing** (last good data still on air), **expired or frozen** (blank on air), has **any problem**, is **live**, or has been **set by an operator**. Takes the source's id. Amber by default |

The two table feedbacks take the same optional **Table** as the actions; blank means
the first paged table in the graphic.

That last one is the one worth putting on every button. A graphic whose output was
never opened in OBS looks completely normal until you press PLAY and nothing happens;
this makes it visible beforehand.

## Variables

Variables track the connection's **default channel** — the first one any button named
in this connection's project. If every button on that channel is removed, the role
passes to the next channel in the project that a button still uses.
Per-channel variables would have to be redefined every time a scene is added in Breeze,
and a variable that disappears breaks any button referencing it. For a specific
channel, use a feedback, which takes the channel as an option.

`$(breeze:playback_state)`, `$(breeze:playback_step)`, `$(breeze:playback_steps)`,
`$(breeze:sources_connected)`, `$(breeze:panels_connected)`, `$(breeze:project)`,
`$(breeze:channel)`, `$(breeze:server_version)`, `$(breeze:state_source)`

For the first paged table on the default channel (0.74+):

| Variable | |
|---|---|
| `$(breeze:table)` | The table's name, as the Table field accepts it |
| `$(breeze:page)` / `$(breeze:page_count)` | The page showing, from 1, and how many there are |
| `$(breeze:page_key)` | That page's key — the city or group it shows — or blank |
| `$(breeze:cycle_state)` | `none` (no cycle set up), `cycling`, `held`, or `stopped` (ran to its end) |
| `$(breeze:cycle_seconds_left)` | Seconds until it turns its page, counted down on the Companion side; blank when not cycling |

A button reading `$(breeze:page_key)` over `$(breeze:cycle_seconds_left)s` shows what
is on screen and how long it has left.

For the connection's project as a whole (0.74+), read every five seconds:

| Variable | |
|---|---|
| `$(breeze:sources_failing)` | Data sources whose fetches are failing, or whose data has expired or frozen |
| `$(breeze:sources_on_backup)` | Data sources with their backup on air |
| `$(breeze:mode)` | The project's mode, blank when there is none |
| `$(breeze:media_up)` | Cameras up across the project's camera lists |
| `$(breeze:media_down)` | Cameras failed or frozen across the project's camera lists |

A mode is set in Breeze by layer **rules** — a layer shown only in `first-alert`, a
colour that changes in it. Every mode a rule names gets a toggle preset in the *Modes*
section, lit red while it is on. The mode belongs to the project, not a channel, and it
survives a Breeze restart.

`breeze` stands for the connection's label — with a connection named `election`,
these become `$(election:playback_state)` and so on.

## When a button does nothing

Breeze answers a control call even when no browser source is listening — the call
succeeded, there was just nothing to receive it. The module logs a warning saying so
whenever that happens, and the **No browser source attached** feedback shows it before
you press anything.

If the button is PLAY or NEXT on a composition that nests others, it only acts on
the parent — see **Nested compositions** above. Nothing is logged for that, because
nothing went wrong.

Check the Companion log:

- *"reached no browser sources"* — the address is right; the output page is not open
  in OBS or vMix
- *"not found"* — the project or channel key is wrong
- *"API key rejected"* — the server has `BREEZE_API_KEY` set and this connection's key
  does not match
