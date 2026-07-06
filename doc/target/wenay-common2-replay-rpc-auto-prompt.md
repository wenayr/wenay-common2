# wenay-common2: replay-transparent RPC exposure (feature prompt, rev 2)

Goal: upgrading a stream from `UseListen` to `UseReplayListen` must be a ONE-WORD change
at the declaration site. No facade edits, no separate `exposeReplay` key, no client
migration. Consumers opt into the replay surface per need; legacy subscribers never
notice the difference. `UseReplayListen` is simply an extended `UseListen` — the whole
infrastructure (wire, gates, recovery) picks the extension up automatically.

Additive only. `exposeReplay`/`replaySubscribe`/`conflateReplay` keep working as the
explicit manual path (`ConflateOpts.keyOf` becomes `@deprecated`, never removed).

Rev 2 (2026-07-06): Feature B redesigned around a single line-owned `frame(sinceSeq)`
method. All content semantics (entity keys, coalescing, skip rules) moved out of the
transport into producer-declared lambdas. Interval delivery became client-side pull.

## Design rules (bind every feature below)

1. **The transport sees ONLY `seq`.** The rpc server and lag gates never inspect event
   content and never know about entities/symbols/paths.
2. **No name-indexed configuration.** Behavior attaches to the line (producer's
   declaration) or to the subscription (consumer's call site) — never to a
   "facade-key → settings" map in between.
3. **A frame is ordinary envelopes of the line's own event type.** The consumer applies
   keyframes, mini-frames and live events with ONE mechanism and cannot tell which kind
   arrived.

## Frame model — one method, two sources, three triggers

New line member (`withReplayListen` / `UseReplayListen`):

```
frame(sinceSeq[, hint]) → envelopes bringing a consumer from sinceSeq to head,
                          as compact as the line allows
```

Default implementation: `getSince(sinceSeq) ?? keyframe()` — exact journal tail;
evicted → full keyframe. Producer options refine it at the declaration site:

```ts
const [emit, quotes] = UseReplayListen<[Quote]>({
    history: 4096,
    current: () => [book.snapshot()],    // source 1: pointer to truth (I-frame)
    frame: tail => lastPerSymbol(tail),  // source 2: accumulation mini-frame
})
```

Two frame sources:

- **Keyframe** (`current`) — full state sampled from the owner of truth. Cost ~ state
  size, independent of gap length. Never computed from deltas — always sampled.
- **Mini-frame** (`frame` lambda) — receives the raw journal tail after `sinceSeq`,
  returns a condensed/aggregated state-equivalent set. Cost ~ touched entities. Wins
  over keyframe whenever the journal still covers the gap; keyframe is the fallback,
  not a competitor.

Three triggers, same method: reconnect (`since` over the wire), client pull (consumer
calls it on its own timer — this replaces any server-side interval mode), and gate
drain after lag (Feature B).

**Line classes follow from the declared lambdas — no mode flags:**

| declared          | class                 | lag / eviction behavior                    |
|-------------------|-----------------------|--------------------------------------------|
| `current`+`frame` | condensable           | mini-frame; keyframe fallback              |
| `current` only    | snapshot-recoverable  | keyframe                                   |
| neither           | sacred queue          | full tail only; evicted → LOUD error       |

- Sugar: `current: 'last'` — single-entity lines (one symbol): keyframe = last
  journaled envelope, taken from the ring; producer keeps no state by hand.
- Aggregate frames are legal: a non-condensable but summarizable line declares its
  event type as a union (`Trade | TradeGapSummary`) and returns one synthesized
  envelope with `seq = head`. The consumer handles the gap variant because the type
  forces it to.
- `hint` (optional, cheap): opaque subscriber-supplied value passed verbatim to the
  `frame` lambda — arbitrary skip rules live in producer code, selected per
  subscription. Ship without it if it bloats A+B.

## Feature A — auto-detection in `createRpcServerAuto`

When a facade value is a replay listen, expose BOTH surfaces under the SAME key:

1. **Legacy path unchanged:** subscribing to the key as a plain Listen behaves exactly
   as if the facade had exported the base listen — live events byte-for-byte. Existing
   callback-style clients must not change.
2. **Replay path:** the key also carries the wire surface — `line` (plain Listen),
   `since`/`keyframe` (plain methods, kept with exact rev-1 semantics for old clients)
   plus new `frame` — so `replaySubscribe(remote.key)` works directly.
   `replaySubscribe` prefers `frame` when present, falls back to `since`/`keyframe`
   against old servers (additive both ways).

Implementation notes (from code review):

- Detection by **brand symbol** set in `withReplayListen` — structural sniffing
  forbidden. NB: the replay api passes `isListenCallback`, so the brand check must come
  FIRST in `resolveTransform` (rpc-server-auto.ts).
- `Pkt.MAP` grows additively (extra members under the same key). Events stay
  byte-for-byte; the MAP growth must be tolerated by old clients — harness-verified.
- Server `throttle` must NOT apply to the replay `line` (dropped envelopes = silent
  seq gaps). Bypass and document.
- Opt: `replay: false | 'auto' (default) | 'force'` — global server option, no per-key
  map (rule 2).

## Feature B — server-owned lag gate (redesigned)

The gate is content-blind and stores ONE number per subscriber: last delivered seq.
No held-map, no `keyOf`, no `maxKeys` — that machinery is superseded.

- **Policy is per-SUBSCRIPTION, consumer-owned:** `'queue'` (default — today's
  behavior byte-for-byte: the socket buffers everything) | `'frame'` (the server may
  skip: on lag stop forwarding, on drain send `line.frame(lastSeq)`). The subscribe
  call carries the policy; exact wire encoding is implementer's choice.
- Backpressure signal derives from the server's own socket (socket.io:
  `socket.conn.writeBuffer.length`), with an overridable `pending` supplier.
  Thresholds `{highWater, lowWater = 0, pollMs = 25}` are connection-scoped server
  defaults — no line names (rule 2).
