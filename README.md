# companion-module-breeze-overlay

Bitfocus Companion module for [Breeze Overlay](https://github.com/dwclarkphx/breeze-overlay),
a self-hosted HTML5 broadcast graphics server that feeds browser sources to OBS,
vMix and anything else that can open a URL.

Play, hold, advance, stop and clear graphics from a Stream Deck, push text into
them live, and get on-air state back as feedbacks and variables.

**Usage and configuration are documented in
[`companion/HELP.md`](companion/HELP.md)** — the same text Companion shows under
the connection's Help button.

## Requirements

- Companion 5.1 or newer (`@companion-module/base` 2.2, module API 2.2). On
  Companion 5.0, use module 1.1.x
- A reachable Breeze Overlay server: v0.64.0 or newer for preset generation, v0.74.0
  for live state, v0.79.0 for rundowns, outputs, timers, game tables, typed fields,
  rolls and polls

## Development

Node 26 and Yarn 4. Yarn comes from Corepack, which ships with Node — if `yarn`
is not found, run `corepack enable` once.

```sh
yarn install
yarn build      # compile src/ to dist/
yarn dev        # compile on change
yarn lint
yarn package    # build a .tgz for manual import into Companion
```

## License

MIT. See [LICENSE](LICENSE). Breeze Overlay itself is licensed separately.
