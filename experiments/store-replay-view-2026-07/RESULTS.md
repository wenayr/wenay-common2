# Results — 2026-07-30

## Environment and final method

- Windows `10.0.26200`, x64
- AMD Ryzen AI 7 350, 8 cores / 16 logical CPUs
- Node.js `24.18.0`
- five fresh-process runs per candidate and source size
- 1,500 top-level keys, with 500 selected
- 15 MiB and 50 MiB exact source payloads
- 512 KiB chunk target, 1 MiB window, 256 patches per chunk

These are the final measurements after `storeReplayPatchV2WireMetrics` began
using the exact no-materialization counter for ordinary JSON and binary leaves.
Rich values, reserved-marker shapes, custom `toJSON` values and cycles continue
through the canonical packer fallback. The optimization changes sizing work;
it does not change the emitted Store Replay wire.

## Five-run medians

`Initial wall` is one cold initial transfer after source/view construction.
`CPU-probe wall` and `CPU` are per-transfer values from the repeated probe
described in the README.

| Source | Candidate | Initial wall | CPU-probe wall | CPU | Wire | Heap peak | Response held | Post-GC | Chunks/pages |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 15 MiB | Full keyframe | 42.13 ms | 42.59 ms | 29.38 ms | 15.05 MiB | 18.95 MiB | 18.95 MiB | 0.24 MiB | 1/1 |
| 15 MiB | Selected monolithic | 11.63 ms | 16.23 ms | 11.40 ms | 5.02 MiB | 6.93 MiB | 6.93 MiB | 0.14 MiB | 1/1 |
| 15 MiB | Selected windowed | 41.15 ms | 30.57 ms | 26.00 ms | 5.02 MiB | 8.84 MiB | 8.84 MiB | 0.27 MiB | 11/6 |
| 50 MiB | Full keyframe | 105.07 ms | 137.07 ms | 73.00 ms | 50.05 MiB | 53.94 MiB | 53.94 MiB | 0.23 MiB | 1/1 |
| 50 MiB | Selected monolithic | 44.84 ms | 50.54 ms | 37.40 ms | 16.68 MiB | 18.60 MiB | 18.60 MiB | 0.13 MiB | 1/1 |
| 50 MiB | Selected windowed | 100.03 ms | 83.49 ms | 55.00 ms | 16.69 MiB | 20.80 MiB | 20.80 MiB | 0.29 MiB | 36/18 |

Maximum-RSS deltas were 23.14/2.28/0.00 MiB for the three 15 MiB
candidates and 76.29/7.39/0.00 MiB for the three 50 MiB candidates. The
windowed zeroes mean its transfer did not exceed the process high-water mark
already established while constructing the fixture. Heap deltas are the more
useful comparison here.

## Exact transfer accounting

| Source | Candidate | V2 payload bytes | Callback-value bytes | Maximum chunk | Maximum window |
|---:|---|---:|---:|---:|---:|
| 15 MiB | Full keyframe | 15,781,558 | 15,781,558 | 15,781,558 | 15,781,558 |
| 15 MiB | Selected monolithic | 5,261,537 | 5,261,537 | 5,261,537 | 5,261,537 |
| 15 MiB | Selected windowed | 5,261,747 | 5,262,705 | 515,685 | 1,031,516 |
| 50 MiB | Full keyframe | 52,481,718 | 52,481,718 | 52,481,718 | 52,481,718 |
| 50 MiB | Selected monolithic | 17,494,924 | 17,494,924 | 17,494,924 | 17,494,924 |
| 50 MiB | Selected windowed | 17,495,659 | 17,498,833 | 489,881 | 979,940 |

Chunk envelopes add only 210 bytes at 15 MiB and 735 bytes at 50 MiB to
the selected V2 payload. The callback metadata adds less than 4 KiB at 50 MiB.
The benefit is therefore queue shape and event-loop fairness, not compression.

## Fast counter before and after

The earlier run used the canonical rich-value packing and JSON materialization
for every patch merely to choose chunk boundaries. The final run counts plain
wire bytes without allocating that packed mirror, JSON string and UTF-8 buffer.

| Windowed source | Metric | Before | Fast counter | Change |
|---:|---|---:|---:|---:|
| 15 MiB | CPU per transfer | 41.67 ms | 26.00 ms | −37.6% |
| 15 MiB | Sampled heap peak | 17.82 MiB | 8.84 MiB | −50.4% |
| 15 MiB | Initial wall | 82.65 ms | 41.15 ms | −50.2% |
| 50 MiB | CPU per transfer | 110.00 ms | 55.00 ms | −50.0% |
| 50 MiB | Sampled heap peak | 42.50 MiB | 20.80 MiB | −51.1% |
| 50 MiB | Initial wall | 203.86 ms | 100.03 ms | −50.9% |

Payload bytes, chunk count, page count and chunk/window limits stayed
effectively unchanged. The improvement comes from removing transient sizing
allocations and the duplicate serialization walk, not from sending less data.

## What the selection itself buys

At 50 MiB, selecting 500 of 1,500 keys and using a monolithic selected
keyframe instead of the full Store produced:

- 50.05 MiB to 16.68 MiB of wire: about 66.7% less;
- 53.94 MiB to 18.60 MiB sampled/held heap: about 65.5% less;
- 73.00 ms to 37.40 ms CPU: about 48.8% less.

The selective view is therefore the primary optimization. Windowing addresses
a different problem: it prevents one selected snapshot from becoming one large
transport item and lets the event loop run between bounded pieces.

## Monolithic or windowed

Use the selected monolithic keyframe when the selected payload already fits the
application's transport and heap budget. It remains the cheapest path:

- at a 5 MiB selected payload, 11.40 ms CPU and 6.93 MiB peak heap;
- at a 16.67 MiB selected payload, 37.40 ms CPU and 18.60 MiB peak heap.

Use the selected windowed snapshot when one large queued response is unsafe,
the server has a tight memory budget, or the shared socket must yield to media
and other traffic. At a 16.67 MiB selected payload it costs 55.00 ms CPU versus
37.40 ms monolithic, but no callback payload exceeds 489,881 bytes and no read
window exceeds 979,940 bytes. Its sampled heap is now only about 11.8% above
the monolithic selected path.

The practical policy is adaptive:

1. select only the authorized keys required by the client;
2. share one view for clients with an identical authorized selection;
3. send a monolithic selected keyframe while it is within the configured
   queue/heap budget;
4. switch to bounded windows above that budget or when low-memory mode is
   active;
5. size the window against the shared socket's latency budget, because each
   page adds a request/response round trip on a real network.

Post-send forced-GC retention stayed between 0.13 MiB and 0.28 MiB in every
candidate. This experiment therefore found transient allocation and transport
queue risk, not a retained JavaScript-heap leak.

## Caveats

- This stand materializes RPC-compatible values in process; it does not run
  Socket.IO, WebSocket, TCP or TLS.
- Client parsing and atomic client-side Store installation are excluded.
- Uniform flat ASCII records exercise the fast exact counter's intended plain
  path. Rich-value payloads can fall back to the canonical counter and cost
  more CPU and allocation.
- Windowed wall time includes one `setImmediate` per chunk but excludes real
  Internet RTT. Eighteen pages can dominate latency on a distant connection.
- Heap peak is sampled outside synchronous serialization calls and depends on
  V8's GC timing. Post-GC retention is the stronger leak signal.
- Windows process CPU is quantized. The repeated CPU probe makes before/after
  comparisons useful, but small absolute differences should not be ranked as
  microbenchmarks.
