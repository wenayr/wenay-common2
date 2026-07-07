# wenay-common2 offline store hypothesis

## Motivation

`Observe` already has most of the machinery needed for offline-first state:

- `createStore()` gives the client a local reactive store.
- `exposeStoreReplay()` turns a backend store into a sequenced patch line.
- `syncStoreReplay()` applies keyframes, tails and live patches into a mirror.
- replay `seq` gives a stable reconnect coordinate.

The missing layer is an ergonomic persisted mirror: a client should be able to mark a remote
store as offline-capable, preload it when useful, read it immediately without network, and let
the library handle catch-up and durable writes.

## Core idea

Add a small offline/persist layer above `Observe` and `Replay`, not a React-only feature.

The store/replay layer is the correct place because it already sees exact `StorePatch` values
and replay envelopes. React can show status and request priority, but it should not infer what
changed from renders or object comparison.

Default model:

```ts
const portfolio = await Observe.createOfflineStore({
    key: "portfolio",
    remote: api.portfolio.replay,
    initial: {positions: {}, orders: {}},
    storage: indexedDbStorage(),
})
```

This should:

1. Read a local persisted snapshot.
2. Create a normal `Observe` store from it.
3. Return the store immediately for UI reads/subscriptions.
4. When network is available, call `syncStoreReplay(store, remote, {since: savedSeq})`.
5. Persist new local state in the background.

## Sequence vs timestamps

`seq` is the correctness coordinate. It is not wall-clock time.

```ts
{
    version: 1,
    seq: 12345,
    snapshot: {...},
    savedAt: 1783440000000,
}
```

- `seq` means: "this local cache includes the replay line up to event N".
- `savedAt` means: "the client wrote this cache at this time".
- domain timestamps inside data, such as `updatedAt`, mean: "this entity was fresh at this
  source/domain time".

The offline sync can work without timestamps. Time is useful for UX and freshness policy, not
for patch ordering.

## Storage modes

Start with two modes.

### Mode 1: snapshot storage

Best default for small and medium stores.

```ts
storage.write("portfolio", {
    version,
    seq,
    snapshot: store.snapshot(),
    savedAt: now(),
})
```

Pros:

- Simple.
- Robust.
- Easy to migrate.
- No recursive persistence rules.

Cons:

- Large stores rewrite more data than necessary.

### Mode 2: top-level chunk storage

Advanced mode for large dictionary-like stores.

```ts
portfolio/meta -> {version, seq, savedAt, keys}
portfolio/key/BTCUSDT -> {value, exists, dataSeq}
portfolio/key/ETHUSDT -> {value, exists, dataSeq}
```

Use `store.each()` or incoming `StorePatch` paths to persist only changed top-level keys.
Root keyframes must expand into top-level writes and deletions.

Do not make deep recursive chunking the first public API. It adds policy questions that users
should not face in the default path.

## Durable write rule

Never advance durable `seq` before the corresponding data is written.

Preferred order:

```ts
write snapshot or chunks
write meta.seq
```

If the process crashes between data and seq writes, the client may replay some already-applied
patches on next startup. That is acceptable. The opposite is not acceptable: a saved `seq`
without the data it represents can create a silent state hole.

When the storage adapter supports transactions, data and meta should be committed atomically.

## API sketch

```ts
type OfflineStorage = {
    read<T>(key: string): Promise<T | undefined>
    write<T>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
    transaction?<R>(fn: (tx: OfflineStorage) => Promise<R>): Promise<R>
}

type OfflineStoreOpts<T extends object> = {
    key: string
    remote: ReplayRemote<[StorePatch]>
    initial: T
    storage: OfflineStorage
    version?: number
    debounceMs?: number
    mode?: "snapshot" | "topLevel"
    migrate?: (old: unknown, fromVersion: number, toVersion: number) => T | Promise<T>
    onStatus?: (status: OfflineStoreStatus) => void
}

type OfflineStoreStatus = {
    ready: boolean
    syncing: boolean
    offline: boolean
    stale: boolean
    seq: number
    savedAt?: number
    error?: unknown
}
```

Possible public functions:

```ts
Observe.createOfflineStore(opts)
Observe.persistStore(store, opts)
Observe.preloadOffline(resources, group)
```

## Preload model

Preload should be resource-manifest based, not a blind recursive walk of every store.

```ts
offline.resource({
    key: "portfolio",
    group: "core",
    remote: api.portfolio.replay,
    initial: {positions: {}, orders: {}},
    storage,
})

await offline.preload("core")
```

The app can declare groups:

- `core`: profile, settings, portfolio summary.
- `heavy`: history, candles, logs.
- route-specific resources: loaded with higher priority when a page opens.

The default should be convenient: mark a resource offline-capable, and it works. Advanced users
can opt into chunking, TTL/freshness policy, and custom storage.

## React boundary

React should be a thin consumer layer:

- subscribe to the local store;
- display `ready`, `syncing`, `offline`, `stale`;
- request preload or raise priority for a page.

React should not:

- calculate patches;
- diff snapshots;
- own replay `seq`;
- decide durable write ordering.

Those are library invariants and belong in `wenay-common2`.

## Initial implementation path

1. Add an `OfflineStorage` adapter interface and memory adapter for tests.
2. Implement snapshot-mode `createOfflineStore()`.
3. Persist `{version, seq, snapshot, savedAt}` with a debounce.
4. Wire `syncStoreReplay()` with `since: savedSeq` and `onSeq`.
5. Add tests for cold start, reconnect by seq, crash-safe write order, and keyframe fallback.
6. Add top-level chunk mode after the snapshot mode is stable.
7. Add browser `IndexedDB` storage as a separate adapter or example.

## Open questions

- Should storage adapters live in core package or in optional subpaths?
- Should snapshot persistence subscribe through `store.listenPaths()` or wrap
  `syncStoreReplay()` to persist incoming patches before applying them?
- Should `createOfflineStore()` return before remote catch-up or expose `ready` for catch-up?
- How should auth/user switching clear or namespace persisted resources?
- Do we need app-level quota/eviction policies in the first version, or just adapter hooks?
