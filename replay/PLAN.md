# replay/ — oracles for the Snapshot + Sequenced Delta Line (REPLAY-PLAN.md)

ASSEMBLED into `src/` (2026-07-05): this directory now holds only the oracles/demos,
importing the canonical modules (same pattern as `observe/`). Canonical code:

- `src/Common/events/replay-listen.ts` — layer A (`withReplayListen`/`replayListen`)
- `src/Common/events/replay-wire.ts` — wire pair (`exposeReplay` ⇄ `replaySubscribe`)
- `src/Common/events/replay-route.ts` — route hand-off helper (`replayRouteSubscribe`)
- `src/Common/events/replay-conflate.ts` — `conflateReplay` (layer D.1)
- `src/Common/events/replay-history.ts` — `ReplayStorage`/`createMemoryReplayStorage`/
  `archiveReplay`/`openHistory` (layer C)
- `src/Common/events/replay-index.ts` — barrel; root export `Replay`, subpath
  `wenay-common2/replay`
- `src/Common/Observe/store-replay.ts` — layer B (`exposeStoreReplay`/`syncStoreReplay`/
  `storeReplayAt`), in the `Observe` namespace/subpath
- `src/Common/events/Listen.ts` — canonical Listen import surface; the implementation has
  the additive exports (`registerListenOn`, `ListenOnBrand`) used by replay
- RPC harness (`rpc.harness.spec.ts`) — cookbook block: replay line over the loopback
  (keyframe sync, live patches, reconnect via since = tail, not a snapshot)

## Files (oracles)

- `replay-listen.test.ts` — oracle for layer A (22 checks).
- `store-replay.test.ts` — oracle for layer B in-proc with simulated wire lag (14 checks).
- `socket-replay.test.ts` — layer B over a REAL Socket.IO websocket + RPC (11 checks).
- `route-handoff.test.ts` — transport-agnostic relay ↔ direct route switch over replay,
  failed replacement fallback, and store mirror hand-off (17 checks).
- `video-socket.demo.ts` — "video" over the line: bouncing-ball frames as store patches,
  late viewer gets keyframe not backlog, lagging viewer catches up via delta tail (7 checks).
- `canvas-socket.test.ts` — RAW BYTES over the line: Uint8Array RGBA dirty-rects +
  full-frame keyframes over real Socket.IO, byte-for-byte checks (8 checks). Exercises
  the binary passthrough in `src/.../rpc-walk.ts`.
- `conflate.ts` — layer D.1 (stage 3): `conflateReplay` — per-client conflation gate
  + snapshot recovery, built per connection over `exposeReplay`.
- `conflate.test.ts` — oracle for the gate: generic line, per-client independence,
  store mirror over a lagged wire (26 checks).
- `coalesce.test.ts` — oracle for key-level coalescing (`keyOf` in `conflateReplay`):
  last-per-key tail instead of a full keyframe, degradation on unkeyable events /
  maxKeys overflow, store mirror with `storePatchKey` incl. ancestor/descendant
  path interleave and reconnect via since (30 checks).
- `conflate-socket.test.ts` — per-connection gate over a real Socket.IO wire (9 checks).
- `history.ts` — layer C (stage 4): `ReplayStorage` lambda interface + memory reference
  impl, `archiveReplay` (event log + keyframe cadence), `openHistory` (seek by seq/ts,
  playback with archive → live-journal → live handover).
- `history.test.ts` — oracle for layer C: cadence, seek, holes, double handover,
  rewind-to-ts-then-live, store time machine, file(jsonl)-backed storage (27 checks).

Run: `npx ts-node replay/<file>.ts` — all green as of 2026-07-05 (against `src/` copies).

## Status

- [x] Stage 1 — `withReplayListen` decorator + seq handover (layer A)
- [x] Stage 1.5 — wire pair (`exposeReplay`/`replaySubscribe`): works over the EXISTING
  RPC untouched — envelope line is a plain Listen, since/keyframe are plain methods
- [x] Stage 2 — store integration (`exposeStoreReplay`/`syncStoreReplay`) + real-socket tests
- [x] Route hand-off helper — `replayRouteSubscribe` / `syncStoreReplayRoute`: old route
  stays live, replacement route catches up from `seq`, then the old route closes; overlap is
  deduped by `seq`, failed replacement leaves the old route active.
