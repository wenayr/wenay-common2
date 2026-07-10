# Snapshot + Sequenced Delta Line — universal state sync

One pattern for everything: **keyframe (snapshot) + numbered line of deltas + recovery via fresh keyframe**.
Payload-agnostic: store patches, ticks, any events. Same figure as market-data feeds
(incremental + snapshot channel), DB replication (basebackup + WAL), video (I/P frames), Kafka.

## Invariants

- **seq is the coordinate, time is an attribute.** Every journaled event: `{seq, ts, event}`.
  seq = monotonic counter → strict order, gap detection, exact replay→live handover.
  Time is for humans only: "rewind to 12:00" resolves to nearest keyframe ≤ ts → its seq.
- **Keyframe = state as of seq S.** Rule of the whole system:
  `keyframe(S) + events S+1…K = exact state at K`.
- **Memory stays external** (lambda providers), decorators own no data they don't have to.
- **Additive only.** The canonical Listen surface is untouched; new surface = decorator + opts.
- The live store is never reset: archiving = take a labeled copy, keep mutating the same store.

## The killer property (drives everything)

A lagging/late/reconnecting consumer never gets a queue backlog — it gets a **fresh keyframe
+ the line from there**. This is both the catch-up mechanism AND the backpressure policy
(conflation + snapshot recovery). No unbounded buffering, ever.

## Layers

### A. Listen replay decorator — `withReplayListen` (universal, payload-agnostic)

Decorator over `ListenApi`, exact shape of `withStoreListen`:

```
withReplayListen(base, {
    current,                       // () => keyframe        — external memory lambda (exists: layer 3)
    history?: number,              // ring buffer size N (internal) …
    getSince?: (seq) => events[],  // …or external journal lambda (memory outside — preferred)
})
```

Subscription modes:
- `on(cb)` — live only (unchanged)
- `on(cb, {current: true})` — keyframe + live (unchanged, layer 3)
- `on(cb, {since: seq})` — catch-up: replay journal from seq+1, queue live events by seq
  during replay, dedup by seq, seamless switch to live. seq evicted from journal →
  fallback: keyframe + live.

The handover (replay→live without gap or dup) is the ONLY subtle code in the plan.
Everything else is mechanics.

### B. Observe store integration

- `exposeStore`: patch journal — every emitted `StorePatch` gets seq; keep last N (ring).
  `snapshot()` responses carry the seq they correspond to.
- `createStoreMirror`: sync = "I have seq K" → tail of patches, or snapshot(S) + live from S+1.
  Reconnect stops costing a full snapshot when the tail suffices.
- Uses layer A; store adds nothing but "patch as the event type".

### C. History storage (optional, lazy, fully external)

For seek into the past — not needed for live sync:
- periodic archiving: keyframe every N events OR T seconds, whichever first (GOP tradeoff:
  dense = fast seek / more space, sparse = cheap / longer replay);
- providers: `getKeyframe(seqOrTs)`, `getEvents(from, to)` — file/DB/anything, behind lambdas;
- a history reader is the SAME subscriber interface: subscribe `{since}` → archive replay →
  journal catch-up → live. One mechanism for playback and live.

### D. Transport hardening (independent add-ons, any order, later)

- **Per-client conflation**: outgoing buffer over threshold → stop deltas for that client,
  mark "needs keyframe"; buffer drained → fresh snapshot + resume from current seq.
- **Serialize once, fan out**: pack a tick once, send bytes to all subscribers
  (extends existing Caps.COMPACT / shape packing).
- **Coalescing**: N updates of one key while client lagged → send only the last.
- **Binary passthrough** in `rpc-walk`: TypedArray/ArrayBuffer/Buffer as leaf values
  (socket.io carries binary natively; today walk() mangles them into `{0:…,1:…}`).

## Stages

1. `withReplayListen` decorator + seq handover (layer A) — the core, small.
2. Patch journal in `exposeStore` + `since`-sync in mirror (layer B).
2.5. **Route hand-off helper** — `replayRouteSubscribe` / `syncStoreReplayRoute`: keep the
   old route live, catch up the replacement from the last delivered `seq`, then close the old
   route. This is the replay-level foundation for relay ↔ direct promotion; signaling and
   direct-transport setup remain outside this layer.
3. Conflation + snapshot recovery on the wire (first item of D) — this is what turns
   "semi-pro" into pro for fan-out.
4. C and the rest of D — on demand.
