# wenay-common2

[![CI](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml/badge.svg)](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml)

## Documentation

- Brief API cheat sheet: [`doc/wenay-common2.md`](doc/wenay-common2.md)
- Extended API cheat sheet: [`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md)
- Naming migrations: [`doc/NAMING_RENAMES.md`](doc/NAMING_RENAMES.md)
- Recent changes: [`doc/changes/`](doc/changes/)
- Project rules for AI/code maintenance: [`CLAUDE.md`](CLAUDE.md)

## Living examples (shipped in the npm package)

- [`demo/`](demo/) — runnable from a repository checkout (`npm run demo`): shared cursors in two browser tabs over the
  Peer SDK, relay ⇄ WebRTC direct hand-off next to a legacy rpc key; plus live media — camera,
  microphone and screen share captured with the `Media` sources and streamed to the watching tab.
- [`replay/`](replay/) · [`observe/`](observe/) · [`oracle/`](oracle/) — the oracle suites CI runs on
  every push; each file doubles as a worked usage example of one subsystem.
- The package ships readable example sources, not installed CLI scripts. Examples import from the
  repo's `src/`; in application code the same API comes from
  `wenay-common2` / `wenay-common2/peer` / `wenay-common2/replay` / `wenay-common2/observe`.