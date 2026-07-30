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
- warmup fills every array slot before measurement

The reactive engine reports an array mutation at the array path. Consequently,
each 128-write drain produces one patch containing all 4096 rows. The two target
sizes are the fixed-width row payload represented by those full-array patches:

| Target | Writes | Actually changed payload | Drain / full-array patches | Represented patch payload |
|---:|---:|---:|---:|---:|
| 15 MiB | 3,840 | 0.469 MiB | 30 | 15 MiB |
| 50 MiB | 12,800 | 1.563 MiB | 100 | 50 MiB |

Thus Store patch production alone has a deterministic 32× payload amplification
for this shape (`4096 / 128`). Every candidate verified its final array. Both
replay candidates also produced and applied exactly 30 or 100 patches.

## Throughput

Values are medians over three runs. CPU covers both endpoints in the socket
candidate. Plain-array CPU was below the resolution of Windows process CPU
accounting for these short windows.

### 15 MiB represented patch payload

| Candidate | Wall time | Changes/s | Changed MiB/s | Represented MiB/s | CPU µs/change |
|---|---:|---:|---:|---:|---:|
| plain array | 0.2 ms | 19,571,865 | 2,389.14 | — | — |
| Store + patch production | 101.9 ms | 37,671 | 4.60 | 147.15 | 32.55 |
| Store Replay + in-process mirror | 510.6 ms | 7,520 | 0.92 | 29.38 | 150.52 |
| Store Replay + RPC/WebSocket mirror | 618.2 ms | 6,212 | 0.76 | 24.26 | 166.67 |

### 50 MiB represented patch payload

| Candidate | Wall time | Changes/s | Changed MiB/s | Represented MiB/s | CPU µs/change |
|---|---:|---:|---:|---:|---:|
| plain array | 0.5 ms | 24,801,395 | 3,027.51 | — | — |
| Store + patch production | 330.4 ms | 38,740 | 4.73 | 151.33 | 28.13 |
| Store Replay + in-process mirror | 1,630.2 ms | 7,852 | 0.96 | 30.67 | 135.47 |
| Store Replay + RPC/WebSocket mirror | 2,139.6 ms | 5,983 | 0.73 | 23.37 | 186.72 |

At 50 MiB, replay sizing/journaling/mirror application costs about 4.9× the
Store patch-production wall time. Adding real RPC/WebSocket transport increases
the in-process replay wall time by about 31% and measured CPU per change by about
38%. The dominant cost still starts before the transport: repeated cloning,
sizing and application of the complete array.

## Exact wire accounting

| Target | Server frames / RPC emits | WebSocket payload | TCP bytes above WS | WS / represented payload | WS / changed payload |
|---:|---:|---:|---:|---:|---:|
| 15 MiB | 30 / 30 | 17.56 MiB | 300 B | 1.171× | 37.47× |
| 50 MiB | 100 / 100 | 58.70 MiB | 1,000 B | 1.174× | 37.57× |

Each indivisible array patch became one roughly 614–616 KiB WebSocket frame.
The configured 64 KiB Store Replay byte target cannot split a single patch.
JSON/RPC structure adds about 17% above the fixed row payload. WebSocket framing
itself adds exactly 10 bytes per large server frame and is negligible.

The replay batcher's conservative sizing counter reported 21.31 MiB for the
15 MiB target and 71.20 MiB for the 50 MiB target; the physical WebSocket probe
is the authoritative byte count.

## CPU, event loop and memory

| Target | Socket event-loop p95 | GC time | Peak heap above base | Peak RSS above base | Post-GC heap | Post-GC RSS |
|---:|---:|---:|---:|---:|---:|---:|
| 15 MiB | 5.13 ms | 15.33 ms | 86.62 MiB | 57.29 MiB | +0.12 MiB | +17.28 MiB |
| 50 MiB | 181.01 ms | 74.63 ms | 159.49 MiB | 161.51 MiB | +0.22 MiB | +40.29 MiB |

The post-GC managed heap returned to the warmed baseline in every run. This
experiment therefore found no retained JavaScript-heap leak. RSS remained
committed after collection, which is normal allocator behavior and is not by
itself evidence of a leak.

The transient pressure is real: the 50 MiB unpaced source queues 100 oversized
full-array messages before the I/O loop catches up. Socket event-loop p95 was
176–274 ms across the three runs, alongside a roughly 159 MiB heap peak. The
in-process candidates deliberately remain in a microtask chain and produce no
timer samples, so their event-loop percentile is omitted rather than reported as
zero.

## Conclusion

The suspected retained heap leak was not reproduced. The resource problem is
instead a deterministic synchronization amplification for hot arrays:

1. an element mutation is coarsened to the array path;
2. Store patch production snapshots the whole array once per drain;
3. replay sizes, journals and applies that whole value;
4. a single oversized patch bypasses the 64 KiB batch target;
5. RPC/WebSocket adds a smaller but measurable cost on top.

For high-frequency independently addressed records, the first corridor to test
is a keyed object or the existing replicated-map surface, so each changed record
can remain a bounded patch. If latest-only semantics are acceptable, widening
the drain so most array elements settle before one snapshot also reduces the
amplification, at the cost of update latency and intermediate states.
