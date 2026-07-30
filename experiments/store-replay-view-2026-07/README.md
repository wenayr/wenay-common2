# Store Replay View initial-transfer experiment — July 2026

This benchmark compares three ways to initialize a Store Replay mirror:

1. one complete Store keyframe;
2. one monolithic keyframe containing only selected top-level keys;
3. the same selected view transferred through bounded callback chunks and
   request/response windows.

The source has 1,500 top-level keys. Every third key is selected, giving a
500-key view. The two fixtures contain exactly 15 MiB and 50 MiB of flat ASCII
payload respectively, so the selected payload is approximately one third of
the source: 5 MiB and 16.67 MiB.

The windowed candidate uses the library defaults exercised by this change:

- 512 KiB approximate chunk target;
- 1 MiB maximum callback window;
- 256 patches per chunk;
- one event-loop yield after each chunk;
- no acknowledgement per chunk; the read response is the window barrier.

## What is measured

Every candidate runs in a fresh `node --expose-gc` process. Source and view
construction happen before the baseline. The measured initial transfer
includes Store snapshot production followed by `packResult` and JSON
materialization, representing the work required before Socket.IO can send the
value.

For a windowed snapshot, the benchmark serializes the complete callback value
and retains one page of callback values until its read response. It validates:

- exactly one root reset;
- exactly 500 distinct selected keys;
- monotonically ordered chunks;
- stable replay coordinates;
- successful completion without a history retry.

The reported metrics are:

- one initial-transfer wall time;
- process CPU per transfer from a longer repeated probe;
- Store Replay V2 payload bytes;
- sampled heap peak above the post-construction baseline;
- heap retained while the response or current window is held;
- retained heap after the simulated send completes and forced GC runs;
- process maximum-RSS delta;
- chunk/page counts and maximum chunk/window bytes.

The CPU probe follows the already-warmed initial transfer and repeats enough
work to reduce Windows process-CPU quantization:

| Candidate | 15 MiB repeats | 50 MiB repeats |
|---|---:|---:|
| Full keyframe | 8 | 3 |
| Selected monolithic | 15 | 5 |
| Selected windowed | 3 | 2 |

The coordinator reports medians from five isolated unit processes.

## Run

From the repository root:

```powershell
$env:STORE_REPLAY_VIEW_BENCH_RUNS='5'
node --expose-gc --import tsx experiments/store-replay-view-2026-07/bench.ts
```

Targets and run count can be changed without editing the benchmark:

```powershell
$env:STORE_REPLAY_VIEW_BENCH_RUNS='1'
$env:STORE_REPLAY_VIEW_BENCH_TARGETS='15,50'
node --expose-gc --import tsx experiments/store-replay-view-2026-07/bench.ts
```

The benchmark lives outside `src/`, adds no package API, and needs no runtime
dependency beyond the repository's existing development dependencies.

## Interpretation boundaries

This is a focused server-side allocation/serialization benchmark, not an
end-to-end network benchmark:

- it does not run a real Socket.IO, WebSocket, TCP or TLS connection;
- RPC callback wrappers are included for the windowed values, but RPC packet
  and Socket.IO framing are not;
- client JSON parsing and the atomic client-side view assembly are excluded;
- Internet RTT matters especially for the 6- and 18-page windowed transfers;
- payloads are uniform plain JSON records, not a mix of rich values;
- wall time includes the windowed path's `setImmediate` yields;
- sampled heap sees V8's GC schedule and cannot observe a temporary maximum
  from inside a synchronous `JSON.stringify`;
- `process.cpuUsage()` remains approximate on Windows despite the repeated
  probe;
- a zero maximum-RSS delta means the transfer stayed below the fixture
  construction's earlier process high-water mark, not that it used no RSS.

See [RESULTS.md](./RESULTS.md) for the measured medians and the practical
monolithic-versus-windowed decision.
