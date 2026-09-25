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
| **State poll** | How often to read playback state back, in ms. `1000` is plenty; lower it only if a feedback feels sluggish |

The connection reports **Connection failure** if the server cannot be reached and
**Authentication failure** if the key is wrong — those are different problems and
worth telling apart before you start checking cables.

## Channels

Every action and feedback takes a **channel**. That is a scene's URL key, or — for a
scene made of independently triggered elements — the element's **Channel** as set in
the properties panel.

- Leave it blank to use the connection's default channel — the first one any button
  named in this connection's project.
- `project/channel` also works, so one connection can reach a second project without
  being reconfigured. Feedbacks on such an address read state from that project, the
  same as actions send to it.

Only channels that a placed action or feedback points at are polled. Deleting or
disabling the button releases its channel.

The authoritative list of what a project answers to is
`http://<host>:7331/api/projects/<project>/channels` — for the Breeze Demo,
`http://<host>:7331/api/projects/demo-1iixd/channels`. Anything absent from it will 404.

## Actions

| Action | |
|---|---|
| **PLAY** | Rolls in and holds at the next STOP marker. Press again to advance. Never takes a graphic off air |
| **NEXT** | Advance to the next hold |
| **STOP** | Runs the outro. This is how a graphic leaves air |
| **CLEAR** | Hard reset — nothing on screen, immediately |
| **CLEAR ALL** | Every element of a scene down at once |
| **Update fields on air** | Push text, one `name=value` per line. Applies live; no re-play needed |

Field names are the **binding names** from the editor's properties panel — the same
ones the web control panel shows. Both the channel and the field box accept Companion
variables.

Fields fed by a data source are read-only in Breeze and cannot be pushed this way.
That is deliberate: it stops a button overwriting a live temperature with a
placeholder.

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
`$(breeze:channel)`, `$(breeze:server_version)`

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
