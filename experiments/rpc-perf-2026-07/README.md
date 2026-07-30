# RPC performance experiment — July 2026

The [July 25 transport experiment](../transport-2026-07/README.md) measured transport and
codec **in isolation**. It never went through `createRpcServer` / `createRpcClient`, so it
could say nothing about what the RPC layer itself costs, how many frames a logical RPC
conversation actually produces, or what the already negotiated wire optimizations buy.

This stand closes that gap. Everything here runs through the real facades, over a real
`socket.io` server and client forced to WebSocket on loopback with `perMessageDeflate`
disabled — the same transport choices as July 25, so the two sets of numbers can be read
together.

It is a **measurement** stand. Nothing under `src/` is modified, and no optimization is
implemented here. Its only job is to make a future change judgeable against a real baseline
instead of against zero.

## What is instrumented, and how

The central claim this experiment exists to test is "too many frames, keys repeated too
often". That claim is about physical wire behavior, so frames and bytes are counted, never
estimated. Three independent counters run at once:

1. **Logical RPC packets** — the `{emit, on}` adapter handed to `createRpcServer` and
   `createRpcClient`. One `emit` is one packet offered to the transport. A `Pkt.CB_BATCH`
   emit is unpacked so its N inner packets are counted as N logical packets carried by one
   physical one. Packets are classified by their `Pkt` opcode, including the schema request
   that travels as a bare opcode rather than an array.
2. **Physical WebSocket frames** — engine.io's underlying `ws` socket. Inbound frames come
   from its `message` event, outbound frames from a wrapped `send`. Both report the
   already-serialized byte length, so no re-serialization is added to the measured path.
3. **TCP bytes** — `bytesRead` / `bytesWritten` of the accepted `net.Socket`, captured from
   the HTTP server's public `connection` event.

(3) exists to validate (2). `tcpBytes - wsPayloadBytes` must equal the WebSocket framing
overhead: 6 bytes per masked client frame, 2/4/10 bytes per server frame depending on
payload size. Every recorded run is checked against this, and a unit whose frame probe
fails to attach aborts instead of reporting a guess.

Per-opcode **byte** attribution requires `JSON.stringify`, which is not free, so it never
runs during a timing window. Each unit measures twice: a timing window with counting-only
instrumentation, then a shorter accounting window with byte sizing enabled whose latencies
are discarded.

## Workload families

| Family | What it does | Why |
|---|---|---|
| `connect` | connect → `init()` → close, repeatedly, anonymous | the handshake is what "fold the connect round trips" would attack |
| `connect-auth` | same, with a gated server and an in-band `Pkt.HELLO` token | measures the extra round trip in-band auth adds |
| `small` | one compact quote-shaped argument and result, one call at a time, followed by a quiet gap | the isolated-latency case; mirrors `isolated-3ms` of the July stand |
| `large` | one call returning 1000 records of identical shape | where repeated JSON keys dominate |
| `ticks` | a server callback emitting a uniform object at a target 100/s for a few seconds | the path `Pkt.SHAPE` / `Pkt.CBV` and `Pkt.CB_BATCH` already optimize |
| `flood` | the same tick stream with the pacing removed | the only place the callback batcher can fill a batch |
| `burst` | 50 independent calls issued in one synchronous burst | per-frame overhead; neither direction is batched today |

Record shapes are modeled on the repo's own domain (`src/Exchange/Bars.ts`):

- `bar` — `{time: Date, open, high, low, close, volume, tickVolume}`, the `CBar` shape. The
  `Date` is kept because that is what `packResult` really has to put on the wire.
- `tick` — `{symbol, seq, time, price, bid, ask, volume, t}`, a quote-feed record. `t` is a
  stand-only field carrying the emit instant in integer microseconds; client and server share
  one process, so tick latency is a real one-way delivery time and not a clock estimate.
- `quote` — the compact request/result pair of family `small`.

`ticks` is paced with a drift-correcting pump, not `setInterval`. The Windows timer
granularity on this host is about 15.6 ms, so a naive `setInterval(10)` would silently
deliver about 64/s while claiming 100/s.

## Candidates

Every negotiable bit in `src/Common/rcp/rpc-caps.ts` is represented.

| Candidate | `opt` | Effective caps |
|---|---|---|
| `defaults` | *(none)* | COMPACT + CB_BATCH + AUTH_STATE + HELLO_ID + ROWS |
| `no-compact` | `{compact: false}` | shape compaction off (and with it ROWS, which requires it) |
| `no-callback-batch` | `{callbackBatch: false}` | callback batching off |
| `request-batch` | `{requestBatch: true}` | CALL/PIPE and RESP batching on (`Caps.REQ_BATCH`) |
| `no-row-compact` | `{compactRows: false}` | row-encoded record arrays off (`Caps.ROWS`) |
| `plain-json` | `{compact: false, callbackBatch: false}` | the plain JSON-array wire |
| `caps-all-off` | all four `false` | nothing negotiated at all |

`COMPACT`, `CB_BATCH`, `REQ_BATCH` and `ROWS` are the bits that touch the data path, so they get the
full family matrix. `AUTH_STATE` and `HELLO_ID` only touch the handshake and the auth surface,
so they are exercised through `caps-all-off` in the two connect families rather than doubling
every data row for a wire that cannot differ.

`REQ_BATCH` is the one negotiable bit that is **off** by default, so `defaults` is already its
control: `request-batch` vs `defaults` differs by exactly that bit and nothing else. That is
also why `caps-all-off` does not name it — it is off there by construction.

