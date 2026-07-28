# Results — 2026-07-25

## Environment

- Windows `10.0.26200`, x64
- AMD Ryzen AI 7 350, 8 cores / 16 logical CPUs
- Node.js `24.18.0`
- Socket.IO `4.8.3`, forced to WebSocket
- Socket.IO MessagePack parser `3.0.2`
- `ws` `8.21.1`
- loopback TCP, `permessage-deflate` disabled
- 500 isolated messages with a 3 ms quiet gap
- 40 bursts × 250 messages
- small payload: 90 JSON bytes
- medium payload: 304 JSON bytes

Two full preliminary runs used `ws` 8.21.0. The final recorded run used 8.21.1.
Direction and approximate ratios were stable across all three runs; burst throughput
had the expected scheduler/GC variance.

## Codec-only result

The table reports the final run. Time is encode + decode in one tight loop.

| Payload | Shape | JSON time/message | Binary time/message | Binary/JSON | JSON bytes/message | Binary bytes/message |
|---|---:|---:|---:|---:|---:|---:|
| small | single | 0.679 µs | 7.713 µs | 11.4× slower | 90 | 51 |
| small | batch 250 | 0.420 µs | 1.648 µs | 3.9× slower | 92.6 | 47.8 |
| medium | single | 1.747 µs | 11.207 µs | 6.4× slower | 304 | 161 |
| medium | batch 250 | 1.488 µs | 4.957 µs | 3.3× slower | 306.6 | 157.8 |

Across the three runs:

- small single binary was 11.4–12.3× slower by tight-loop wall time;
- medium single binary was 6.0–6.9× slower;
- 250-item binary batches were still 3.3–3.9× slower;
- binary reduced these representative wire values by roughly 43–49%.

The current project codec therefore did not reach a CPU crossover at 250 items on
this machine. It reached a byte-size win only.

## Isolated 3 ms result

Round-trip latency is measured before the quiet gap. Process CPU is intentionally
not reported for this scenario because Windows accounting across short sleeps is
too coarse.

| Payload | Representation | Socket.IO p50 | Raw WS p50 | Raw WS reduction | Socket.IO p95 | Raw WS p95 |
|---|---|---:|---:|---:|---:|---:|
| small | JSON | 0.449 ms | 0.330 ms | 26.5% | 0.732 ms | 0.512 ms |
| small | project binary | 0.580 ms | 0.371 ms | 36.0% | 0.913 ms | 0.578 ms |
| medium | JSON | 0.408 ms | 0.295 ms | 27.8% | 0.622 ms | 0.472 ms |
| medium | project binary | 0.524 ms | 0.423 ms | 19.3% | 0.784 ms | 0.688 ms |

Raw WebSocket consistently reduced loopback p50 latency. JSON remained faster than
the project binary representation on both transports.

## Burst 250 result

| Payload | Representation | Socket.IO msg/s | Raw WS msg/s | Raw WS gain |
|---|---|---:|---:|---:|
| small | JSON | 36,555 | 52,142 | 42.6% |
| small | project binary | 16,175 | 28,202 | 74.4% |
| medium | JSON | 35,696 | 38,310 | 7.3% |
| medium | project binary | 15,259 | 19,680 | 29.0% |

The preliminary runs produced wider burst ranges, but always preserved these two
relationships:

1. raw WebSocket was faster than Socket.IO with the same representation;
2. JSON was faster than the project binary codec on the complete path.

## Decision from the first pass

The best measured path for these workloads is **raw WebSocket + JSON**.

That is not yet a reason to remove Socket.IO:

- Socket.IO still owns useful control-plane behavior: reconnection, compatibility
  fallback, lifecycle and its established application integration.
- The project already has two transport seams: the RPC `{emit, on}` adapter and
  `ReplayMessageChannel`. A raw WebSocket data-plane connector can be added without
  changing the public RPC interface.
- The binary codec is still valuable when bandwidth is the scarce resource or when
  the value already contains native binary leaves. It should not be the unconditional
  path for small plain objects.

The next production-shaped experiment should:

1. run each candidate in a fresh process and randomize order;
2. repeat the MessagePack comparison with real application binary leaves and
   payload-size buckets;
3. measure a remote route with realistic RTT, packet loss and TLS;
4. add actual application payload histograms, GC and event-loop delay;
5. test direct WebTransport only for stream separation or latest-wins datagrams,
   not as a presumed serialization optimization;
6. derive an `auto` crossover by payload family instead of choosing one global
   byte threshold.

## Transport-only opaque binary pass

This follow-up removes the project object codec completely. Every candidate echoes
the same already encoded 96-byte `Uint8Array`; the stand only verifies its length.

Socket.IO default binary uses its documented JSON placeholder plus a separate
binary attachment frame. Socket.IO MessagePack wraps the Socket.IO packet into one
binary WebSocket frame. Raw WebSocket sends the bytes directly in one frame.

Three full runs used 500 isolated messages with a 3 ms quiet gap and 40 bursts of
250. These are the medians:

| Candidate | Isolated p50 | Burst p50 | Burst throughput | Burst CPU/message |
|---|---:|---:|---:|---:|
| Socket.IO default binary | 0.562 ms | 20.543 ms | 11,544 msg/s | 114.0 µs |
| Socket.IO MessagePack | 0.531 ms | 11.070 ms | 20,124 msg/s | 67.2 µs |
| Raw WebSocket | 0.370 ms | 5.193 ms | 35,660 msg/s | 32.8 µs |

Interpretation:

- On an isolated packet, MessagePack changed p50 by only about 6%; one of the three
  runs was slightly slower than the default parser. This is not a strong practical
  latency win.
- On 250-message bursts, MessagePack improved throughput by about 74% and reduced
  measured CPU/message by about 41%. Avoiding the attachment frame matters once
  many messages are in flight.
- Raw WebSocket still delivered about 77% more burst throughput than MessagePack
  and reduced isolated p50 by about 30%. One frame is useful, but Socket.IO protocol
  and MessagePack parsing do not disappear.

### Current size cost

Measured from the installed Socket.IO 4.8.3 artifacts:

| Artifact | Minified | gzip level 9 |
|---|---:|---:|
| Default browser bundle | 46,822 B | 14,670 B |
| MessagePack browser bundle | 50,368 B | 15,339 B |
| Delta | 3,546 B | 669 B |

The server-side `socket.io-msgpack-parser` package is 6,780 bytes unpacked. Its
runtime dependencies are approximately 61,790 bytes (`notepack.io`) and 8,001
bytes (`component-emitter`) unpacked. The current incremental cost is therefore
kilobytes, not the roughly 2 MB associated with the older experiment.