- [x] Binary passthrough (layer D item 4, done in `src/` directly — additive):
  `rpc-walk.walk()` treats TypedArray/DataView/Buffer/ArrayBuffer as leaves (checked
  BEFORE `Object.keys` — keys of a big buffer are millions of strings), socket.io carries
  them natively; new `maxBinaryLen` limit (default 8MB). RPC harness green.
- [x] Stage 3 — per-client conflation + snapshot recovery (`conflateReplay`): outgoing
  buffer over highWater → deltas STOP for that client (dropped, not queued); drained →
  fresh keyframe on the same line + deltas resume from its seq. Client code unchanged —
  seq dedup already handles the overlap.
- [x] Stage 4 — history storage (layer C): storage = 4 lambdas (`putEvent`/`putKeyframe`/
  `getKeyframe`/`getEvents`), archiver with GOP cadence (every N events OR T ms, whichever
  first, frames only ON events — quiet line changes nothing), reader with seek by seq/ts
  and playback that hands over archive → live journal → live.
- [x] Key-level coalescing (layer D): `keyOf` + `maxKeys` opts on `conflateReplay` —
  while a client lags, a map key → LAST envelope is kept instead of a pure drop; on
  drain the tail of last-per-key envelopes (ascending seq) is flushed instead of a
  full keyframe. Unkeyable event (keyOf → null) or over maxKeys → the episode degrades
  to classic keyframe recovery. `storePatchKey` = ready keyOf for store patch lines.
- [ ] Rest of layer D (optimizations, on demand): serialize-once fan-out (pack an envelope
  once, send bytes to all subscribers).
- [x] Assembly — canonical copies in `src/` (Listen additions additive; store-replay beside
  store.ts), exported as `Replay` namespace + `wenay-common2/replay` subpath and via
  `Observe`; oracles rewired to import `src/`, duplicated impls deleted; replay
  cookbook block added to the RPC harness. Everything is ADDITIVE — nothing existing
  was changed or replaced (Listen/exposeStore/mirror behavior untouched).

## Design decisions (implemented)

- **Journal entry** = `{seq, ts, event}`; seq is the coordinate (monotonic from 1), ts an
  attribute (injectable `now`). Only the decorated `func` numbers events; emits past the
  decorator are delivered live but never journaled (tested).
- **Memory external or internal**: `history: N` = internal ring (O(1) write); `getSince(seq)`
  + `onJournal(ev)` = external journal lambdas (priority). `undefined` from getSince = evicted.
- **Sync handover** (on(cb, {since})): subscribe live first (liveTap reads the in-flight
  seq from a save/restored `emitting` slot), replay tail, drain re-entrancy queue; dedup by
  strict `seq > lastDelivered`. No gap, no dup.
- **Async (wire) handover** (`replaySubscribe`): same queue+dedup, but tail/keyframe are
  awaited. Needs an ORDERED transport (socket.io/TCP, in-proc): the line subscription is
  established server-side before `since()` executes → no gap; overlap is killed by seq dedup.
- **Fallback = killer property**: evicted seq or seq from the future (server restarted) →
  fresh keyframe + live from head. `lastDelivered` resets DOWN too — a stale big seq must
  not mute the new life's events (bug found by test, fixed in both sync and async paths).
- **Keyframe is an event of the same type**. For stores: a root patch
  `{path: [], exists: true, value: snapshot}` — the mirror applies ONE mechanism
  (`applyStorePatch`) for snapshot and deltas alike.
- **RPC core untouched**: `on(cb, opts)` opts do NOT travel over the existing wire
  (listen-socket passes only the callback), so the wire surface is `{line, since, keyframe}` —
  a plain Listen + two plain methods. Nothing to change in rpc-*.
- **exposeStoreReplay journaling is HOT** (subscribes listenPaths immediately): the journal
  must see every change even with zero subscribers, or the line has holes.
- `replaySubscribe` returns `off` with `.ready` (catch-up finished) and `.seq()` (reconnect
  point). Reconnect = call again with `{since: prev.seq()}`.