`ROWS` ships **on**, so its control has to be the other way round: `no-row-compact` vs `defaults`
is that bit off vs on and nothing else. `no-compact` and `plain-json` also read as rows-off, because
`ROWS` requires `COMPACT`; that is a property of the feature, not a second variable.

## Methodology

The follow-up list at the end of [`transport-2026-07/RESULTS.md`](../transport-2026-07/RESULTS.md)
named the upgrades this experiment had to make. They are requirements here, not options:

- **Fresh Node process per candidate.** `bench.ts` is both orchestrator and worker. Without
  `RPC_BENCH_UNIT` it spawns one child per `(family, candidate)` unit; with it, the child runs
  exactly that unit and prints one `##UNIT##` line. No JIT state, GC state or shape-registry
  state crosses a candidate boundary.
- **Randomized candidate order**, reseeded per run and per family from `RPC_BENCH_SEED`. The
  order actually used is printed and stored in the results, so a run is reproducible.
- **At least 3 full runs**, reported as `median [min…max]`, never as one clean run.
- **Warmup discarded** in every family before the timing window opens.
- **Event-loop delay and GC** recorded per window (`monitorEventLoopDelay`, a `gc`
  `PerformanceObserver`).
- **CPU reported only where the window supports it**, following the July rule.

## Run

```powershell
npm run experiment:rpc-perf
```

One family only, and smaller counts while iterating:

```powershell
$env:RPC_BENCH_FAMILY='flood'
$env:RPC_BENCH_RUNS='1'
npm run experiment:rpc-perf
```

One unit in this process (no child spawn — how to debug a single stand):

```powershell
$env:RPC_BENCH_UNIT='ticks:defaults'
$env:RPC_BENCH_UNIT_PORT='3173'
npx tsx experiments/rpc-perf-2026-07/bench.ts
```

| Variable | Default | Meaning |
|---|---:|---|
| `RPC_BENCH_RUNS` | 3 | full repetitions of the whole matrix |
| `RPC_BENCH_SEED` | 20260729 | candidate-order seed |
| `RPC_BENCH_FAMILY` | *(all)* | comma-separated family names |
| `RPC_BENCH_PORT` | 3173 | first port; each unit takes the next one |
| `RPC_BENCH_SMALL_CALLS` | 500 | family `small` |
| `RPC_BENCH_GAP_MS` | 3 | quiet gap of family `small` |
| `RPC_BENCH_LARGE_CALLS` | 80 | family `large` |
| `RPC_BENCH_LARGE_RECORDS` | 1000 | records per large result |
| `RPC_BENCH_TICKS` | 400 | family `ticks` |
| `RPC_BENCH_TICK_HZ` | 100 | target tick rate |
| `RPC_BENCH_FLOOD_ROUNDS` | 20 | family `flood` |
| `RPC_BENCH_FLOOD_SIZE` | 500 | ticks per flood round |
| `RPC_BENCH_BURSTS` | 40 | family `burst` |
| `RPC_BENCH_BURST_SIZE` | 50 | calls per burst |
| `RPC_BENCH_CONNECTS` | 150 | connect families |

Ports 3173 and upward are used; everything below is taken by other stands in this repo.

The recorded local result is in [RESULTS.md](RESULTS.md).

## Interpretation rules

- Compare candidates **within one family**. Across families the message unit differs: a
  `large` "message" is 1000 records, a `ticks` message is one record.
- Frames and bytes are exact and repeat run to run; latency, throughput and CPU are not.
  When a wire-shape claim and a timing claim disagree, trust the wire shape.
- `s2cRpcPackets / s2cFrames` is the number this experiment exists to produce. A value of 1
  means every logical packet paid for its own frame.
- Per-message byte figures are **WebSocket payload** bytes. `tcpBytesPerMsg` adds framing;
  for the connect families it also includes the HTTP upgrade, which is why it is several
  times larger there.
- Client and server share one process, as in the July stand. CPU therefore covers both
  endpoints. That is intentional for comparison and is not a capacity claim.
- CPU is deliberately **not** reported for `small` and the connect families: on Windows,
  accounting across short sleeps and across socket setup is too coarse to mean anything.
  This is the same rule the July experiment applied to its isolated scenario.
- Event-loop delay on this host has a floor set by the ~15.6 ms timer granularity. It is
  usable to compare two candidates inside the same busy window and is meaningless as an
  absolute number for an idle one.

## What a loopback stand cannot claim

- **It cannot rank anything by latency for a real deployment.** Loopback RTT is roughly two
  orders of magnitude below an internet route. Any optimization that trades a round trip for
  bytes looks worse here than it would over a real link, and any optimization that trades
  bytes for a round trip looks better.
- **It cannot claim throughput capacity.** One process runs both endpoints on one machine,
  so client and server compete for the same cores and the same event loop.
- **It cannot claim bandwidth wins are irrelevant.** Loopback bandwidth is effectively free;
  a byte saving that looks worthless here can be the dominant effect on a metered or
  congested link.
- **It cannot speak about compression.** `perMessageDeflate` is off, deliberately and for the
  same reason as in July. Repeated JSON keys are exactly what a deflate context handles well,
  so a byte figure here is an upper bound on what key repetition costs on a compressed link.
- **It cannot speak about many concurrent connections.** Every family uses one connection
  (the connect families use one at a time). Fan-out, backpressure and per-socket memory are
  out of scope.
- **It cannot generalize the payload.** Two record shapes from this repo's own domain were
  used. A different key/value ratio moves the key-cost result directly.
