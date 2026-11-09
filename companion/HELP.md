# Breeze Overlay

Controls a [Breeze Overlay](https://github.com/dwclarkphx/breeze-overlay) server — a
self-hosted HTML5 graphics system that feeds browser sources to OBS and vMix.

**Needs Companion 5.1 or later.** On Companion 5.0, use module 1.1.x: it does
everything below except what is marked **0.79+**.

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

| Field               |                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server address**  | The machine running Breeze — the address it prints at startup. A hostname is fine. Do not use `localhost` unless Companion is on that same machine |
| **Port**            | `7331` unless `BREEZE_PORT` was changed                                                                                                            |
| **Project URL key** | The short key shown in the editor's app bar and on each portal tile — `demo-1iixd` for the bundled Breeze Demo, not the display name               |
| **API key**         | Only if the server was started with `BREEZE_API_KEY`. Leave blank otherwise                                                                        |
| **State poll**      | How often to read playback state back, in ms, when it cannot be pushed (see below). `1000` is plenty                                               |

The connection reports **Connection failure** if the server cannot be reached and
**Authentication failure** if the key is missing or wrong — those are different
problems and worth telling apart before you start checking cables.

Breeze checks the key only on commands; reading state needs none. So a **missing**
key shows as soon as the connection connects (Breeze 0.74 or later), but a **wrong**
key shows on the first button press — until then the connection still reads state
normally. Five wrong keys in a minute and Breeze refuses this machine for the rest of
that minute, the portal's sign-in included.

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
here. The actions below marked **0.74+** or **0.79+** log a plain _"needs Breeze
0.74 or later"_ (or 0.79) against an older server instead of sending a request it
would not understand, and their presets are only offered by a server that has them.

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

| Action                              |                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PLAY**                            | Rolls in and holds at the next STOP marker. Press again to advance; from the last hold it plays the outro                                                                                                                                |
| **NEXT**                            | While holding on a table with more rows than fit, the next page; otherwise the next hold. With a **Table** set (0.74+), only that table turns, and the graphic itself never moves. Pages wrap: NEXT on the last page goes to the first   |
| **PREV** (0.74+)                    | The mirror of NEXT: the previous page while holding (PREV on the first page goes to the last), otherwise back to the previous hold. Never takes a graphic off air                                                                        |
| **STOP**                            | Runs the outro. This is how a graphic leaves air                                                                                                                                                                                         |
| **CLEAR**                           | Hard reset — nothing on screen, immediately                                                                                                                                                                                              |
| **CLEAR ALL**                       | Every element of a scene down at once                                                                                                                                                                                                    |
| **Update fields on air**            | Push text, one `name=value` per line. Applies live; no re-play needed                                                                                                                                                                    |
| **Go to page** (0.74+)              | Jump a paged table to a page — by number (from 1), or by **key**, the value in the table's key column (`Group C`, `Flagstaff`). Keys ignore case. Works before the graphic is on air too, so it rolls in on that page                    |
| **Cycle** (0.74+)                   | **Hold** a self-paging table on the page it shows, **Resume** it from there, or **Toggle** between the two                                                                                                                               |
| **Mode** (0.74+)                    | Put the whole project into a mode — `first-alert`, `election-night` — or out of it. **Toggle** switches between that mode and none, so one button does both. Every graphic with a rule for the mode changes at once                      |
| **Camera list — check now** (0.74+) | Check every camera in a camera list straight away instead of at its next round — after fixing one, or before going on air. Takes the source's id                                                                                         |
| **Data source** (0.74+)             | Put a data source's **Backup** on air, keep its **Own rows** on air even when they are stale or frozen (not once they have expired), or hand the choice back to **Automatic**. **Toggle** switches between Backup and Automatic          |
| **Rundown — TAKE** (0.79+)          | The armed item on air — its values and PLAY in one command — then the next item armed, so one button walks the list. An **Item** id takes that one instead                                                                               |
| **Rundown — arm** (0.79+)           | Arm the **next**, the **previous** or a given **item**, or **nothing**. Changes nothing on air                                                                                                                                           |
| **Rundown — take off air** (0.79+)  | Runs the outro of what the rundown put on a target: the armed item's, or the one named (`@main`, or a graphic id)                                                                                                                        |
| **Output** (0.79+)                  | **STOP**, **NEXT**, **PREV** or **CLEAR** on an output — one graphic on it, or all of them. CLEAR also unmounts                                                                                                                          |
| **Timer** (0.79+)                   | **Start / pause**, start, pause, **reset**, **set** to a time (`8:00`) or **add** (`10`, `-10`) on a timer. Blank Timer is `main`                                                                                                        |
| **Roll** (0.79+)                    | Play / pause, run **forward** or **backward**, reverse, **faster**, **slower**, a **speed** (`1.5`), **jog** (`-3` seconds), **go to** (`1:30`, `50%`), back to the start, to the end, or reset                                          |
| **Game** (0.79+)                    | A tap on a sport game table: a **scoring action** for a side (`three`, `td`, `try`), take one back, a **point** for the racket sports, the **period**, **add** to or **set** a column (`homeFouls`, `possession`), or **reset** the game |
| **Poll** (0.79+)                    | **Vote** for an option (Value `1`, or `-1` to take one off), **set** a count, **open**, **close**, toggle, or **reset** every count                                                                                                      |
| **Field** (0.79+)                   | **Set** a field on air, **add** to a number (kept inside its min and max), **toggle** an on/off field, or switch it **on** or **off**. A toggle or add reads the value on air first                                                      |

Field names are the **binding names** from the editor's properties panel — the same
ones the web control panel shows. Both the channel and the field box accept Companion
variables.

### Tables

NEXT, PREV, Go to page and Cycle take an optional **Table**. Leave it blank to act on
every paged table in the graphic. Otherwise give the table's **binding name** from the
properties panel, its layer id, or — for tables set to cycle together — the **cycle
group**, which moves every table in the group as one. A name the graphic does not have
is ignored by the output page; nothing moves.

Every table a graphic was built to page — **Rows per page** set, or a **Cycle** — gets a
**PAGE** preset in that graphic's section (Breeze 0.77+). It is a status button: pressing it
does nothing. It shows the page on screen and how many there are, with the page's key under
it — `2/2` over `Peoria Pioneers` — and changes the moment the page turns, whoever turned
it. It reads its own graphic, whatever the connection's default channel is.

To build one by hand: add the **Table page** feedback as a local variable on the button
(once with **Show** set to _Page of pages_, once to _Page key_), name them `page` and `key`,
and put `$(local:page)` and `$(local:key)` in the button text.

A hold survives the graphic leaving air and coming back: a table frozen for an
interview stays frozen until something resumes it. Put the **Table cycle is held**
feedback on the Cycle button so the button remembers.

Fields fed by a data source are read-only in Breeze and cannot be pushed this way.
That is deliberate: it stops a button overwriting a live temperature with a
placeholder.

### DEBUG buttons

Every graphic also gets a **DEBUG** status button: the output page's debug view
(`?debug=1`) on a Stream Deck. A ring fills as the playhead runs through the
composition, coloured by state — grey idle, green playing in, red holding, amber
playing out — with the state, `t=1.50/2.40s` and `step 1/1` inside. Pressing it does
nothing.

Outputs report when something changes, not every frame, so while a graphic plays the
module carries the time forward from the last report and stops it where the graphic
stops, at the next STOP marker or the end. The frame rate the debug view shows is not
sent to the server, so the button has none. Change the colours in the button's
**Playback — colour by state** local variable.

### Data sources and backups

In Breeze a data source can have a **backup** — another source whose rows go on air
when the first has nothing fit to show, set under _When the data is bad_ in the
editor's data panel. The **Data source** action is the operator's switch for the
case no rule can see: a feed that is up and answering, and wrong.

It takes the source's **id** (shown beside its name in the data panel), not a
channel: one source feeds every graphic that reads it, so switching it switches all
of them. The choice lasts until it is changed or the Breeze server restarts. Every
source with a backup gets a **BACKUP** preset in the _Data sources_ section, lit
amber while its backup is on air.

### Camera lists

A data source can be a list of cameras and streams — snapshot URLs, MJPEG cameras,
YouTube, HLS — with **media checks** switched on in the editor. Breeze then checks
every camera on a schedule, drops one that has failed or frozen out of the rotation,
and plays snapshots and streams through the server. Each camera list gets a **CAMERAS**
preset in the _Camera lists_ section: pressing it checks every camera now, and it
lights red while any camera is down.

### Rundowns and outputs (0.79+)

A rundown is a list prepared in Breeze before the show: each item a graphic, its field
values, and where it goes. **Arm** an item and nothing changes on air; **TAKE** puts it
up and arms the next one. Two operators — a panel and a Stream Deck — see the same
armed item, because the server holds it.

Actions take the rundown's **id**; blank means the first rundown in the project. Every
rundown gets a section in the preset list: **TAKE** showing the armed item, **ARM NEXT**,
**ARM PREV**, **OUT** showing what is on air, and one button per item (up to 100) that
arms it, lit amber while armed and red while on air. The section is rebuilt when the
rundown is saved in Breeze.

An item can go to an **output** instead of its own channel: one browser source,
`/out/<project>/<output>`, that carries whatever the rundown takes onto it — the lower
thirds, the slate and the bug on one vMix input. Each output the rundowns use gets an
_Output @name_ section with STOP and CLEAR, and the output's timers and rolls.

### Timers and rolls (0.79+)

A **timer** is a property of a text layer in Breeze: a countdown, a count-up or a
stopwatch, with an id (`main`, `game`, `shot`). The **Timer** action runs it, and every
output shows the same clock. A timer belongs to its channel; on an output, every graphic
mounted there shares the output's timers — use `@main` as the channel.

The module works the time out itself from what the server holds, so a button shows the
clock as the graphic does — `7:42`, `59.9` in the last seconds — without polling every
second. Each timer gets presets in its graphic's section: **START/PAUSE** showing the
clock, lit green while running, **RESET**, **+10**, **−10**, **+1** and **−1**.

A **roll** scrolls long text — credits, lyrics — at the designer's speed. The **Roll**
action is its transport. Each roll gets **PLAY/PAUSE** showing how far through it is,
**◀◀** and **▶▶**, **SLOWER** and **FASTER** showing the speed, **⏮** and **⏭**. How far
through is blank until an output has drawn the text.

Each roll also gets **PROGRESS**: a ring that fills as the roll runs, in step with the
control panel's position bar, with the time left in the middle. The ring turns from
green to yellow with 30 seconds left and to red with 10, at the speed it is running.
Change the seconds or the colours in the button's **Roll — colour by time left** local
variable. Pressing it plays or pauses. Where Companion cannot draw layered buttons, the
preset is a plain button showing the time left.

### Sport game tables (0.79+)

A game table is a data source made in Breeze from a sport template. Its one row is the
live game: the score, the period, possession and every counter the sport keeps. Every
graphic reading it shows the same score.

The **Game** action takes the source's id. Scoring actions use the sport's own ids —
basketball's are `ft`, `fg` and `three` — and each game table gets a section with the
right buttons for its sport: one per scoring action per side (or a **POINT** per side
for tennis, badminton, table tennis, volleyball and pickleball), a score button per side
lit amber while that side has possession, **POSS** per side, and **◀ PERIOD** /
**PERIOD ▶** showing the period.

### Polls (0.79+)

A poll is a data source holding a question, its options and the tally. Votes come from
the operator — a panel, a Stream Deck — never from the audience. Each poll gets a vote
button per option showing its count (amber while it leads), a **−1** per option,
**OPEN/CLOSE** (green while open) and **RESET**.

### Typed fields (0.79+)

A graphic can declare what a field is: a number with a min, max and step, an on/off
toggle, a list of options. The **Field** action sets one on air, and its section gets
the matching buttons: **+step**, any extra steps the designer set (`+1 +2 +3`) and
**−step** for a number, **ON/OFF** for a toggle, one button per option. Colour and asset
fields are set with **Field — Set** and their value (`#c8102e`, an asset path).

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

|                                | Clear   | Play | Advance |
| ------------------------------ | ------- | ---- | ------- |
| Screen Bug — Logo, Time & Temp | CLR ALL | PLAY | NEXT    |
| Lower Third — Name             | CLR ALL | PLAY | NEXT    |
| Lower Third + Bug _(parent)_   | CLR ALL |      |         |

The bug and the lower third play and advance independently; the parent's CLR ALL
clears both.

Presets are only generated for this connection's project. If a nested composition
lives in a different project, add a connection for that project, or type
`project/channel` into the action's channel field.

## Feedbacks

| Feedback                                          |                                                                                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Graphic is on air**                             | True whenever playback is anything other than idle or finished. Red by default                                                                                                                                                                |
| **Playhead**                                      | A value: the debug line — `holding t=1.50/2.40s step 1/1` — or its **state**, **time**, **seconds**, **step**, **length**, or a number 0–100 for a gauge                                                                                      |
| **Playback — colour by state**                    | A value: a colour for each playback state, for a ring or a background                                                                                                                                                                         |
| **Playback state is…**                            | Match one specific state — useful to distinguish rolling in from holding                                                                                                                                                                      |
| **No browser source attached**                    | A _warning_, true when nothing is listening on that channel                                                                                                                                                                                   |
| **Table cycle is held** (0.74+)                   | True while a self-paging table is frozen. Blue by default                                                                                                                                                                                     |
| **Table is showing page…** (0.74+)                | True while a table shows a given page, by number (from 1) or key — for a bank of Go to page buttons where the one on screen lights up, whoever turned to it                                                                                   |
| **Table page** (0.74+)                            | A value, not a style: the page a table shows as **Page of pages** (`2/3`), **Page number**, **Page count** or **Page key**. Store it in a button's local variable and put `$(local:…)` in its text — what the PAGE preset does                |
| **Project mode is…** (0.74+)                      | True while the project is in the mode you name (blank: no mode). Red by default                                                                                                                                                               |
| **Camera list is…** (0.74+)                       | True while a camera in the list is **down** (failed or frozen), while one is **frozen**, or while **every camera is up**. Takes the source's id. Red by default                                                                               |
| **Data source is…** (0.74+)                       | True while a data source is **on its backup**, **failing** (last good data still on air), **expired or frozen** (blank on air), has **any problem**, is **live**, or has been **set by an operator**. Takes the source's id. Amber by default |
| **Rundown item is armed or on air** (0.79+)       | True while an item is **armed** (amber) or **on air**                                                                                                                                                                                         |
| **Rundown: armed item is not on air yet** (0.79+) | True between arming an item and taking it                                                                                                                                                                                                     |
| **Rundown** (0.79+)                               | A value: the **armed item**, its **graphic**, its **place** (`3/15`), what is **on air** where it goes, or the rundown's **name**                                                                                                             |
| **Timer is running** (0.79+)                      | True while a timer runs. Green by default                                                                                                                                                                                                     |
| **Timer at or under N seconds** (0.79+)           | True once a timer reads N seconds or less — the last thirty of a countdown. Red by default                                                                                                                                                    |
| **Timer** (0.79+)                                 | A value: the timer **as the graphic shows it** (`7:42`), in **whole seconds**, or **running** (`true`/`false`)                                                                                                                                |
| **Roll is…** (0.79+)                              | True while a roll is **running**, **running backward**, or **at its end**                                                                                                                                                                     |
| **Roll** (0.79+)                                  | A value: **how far through** (`42%`, or a number for a gauge), the **time left** at this speed (`1:42`, or seconds), the **speed** (`×1.25`), the **direction**, or the **state**                                                             |
| **Roll — colour by time left** (0.79+)            | A value: a colour for a progress ring — normal, then the warning colour and the last-seconds colour as the time left runs down (30 s and 10 s by default)                                                                                     |
| **Game** (0.79+)                                  | A value: one column of a game table — `homeScore`, `periodLabel`, `homeFouls`                                                                                                                                                                 |
| **Game column is…** (0.79+)                       | True while a column holds a value — `possession` is `home`, `serving` is `away`. Amber by default                                                                                                                                             |
| **Poll** (0.79+)                                  | A value: an option's **votes**, **percent**, **label** or **rank**, the **leading** option, the **question**, the **total** or whether it is **open**                                                                                         |
| **Poll is open** (0.79+)                          | Green by default                                                                                                                                                                                                                              |
| **Poll option is leading** (0.79+)                | True for the leader, or every option tied for the lead. Amber by default                                                                                                                                                                      |

The three table feedbacks take the same optional **Table** as the actions; blank means
the first paged table in the graphic. The timer and roll feedbacks take a channel — a
graphic, or `@output` — and an id; blank means the channel's first (`main` if it has
one).

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