- **Conflation is a per-connection decorator** (`conflateReplay`), transport-agnostic:
  buffer fullness is a `pending()` lambda (for socket.io — e.g. `socket.conn.writeBuffer.length`),
  units are whatever pending/thresholds agree on. Built where the per-connection RPC server
  is built; `api` spreads in place of `exposeReplay(...)`; `close()` on disconnect.
- **Recovery keyframe rides the SAME line envelope** — the client cannot tell conflation
  from normal flow; `kf.seq == head` and strict seq dedup cut the overlap. Recovery fires
  on the next line event (journal is written before fan-out, so the keyframe already
  covers it) or, on a quiet line, via a `pollMs` interval.
- Deltas over highWater are **dropped, never queued** (killer property server-side).
  `hasKeyframe` (additive flag on the replay api) guards construction: a gate without a
  current provider would silently lose data — it throws instead.
- **Key-level coalescing correctness**: events must be ABSOLUTE per key (fully determine
  the key's state — store patches are). The episode map refreshes insertion order on
  update (delete+set), so iteration order = last-touch order = ascending seq; the flushed
  tail is a subsequence of the line where every omitted envelope is masked by a later
  one with the same key — this covers ancestor/descendant path overlap too (an ancestor
  patch carries its whole subtree). Client code unchanged: original seqs, strict dedup,
  gaps are normal. Memory is bounded by distinct keys (maxKeys), not events; the
  current-provider requirement stays because degradation needs a keyframe.

## Measured wire behavior (socket tests)

- Fresh client: exactly 1 keyframe request, 0 tail requests, 0 `get()` pulls (pure push).
- Short lag: tail of exactly the missed patches, NO snapshot.
- Long offline past the ring: 28 missed patches collapse into 1 keyframe — no backlog, ever.
- Stalled client (conflation): 22 patches dropped server-side, the wire carried exactly
  1 envelope (the recovery keyframe) once the buffer drained; other clients unaffected.
- Stalled client with `keyOf: storePatchKey`: 20 patches of 2 paths collapsed into
  2 delta envelopes — the big store snapshot never travelled at all.

## Layer C design decisions (implemented)

- **Storage is 4 lambdas** (`ReplayStorage`: `putEvent`/`putKeyframe`/`getKeyframe`/`getEvents`),
  the archiver/reader own no data. Memory reference impl doubles as the oracle for
  file/DB impls (the test proves a naive jsonl file storage behaves identically).
  Contracts: `getKeyframe` = nearest ≤ seq/ts (no arg — latest), `getEvents` = (from, to]
  ordered by seq.
- **Keyframes are written only ON events**: with no events the state didn't change, a
  frame would add nothing → the archiver has no timers at all. Cadence = every N events
  OR T ms of line-ts, whichever first; plus one base frame at attach.
- **Reader = the same subscriber interface**: `openHistory(storage, live?).subscribe(cb,
  {since|ts, onSeq})` — archive part first, then `live.on(cb, {since: last})`: the
  existing sync handover closes the archive→now gap from the live journal. Hole in the
  archive → fresh start from the latest keyframe; reset DOWN is allowed (redundant but
  consistent deliveries beat a state hole). Without `live` it's pure playback.
- **Seamless rewind→live** needs the live journal to BE the archive: create the line with
  `getSince: s => storage.getEvents(s, Infinity)` («memory outside» — the option existing
  since stage 1). Otherwise the archive→live gap closes with a keyframe jump — still
  correct, just not continuous.
- **Store time machine** = `storeReplayAt(storage, {seq|ts})`: scratch store + the same
  `applyStorePatch` for keyframe and deltas; bit-exact even when the live ring is tiny.
- Live store is never reset — archive = labeled copies on the side.

## Notes for later stages
- **Binary frames**: DONE — rpc-walk passes TypedArray/ArrayBuffer through as leaves
  (see canvas-socket.test.ts: 12kb raw vs ~97kb mangled JSON per frame). A REAL codec
  stream (H.264) differs only in that an I-frame is NOT computable on demand — `current`
  must return the last archived I-frame + tail from its seq (layer C lambdas).
- **Conflation**: DONE — see design decisions above. **Key-level coalescing**: DONE —
  `keyOf`/`maxKeys` opts on the same gate (see design decisions). Remaining D item:
  serialize-once fan-out (pack an envelope once, send bytes to all subscribers) — a
  further decorator on the same line, nothing in the core changes.
