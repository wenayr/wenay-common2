# Slow-network experiment — August 2026

This experiment answers the two follow-ups left open by `experiments/transport-2026-07`
and `experiments/rpc-perf-2026-07`:

1. What does `perMessageDeflate` cost and save on RPC/replay-shaped JSON traffic?
2. What actually causes disconnect/reconnect cycles on a slow link, and which
   knob prevents them?

The July stands measured loopback, where CPU is the ceiling. On a slow link the
ceiling is bytes, so the trade-off inverts; this stand measures that inversion.

## The slow-network model

A metered in-process TCP relay sits between the Socket.IO client and server:

- a token bucket limits throughput to a configured bytes/second per direction;
- every chunk additionally arrives after a fixed one-way delay;
- byte counters see real wire bytes: WebSocket framing and deflate included.

This models bandwidth and latency, not packet loss — TCP hides loss as extra
delay, which the bucket already represents. Loss-specific effects (retransmit
bursts, head-of-line stalls) still need a route test on the real deployment.

## Passes

1. **wire** — fast link. Isolated echo round-trips for `small` (90 B) and
   `medium` (304 B) payloads (same shapes as the July transport stand) and a
   1000-record row array. Reports p50/p95 latency, CPU per message and measured
   server→client wire bytes per message, deflate off versus on.
2. **slow-link** — 131072 B/s (≈1 Mbit/s) with 80 ms one-way delay. One-shot
   delivery time of the row array and of a 5000-key Store-keyframe-shaped
   object, deflate off versus on.
3. **ping** — 32768 B/s with scaled heartbeat timers (`pingInterval` 300 ms).
   The server pushes a 2000-key keyframe (~319 KiB JSON) that occupies the link
   for ~10 s. Three variants: short `pingTimeout` (1 s, scaled default), raised
   `pingTimeout` (30 s), and short `pingTimeout` with deflate on.

The ping pass is a scale model. Production Socket.IO defaults are
`pingInterval` 25 s / `pingTimeout` 20 s: any single message that occupies the
link longer than the ping budget starves the heartbeat the same way — at
1 Mbit/s that is roughly any frame above ~2.5 MiB, and `doc/RECOMMENDATIONS.md`
records a real Store keyframe at ~3.3 MiB.

## Run

```powershell
npm run experiment:slow-network
```

Optional environment variables (defaults in parentheses):

```powershell
$env:SLOW_BENCH_ISOLATED='200'            # wire-pass messages for small/medium
$env:SLOW_BENCH_ROWS='1000'               # records in the row array
$env:SLOW_BENCH_KEYFRAME_SLOW='5000'      # keyframe keys for the slow-link pass
$env:SLOW_BENCH_KEYFRAME_PING='2000'      # keyframe keys for the ping pass
$env:SLOW_BENCH_LINK_BPS='131072'         # slow-link throughput, bytes/second
$env:SLOW_BENCH_LINK_LATENCY_MS='80'      # slow-link one-way delay
$env:SLOW_BENCH_PING_LINK_BPS='32768'     # ping-pass throughput
$env:SLOW_BENCH_PING_INTERVAL_MS='300'    # scaled pingInterval
$env:SLOW_BENCH_PING_TIMEOUT_MS='1000'    # scaled short pingTimeout
npx tsx experiments/slow-network-2026-08/bench.ts
```

The recorded local result is in [RESULTS.md](RESULTS.md).

## Interpretation rules

- Client and server run in one Node.js process; CPU numbers include both
  endpoints plus the relay itself, which is intentional — compare candidates
  within one run, do not read them as capacity claims.
- The `small`/`medium` deflate ratios are flattered by the workload: repeated
  near-identical payloads share one deflate sliding window (context takeover),
  so consecutive messages compress to back-references. Real isolated updates
  compress less. The single-message `rows`/`keyframe` ratios are the robust
  signal — those are within-message compression of repeated JSON keys.
- Deflate compresses binary WebSocket frames too. Media and other
  already-compressed attachments gain nothing and pay CPU; keep them off a
  deflated connection or below the threshold.
- Windows CPU accounting over short windows is coarse; the wire-pass CPU column
  is a same-run delta, not an absolute cost.
- The relay counts each direction separately; reported wire bytes are the
  server→client direction, which carries results, callbacks and replay data.
