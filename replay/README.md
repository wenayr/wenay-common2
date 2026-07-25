# replay oracles

This directory contains executable examples and regression oracles for the canonical replay modules
under `src/Common/events/` and Store Replay V2 under `src/Common/Observe/`.

The current Store contract has one wire only:

- `Observe.exposeStoreReplay()` exposes `api.replay`;
- `Observe.syncStoreReplay()` consumes that V2 facade;
- every envelope owns one sequence coordinate and carries a bounded patch array;
- reconnect uses `since`, with a keyframe when retained history cannot cover the gap;
- RPC transports the V2 value on its JSON-array application wire.

Other replay files exercise generic replay lines, history, route hand-off, conflation, direct peer
channels, media, durable heads, offline stores and higher-level runtimes. Native binary media or
DataChannel values are independent transport leaves, not an alternate RPC or Store Replay wire.

Run the complete maintained suite from the repository root:

```bash
npm run test:all
```

The public API is documented in `doc/wenay-common2.md`; less common surfaces are in
`doc/wenay-common2-rare.md`.
