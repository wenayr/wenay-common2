# Results — 2026-07-30

## Environment and method

- Windows `10.0.26200`, x64
- AMD Ryzen AI 7 350, 8 cores / 16 logical CPUs
- Node.js `24.18.0`
- Socket.IO `4.8.3`, forced to WebSocket
- loopback TCP, `perMessageDeflate` disabled
- three randomized fresh-process runs per candidate and target
- 4096 array rows, 128-byte fixed payload per row
- 128 synchronous element replacements per reactive drain

The target keeps the operation count of the original full-array benchmark:
3,840 writes for 15 MiB and 12,800 writes for 50 MiB. Public raw Store patches
remain one complete-array patch per drain. Store Replay now uses private mutation
metadata to preserve each safe array-slot replacement as an exact path. Array
length changes and whole-array replacement retain the complete-array fallback.

## Before and after

Medians over three runs on the same machine:

| 15 MiB workload | 2.2.2 baseline | Exact-slot candidate | Change |
|---|---:|---:|---:|
| Socket CPU per write | 292.71 µs | 32.55 µs | −88.9% |
| Socket wall time | 1,580.0 ms | 164.1 ms | −89.6% |
| In-process Replay CPU per write | 199.22 µs | 32.55 µs | −83.7% |
| WebSocket payload | 17.56 MiB | 0.73 MiB | −95.8% |
| Socket event-loop p95 | 14.02 ms | 0.39 ms | −97.2% |
| Socket peak heap above base | 101.88 MiB | 31.41 MiB | −69.2% |
| Socket GC time | 48.63 ms | 0.77 ms | −98.4% |

The unchanged raw Store candidate remained noisy but in the same range
(52.60 µs/write before, 57.03 µs/write after). The gain therefore comes from
removing synchronization amplification, not from a generally faster machine.

## 50 MiB workload

| Candidate | Wall time | CPU µs/write | Changed MiB/s | Peak heap | Event-loop p95 |
|---|---:|---:|---:|---:|---:|
| raw Store patches | 1,056.6 ms | 45.08 | 1.48 | 18.79 MiB | — |
| Store Replay in process | 449.4 ms | 26.80 | 3.48 | 33.26 MiB | — |
| Store Replay over Socket.IO | 568.2 ms | 32.97 | 2.75 | 33.47 MiB | 1.86 ms |

The previous 50 MiB Socket baseline was 2,139.6 ms, 186.72 µs/write,
58.70 MiB of WebSocket payload, 159.49 MiB peak heap and 181.01 ms event-loop
p95. The exact-slot path sent 2.45 MiB over WebSocket and retained the same
100 physical frames: batching overhead did not increase.

## Patch and wire accounting

| Workload | Source drains | Replay patches | Replay envelopes | Estimated bytes | WebSocket bytes |
|---:|---:|---:|---:|---:|---:|
| 15 MiB target | 30 | 3,840 | 30 | 0.73 MiB | 0.73 MiB |
| 50 MiB target | 100 | 12,800 | 100 | 2.45 MiB | 2.45 MiB |

The patch count increases from one full-array fact to one fact per changed slot,
but the physical envelope count stays one per natural Store drain. At 50 MiB the
wire carried about 200.5 bytes per changed row, including Store Replay, RPC,
Socket.IO and WebSocket structure.

## Safety boundaries

- `reactive().onUpdatePaths` and public `listenStorePatches` keep their existing
  array-branch behavior.
- Replacing an array property and then changing one of its slots in the same
  drain emits the complete array.
- Any observed `length` mutation emits the complete array, covering truncation,
  `pop`, `splice` and other structural operations.
- Exact patches are used only by the Store-owned Replay source. An injected
  `patchSource` and Replicated Map keep their declared source semantics.

The retained heap still returns to the warmed baseline after GC. The original
failure mode was transient allocation and deterministic full-array
amplification, not a retained JavaScript-heap leak.