| Variable                                  |                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `$(breeze:table)`                         | The table's name, as the Table field accepts it                                             |
| `$(breeze:page)` / `$(breeze:page_count)` | The page showing, from 1, and how many there are                                            |
| `$(breeze:page_key)`                      | That page's key — the city or group it shows — or blank                                     |
| `$(breeze:cycle_state)`                   | `none` (no cycle set up), `cycling`, `held`, or `stopped` (ran to its end)                  |
| `$(breeze:cycle_seconds_left)`            | Seconds until it turns its page, counted down on the Companion side; blank when not cycling |

A button reading `$(breeze:page_key)` over `$(breeze:cycle_seconds_left)s` shows what
is on screen and how long it has left.

For the connection's project as a whole (0.74+), read every five seconds:

| Variable                      |                                                                             |
| ----------------------------- | --------------------------------------------------------------------------- |
| `$(breeze:sources_failing)`   | Data sources whose fetches are failing, or whose data has expired or frozen |
| `$(breeze:sources_on_backup)` | Data sources with their backup on air                                       |
| `$(breeze:mode)`              | The project's mode, blank when there is none                                |
| `$(breeze:media_up)`          | Cameras up across the project's camera lists                                |
| `$(breeze:media_down)`        | Cameras failed or frozen across the project's camera lists                  |

