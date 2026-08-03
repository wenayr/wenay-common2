# Lazy Store line stand — August 2026

One question: on a link slow enough to matter, what does a subscriber pay to reach
current Store state?

- **keyframe** — `syncStoreReplay`: one monolithic snapshot, then live deltas.
- **lazy** — `syncStoreLazyLine`: progressive merge fill, values read at send time,
  changes to not-yet-sent keys suppressed.

Both run over a **real** socket.io + RPC connection through the shared metered relay
(`experiments/_shared/metered-relay.ts`), against the same Store under the same churn,
inside one process. Numbers are comparable within a run; they are not capacity claims.

## What is measured

| Column | Meaning |
|---|---|
| `firstDataMs` | when the mirror first holds ANY key — what a person actually waits for |
| `convergedMs` | when the mirror matches the authoritative Store exactly |
| `wireKiB` | server→client bytes counted on the relay, WebSocket framing included |
| `converged` | false = the candidate did not reach agreement inside the timeout |

`firstDataMs` is the column the lazy line exists for. `convergedMs` is where a
monolithic keyframe can win when the Store is small and quiet, because it makes one
request instead of many.

## Profiles

| Profile | Keys | Churn |
|---|---:|---|
| `symbols-350-churn-120` | 350 | 120 keys rewritten every 250 ms (~480 keys/s) |
| `symbols-350-quiet` | 350 | none — isolates transfer cost from churn |
| `board-20000-churn-100` | 20 000 | 100 keys every 250 ms |

**Churn must stay below link capacity.** At ~140 wire bytes per quote on a 128 KiB/s
link, roughly 900 keys/s saturates the line; beyond that no protocol converges and the
stand measures nothing but the overload. The profiles above sit near half the line. An
earlier draft of this stand used 500 keys every 25 ms — about 19x the link — and simply
hung. If you raise churn, raise `LAZY_BENCH_LINK_BPS` with it.

## Run

```bash
npm run experiment:store-lazy
```

Environment overrides:

```powershell
$env:LAZY_BENCH_LINK_BPS='131072'        # link throughput, bytes/second
$env:LAZY_BENCH_LINK_LATENCY_MS='80'     # one-way delay
$env:LAZY_BENCH_CHURN_MS='250'           # churn tick
$env:LAZY_BENCH_READ_BYTES='262144'       # lazy read budget — the consumer's rate control
$env:LAZY_BENCH_TIMEOUT_MS='60000'       # convergence deadline per measurement
npx tsx experiments/store-lazy-2026-08/bench.ts
```

The recorded local result is in [RESULTS.md](RESULTS.md).

## Interpretation rules

- Client, server and relay share one process and one event loop; wall-clock numbers
  include that contention. Compare candidates within a run, never across machines.
- The lazy line's read budget is deliberate backpressure, not a limitation: it is what
  stops a background fill from queueing ahead of an urgent line. Raising
  `LAZY_BENCH_READ_BYTES` makes the fill faster and less polite, which is the whole
  trade being measured.
- During the lazy first pass the mirror holds a MIX of fresh and stale keys. That is the
  semantic price of not buffering a second copy, and it is why `firstDataMs` is small.
  For an all-or-nothing transfer the comparable surface is `createStoreReplayView`.
- A small quiet Store is the case where lazy has least to offer: the keyframe is already
  cheap, and the fill pays extra round trips for nothing. That row exists to keep the
  stand honest.