- Gates close on the server's own disconnect handling — no app wiring.
- Class × policy corner: `'frame'` subscriber on a sacred line whose journal got
  evicted → loud error to THAT subscriber (error event / stream end), never silent
  loss. `'queue'` subscriber on any line: no gate; server self-protection stays the
  existing socket hard limits (disconnect).
- The journal is written BEFORE any gate, uncondensed — reconnect via `since` is
  honest regardless of what frames a client received while alive.
- store integration: `exposeStoreReplay` declares its condensing `frame` automatically
  (last patch per exact path — the current `storePatchKey` logic, now an internal
  detail of the store-replay layer).

## Feature C (optional, smaller) — store transparency

Unchanged from rev 1: a facade value that IS an ObserveAll2 `Store` could auto-expose,
but exposing a raw store puts the write surface (`set`/`replace`) on the wire — keep it
explicitly opt-in via a tiny marker wrapper (`ObserveAll2.expose(store, opts?)`), not
duck-typing. Ship A+B first.

## Contracts / edge cases

- A replay listen exposed under 'auto' must not double-journal or double-subscribe the
  base producer; the rpc layer only projects existing surfaces.
- Legacy and replay subscriptions coexist on one connection; `'queue'` and `'frame'`
  subscribers coexist on one line.
- **Frame contract:** envelopes with `seq ∈ (sinceSeq, head]`, monotonic;
  state-equivalent to the full tail per the line's declared semantics; a synthesized
  aggregate = one envelope with `seq = head`. `frame` may throw — the gate/wire MUST
  surface the error to the affected client loudly.
- `since`/`keyframe`/`frame` are per-line, shared across connections; gate state (one
  seq per subscriber) is per-connection.
- RpcLimits apply to keyframe/frame payloads (they can be large) — a payload exceeding
  limits fails that call loudly, no silent truncation.
- Correctness of producer lambdas (events absolute per entity, `frame`
  state-equivalence) cannot be checked by the library — it is the producer's declared
  contract, carried by docs and oracles.

## Oracles / QA

- Wire harness: facade with a `UseReplayListen` member — (a) legacy client subscribes
  plain, sees live events identical to a `UseListen` baseline; (b) replay client
  `replaySubscribe` with `{since: 0}` folds journal + live with no gaps/dups; (c) both
  at once on one connection; (d) old client tolerates the additive Pkt.MAP growth.
- Frame equivalence: `apply(full tail) == apply(frame(seq))` for condensable lines —
  a store line and a quotes-style line.
- Lag sim: one connection, `'queue'` + `'frame'` subscribers on the same line; slow
  socket → queue client eventually gets everything, frame client recovers via frame;
  gate closed on disconnect (no leak, no timer leak).
- Sacred line: `'frame'` subscriber + evicted journal → loud error, not silence.
- Degenerate case: `current: 'last'` single-entity line — keyframe == last envelope;
  mini-frame of depth 1 == keyframe.
- Auto-detection negative: plain `UseListen` members and ordinary objects with a `line`
  property must NOT be misdetected (brand check).

## Docs

`wenay-common2-rare.md` replay section: the frame model (two sources, line classes
follow from declared lambdas), per-subscription `queue | frame` policy, client-pull
pattern for interval delivery. Rpc section: one paragraph — "facade members that are
replay listens are exposed with both surfaces; upgrading UseListen→UseReplayListen is a
declaration-site-only change".

## Deferred

- History-over-the-wire (projecting `ReplayStorage`/`openHistory` through rpc) — the
  seam is ready, nothing in A+B blocks it.
- Server-side interval mode — superseded by client pull over `frame`.
- `hint` pass-through if it bloats A+B.
- Feature C shipping decision.
