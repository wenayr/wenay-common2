# Transport experiment — July 2026

This experiment answers two separate questions:

1. What does the transport cost when the wire representation is unchanged?
2. What does the codec cost before the transport sees the message?

Keeping those axes separate matters. A binary codec can reduce wire bytes while
using more CPU, and a faster transport cannot recover CPU already spent encoding.

## Workloads

- `isolated-3ms`: one request/echo at a time, followed by a 3 ms quiet gap.
- `burst-250`: 250 request/echo messages launched in one synchronous burst.
- `codec-single`: encode and decode one payload.
- `codec-batch-250`: encode and decode an array containing 250 payloads.
- `opaque-transport`: echo an already encoded 96-byte `Uint8Array`; no project
  object codec runs in this pass.

Two stable-shape payloads are used:

- `small`: a compact market quote representative of frequent internet updates.
- `medium`: a quote with market metadata and nested metrics.

## Candidates in the first pass

- Socket.IO 4.8.x, forced to WebSocket and using its default JSON parser.
- Socket.IO 4.8.x carrying the project's binary codec as a native binary attachment.
- Socket.IO default binary framing carrying an opaque `Uint8Array`.
- Socket.IO MessagePack parser carrying the same opaque `Uint8Array`.
- Raw WebSocket through `ws`, using JSON text frames.
- Raw WebSocket through `ws`, using the project's binary codec.
- Raw WebSocket carrying the same opaque `Uint8Array` in one frame.

The first-pass comparison deliberately excludes compression. The `ws` project
documents meaningful CPU and memory overhead for `permessage-deflate`, and small
isolated messages are the least favorable workload for compression.

## Run

```powershell
npm run experiment:transport
```

Optional environment variables:

```powershell
$env:TRANSPORT_BENCH_ISOLATED='500'
$env:TRANSPORT_BENCH_BURSTS='40'
$env:TRANSPORT_BENCH_GAP_MS='3'
$env:TRANSPORT_BENCH_BURST_SIZE='250'
npx tsx experiments/transport-2026-07/bench.ts
```

Run only the transport/frame comparison:

```powershell
$env:TRANSPORT_BENCH_OPAQUE_ONLY='1'
npm run experiment:transport
```

The recorded local result is in [RESULTS.md](RESULTS.md). In the July 25 run,
raw WebSocket + JSON was the best measured path for both isolated updates and
250-message bursts. The project binary codec roughly halved bytes, but it did
not beat JSON CPU even at a 250-item batch. In the separate pre-encoded binary
pass, MessagePack's one-frame path substantially improved bursts but made almost
no isolated-message difference; raw WebSocket remained faster than both.

The benchmark runs client and server in one Node.js process over loopback. CPU
numbers therefore include both endpoints, which is intentional, but they are not
capacity claims for production hardware. Compare candidates within the same run.
The isolated scenario reports latency but deliberately omits process CPU: on
Windows, CPU accounting across short sleeps is too coarse and includes unrelated
runtime ticks. Codec-only and burst windows are long enough for useful CPU deltas.

## Interpretation rules

- Raw WebSocket JSON versus Socket.IO JSON isolates most protocol-layer overhead.
- Raw WebSocket binary versus Socket.IO binary isolates transport handling of the
  same `Uint8Array` wire.
- The opaque pass removes project object serialization entirely. Socket.IO default
  binary uses its placeholder + attachment framing, Socket.IO MessagePack uses one
  WebSocket frame, and raw WebSocket sends the bytes directly in one frame.
- JSON versus binary within one transport includes codec cost and byte-size effects.
- Loopback removes real Internet RTT. Repeat over the expected deployment route
  before making a production default.
- A crossover is workload-specific. Do not promote one threshold from this stand
  into a universal protocol rule.

## Current landscape

As of July 2026:

- Socket.IO supports HTTP long-polling, WebSocket and WebTransport. It remains a
  high-level reliability/control choice rather than a minimal wire.
- Socket.IO 4.8.3's provided minified MessagePack browser bundle is 50,368 bytes
  versus 46,822 bytes for the default bundle on this install. At gzip level 9 the
  delta is 669 bytes. The server parser plus its two small runtime dependencies is
  about 77 KB unpacked, not megabytes.
- Raw WebSocket remains the widest low-level browser/server baseline. Node ships a
  stable browser-compatible client; a server implementation such as `ws` or
  µWebSockets.js is still needed.
- WebTransport exposes reliable streams and unreliable datagrams over HTTP/3/HTTP/2.
  Its W3C API is still published as a Working Draft, so it is best treated as an
  additive connector with fallback.
- WebRTC DataChannel is attractive for direct peer traffic, but NAT traversal,
  signaling and TURN make it a different deployment tradeoff from client/server
  WebSocket.
- SSE plus HTTP requests is a simpler option when the live direction is almost
  entirely server-to-client; it is not a symmetric RPC transport.

Primary references:

- https://socket.io/docs/v4/client-options/#transports
- https://socket.io/docs/v4/custom-parser/
- https://socket.io/docs/v4/performance-tuning/
- https://github.com/websockets/ws
- https://nodejs.org/api/globals.html#class-websocket
- https://www.w3.org/TR/webtransport/
