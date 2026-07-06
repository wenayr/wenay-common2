# wenay-common2 Replay: staleness watchdog + conflate ergonomics (feature prompt)

Three additive changes: two features for the Replay stack (`src/Common/events/replay-*.ts`)
and one hot-write scaling fix in the reactive core (`ObserveAll2/reactive2`). No breaking
changes: existing `withReplayListen` / `exposeReplay` / `replaySubscribe` signatures keep
working unchanged.

## Motivation

Replay's delivery contract is excellent at *consistency* (keyframe-first, no gaps, no dups)
but silent about *freshness*. A consumer that trades real money must distinguish two
failure modes the current API hides:

1. **Silent line.** The producer died or its upstream socket dropped; the line stays open,
   no envelopes arrive. The subscriber sees nothing — no event, no error.
2. **Stale keyframe.** A new subscriber (or a reconnect) receives a keyframe *now*, but the
   producer stopped long ago — the keyframe's `ts` is old. The data arrives "fresh over the
   wire" while being minutes stale. `current:`-style snapshots have the same issue.

Today every consumer must hand-roll a watchdog over `line.on` envelopes (`{seq, ts, event}`).
The envelope already carries `ts` — the mechanism belongs under the hood, behind options,
like the rest of the stack.

## Feature A — staleness watchdog

### A.1 Producer side: `ReplayListenOptions`

```ts
type ReplayListenOptions<Z> = {
    // ...existing
    staleMs?: number                                   // no journal event for staleMs -> stale
    onStale?: (info: tStaleInfo) => void               // edge-triggered, both directions
}
type tStaleInfo = {stale: boolean, lastTs: number, age: number}
```

Requirements:
- Edge-triggered on BOTH transitions (fresh→stale and stale→fresh), not a repeating alarm.
- No timer while `count() == 0` and no `onStale` installed — a cold line must stay free.
- Expose getters on the replay api: `isStale()`, `lastTs()`.
- Respect the existing `now?: () => number` override (tests).

### A.2 Client side: `ReplaySubscribeOpts`

```ts
type ReplaySubscribeOpts = {
    // ...existing
    staleMs?: number
    onStale?: (info: tStaleInfo) => void
}
// returned off gains: off.isStale(), off.lastTs()
```

Client-side staleness has two independent signals — implement both, document which fires:
- **Arrival gap** (local clock only, no skew): time since the last envelope was *received*.
  Catches the silent-line case even when producer and client clocks disagree.
- **Envelope `ts` age** (producer clock): catches the stale-keyframe case — a keyframe that
  arrives now with an old `ts` must immediately report stale. Document the clock-skew
  caveat; a small `skewMs` tolerance option is acceptable.

A keyframe/catch-up delivery must update `lastTs` like any event (it IS an event of the
same type per the delivery contract).

### A.3 wenay-react2 follow-up (separate repo, after A lands)

`useReplaySubscribe` / `useStoreReplayMirror` controllers gain `stale` (reactive boolean,
re-render on transition only) and `lastTs()` (getter, non-reactive — high-frequency lines
must not re-render per event).

## Feature B — conflate ergonomics

`conflateReplay` is per-connection by design (it needs the connection's outgoing-buffer
`pending()`), so each exposed channel currently costs a manual block where the rpc server
is built: build gate → spread `gate.api` in place of `exposeReplay(...)` → `gate.close()`
on disconnect. With several channels this is copy-paste.

Add a convenience that keeps the per-connection nature but collapses the wiring:

```ts
exposeReplay(replay, {
    conflate: {pending, highWater, lowWater?, pollMs?, keyOf?, maxKeys?},
}) -> {line, since, keyframe, close, stats}
```

- Without the option — exact current behavior and return shape (additive).
- With the option — internally `conflateReplay(replay, opts)`, returns its `api` spread
  plus `close` (caller wires it to disconnect — one line) and `stats`.
- Multiple channels on one connection: each call creates its own gate; document that
  `pending` is usually shared (same socket buffer).

## Feature C — hot-write scaling in the reactive core

Context: a store used as a tick-fed quote map (`state[symbol] = quote`, hundreds to
thousands of distinct keys dirtied per drain window) with a `changedPaths` consumer
attached (the store-replay line subscribes to paths, so `pathLive > 0`).

Two spots in `reactive2` cost per-write on this pattern:

1. **`addDirtyPath` dedup is a linear scan** — `eng.dirtyPaths.some(p => samePath(p, path))`.
   N distinct dirty paths per drain window ⇒ O(N²) `samePath` comparisons per flush cycle.
   At ~2000 symbols per window this is millions of calls. Replace with a keyed structure
   (path-key Set / StructSet-style) while keeping insertion order for the emitted array.
   Symbol keys in paths must stay identity-safe (the current collision-safe route identity
   must be preserved).
2. **`dirtyPathFor` allocates the path array unconditionally**, before the `eng.live > 0`
   check in the `set` trap. Cold stores (no subscribers) pay an allocation per write.
   Compute it only when someone will consume it (`live > 0`, and the full path only when
   `pathLive > 0`).

Both are internal; no API change. Oracle: a micro-bench in the store tests — 2000 keys
written per window with a `changedPaths` subscriber, assert near-linear scaling
(e.g. 4x keys ⇒ ~4x time, not ~16x).

## Oracles / QA

- Extend `replay/` oracles: silent-line watchdog (stop emitting → stale fires once →
  resume → fresh fires once); stale keyframe (producer stops, new subscriber gets keyframe,
  stale reported immediately); cold line creates no timer (subscribe/unsubscribe leak check).
- Wire case in the rpc harness: client-side arrival-gap staleness across a real socket,
  including reconnect with `{since}`.
- Conflate case: `exposeReplay(replay, {conflate})` behaves byte-for-byte like the manual
  `conflateReplay` spread (reuse the existing conflate-socket oracle).

## Docs

Update `wenay-common2-rare.md` (Replay section): options on `withReplayListen` /
`UseReplayListen` / `replaySubscribe`, the two failure modes, the clock-skew note, and the
one-call conflated expose. One sentence in the brief README's Replay paragraph: freshness
is an option, not consumer boilerplate.
