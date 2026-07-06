# wenay-common2: store consumer ergonomics — `each()` + one-call mirror fold (feature prompt)

Three additive changes in wenay-common2 (`src/Common/ObserveAll2/*`, `src/Common/rcp/rpc-client.ts`).
No breaking changes; existing surfaces keep working.

## Motivation (battle-tested, 2026-07-06 incident)

The store's subscription surface is a zoo with different semantics per method: `on`,
`update(mask).on`, `update(mask).onEach`, `listenPaths()`, `node.X.on`. The most natural
consumer intent — "call me per CHANGED key" — has no direct surface:

- `update(true).onEach` looks right but is a trap: onEach fires per **selected** path, and
  mask `true` selects the ROOT → ONE call per drain window with the whole dict. In production
  this silently fed a grid one garbage row instead of thousands (masked while a legacy
  channel wrote in parallel; surfaced the day the legacy path was removed).
- `{'*': true}` is not a wildcard (subscribes a literal `'*'` key → zero calls).
- The correct primitive today is `listenPaths()` + manual expansion (root path `[]` =
  keyframe → iterate the whole state), which every consumer must hand-roll (~15 lines),
  and which even the library's own docs examples got wrong.

Consumers know the Listen protocol by heart. The store should speak it for the per-key case.

## Feature A — `store.each()`: changed keys as a listen

```ts
store.each(opts?: {depth?: number}) -> listen of [key: string, value: T[key] | undefined, ctx: {path: PropertyKey[]}]
```

- Fires once per CHANGED top-level key per drain window (store's own drain), value = current
  `store.state[key]` at flush time, `undefined` = key deleted.
- Root change (`replace([], ...)` — e.g. a mirror keyframe) EXPANDS: one call per key of the
  new state. This is the semantic that makes "cold start is not a special case" hold for
  per-key consumers.
- Deeper dirt (`state.a.b = ...`) reports the top-level key once (coalesced). `depth` reserved
  for later; default 1.
- Shape: a plain wenay Listen (`on(cb) -> off`, addListen/once/count) — NOT a new protocol.
  Implementation is a thin layer over `listenPaths()`.
- Mirrors are stores, so `syncStoreReplay(mirror, remote); mirror.each().on(...)` covers the
  remote case with zero extra API.

## Feature B — `syncStoreReplayEach()`: one-call remote fold

The most common client pattern (mirror a remote store line into per-key callbacks) currently
costs: createStore + syncStoreReplay + listenPaths + root-expansion + batching (~25 lines,
written correctly only after reading the source). Collapse it:

```ts
syncStoreReplayEach<T>(remote: ReplayRemote<[StorePatch]>,
    cb: (key: string, value: T[keyof T] | undefined) => void,
    opts?: ReplaySubscribeOpts & {drain?: number, initial?: T})
    -> off & {store: Store<T>, ready, seq(), isStale(), lastTs()}
```

- Internally: mirror store (with `drain`), `syncStoreReplay(store, remote, opts)`,
  `store.each().on(cb)`. Returns the composite off; exposes the mirror store for direct
  reads (`off.store.state.BTCUSDT`).
- All `ReplaySubscribeOpts` pass through (policy/staleMs/onStale/onError/since...).

## Feature C — `ClientAPIAll` replay projection (typing-only fix)

Already specified in `wenay-common2-clientapiall-replay-prompt.md` — fold it into this batch:
`ClientAPIAll<T>` must map replay-listen members to `ReplaySocketListen<Z>` (reuse
`IsReplayMember` from listen-deep) instead of the generic object/function arms. Today every
`replaySubscribe(client.func.key)` on an `rpc<T>()`-typed client needs
`as unknown as Replay.ReplayRemote<[...]>` while the runtime shape is already correct.

## Deprecation / guardrail

`update(mask).onEach` stays (it is correct for explicit masks), but:
- add a dev-time `console.warn` (once per call site is fine) when `onEach` is used with a
  ROOT selection (mask `true` / empty path) — point to `each()`;
- fix the docs examples that showed `update(true).onEach` as a per-key feed.

## Oracles / QA

- each(): write N keys in one window → N calls with fresh values; delete key → `undefined`;
  root replace → one call per key of the new state; two writes to one key in a window →
  ONE call with the last value; cold store (no subscribers) → zero cost (no listenPaths timer).
- syncStoreReplayEach(): over the rpc harness — keyframe start expands per key; reconnect
  with {since} delivers only changed keys; policy 'frame' after a gate drop delivers the
  condensed set; off() tears down store subscription AND wire sub (leak check).
- ClientAPIAll: compile-only case — `rpc<{listenMsg: ListenReplayApi<[tMsg]>}>()` then
  `replaySubscribe(client.func.listenMsg, cb)` with no casts.

## Docs

`wenay-common2-rare.md` ObserveAll2 section: `each()` next to listenPaths with ONE canonical
per-key example (replacing the update(true).onEach sample); Replay section: one line for
`syncStoreReplayEach`; rpc client section: replay members project in BOTH typed-client paths.

## wenay-react2 follow-up (separate repo, after this lands)

`useStoreReplayEach(remote, cb, opts)` — hook wrapper over syncStoreReplayEach (cb via ref,
StrictMode-safe, `stale`/`ready` like useReplaySubscribe). Small; not a blocker.