For the 0.79 features (0.79+):

| Variable                                                                   |                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `$(breeze:rundown)`                                                        | The first rundown's name                                 |
| `$(breeze:cued_item)` / `$(breeze:cued_composition)`                       | The item armed in it, and its graphic                    |
| `$(breeze:cued_position)`                                                  | Its place — `3/15`                                       |
| `$(breeze:on_air_item)`                                                    | What is on air where the armed item goes                 |
| `$(breeze:timer)`                                                          | The default channel's timer — `main`, or its first       |
| `$(breeze:timer_remaining)` / `$(breeze:timer_seconds)`                    | That timer as the graphic shows it, and in whole seconds |
| `$(breeze:timer_running)`                                                  | `true` or `false`                                        |
| `$(breeze:home_score)` / `$(breeze:away_score)` / `$(breeze:period_label)` | The project's first sport game table                     |

Every other rundown, timer, roll, game table or poll is read through its value
feedback into a button's local variable, the way the presets do it, so a button never
depends on a variable named after something that can be renamed in Breeze.

A mode is set in Breeze by layer **rules** — a layer shown only in `first-alert`, a
colour that changes in it. Every mode a rule names gets a toggle preset in the _Modes_
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

- _"reached no browser sources"_ — the address is right; the output page is not open
  in OBS or vMix
- _"not found"_ — the project or channel key is wrong
- _"API key rejected"_ — the server has `BREEZE_API_KEY` set and this connection's key
  does not match
- _"too many wrong API keys"_ — fix the key, then wait out the minute
- _"nothing is armed"_ — TAKE or OUT with nothing armed in the rundown: arm an item first
- _"needs Breeze 0.79 or later"_ — the server is older than the feature
