# Recommendations — current seams only

Completed migrations and released work are recorded in `doc/changes/`, not repeated here.

## Scheduler extraction

`schedule` / `createDrained` in `store.ts` still resemble scheduler logic in `reactive.ts`. This is
not a behavior gap. Extract a shared utility only if another scheduler appears or a real bug shows
that the implementations have diverged.

## Conditional features

- Shared documents: integrate a proven CRDT through the engine-neutral provider boundary in
  `doc/ROADMAP.md`; do not make Store itself multi-writer.
- Predicted Store: wait for a consumer that defines command receipt/reject/rebase semantics.
- Media optimization: use the stand's max-video measurements to choose exactly one bottleneck.

## Replay scaling follow-ups

The compatibility-safe CPU and allocation hot paths are optimized. The remaining large gains need
an explicitly negotiated protocol or retention change:

- Chunk large keyframes before encoding. A single Store keyframe is still monolithic and measured about
  3.3 MiB at 100,000 representative keys. Define chunk identity, total revision and atomic apply
  before changing the wire path.
- Add a byte budget beside the batch-history entry count. A legal history window can retain many
  large patches even when the number of envelopes is bounded.
- Add a maximum wait to offline debounce only after defining the write-amplification trade-off; the
  current quiet-period debounce can postpone persistence under a permanently busy feed.

### Remaining local-resource routes

The current LAN profiles are CPU/allocation-bound; wire compression is a separate bandwidth trade-off.
Do not combine these routes without measuring the target deployment:

| Route | Likely benefit | Complexity / risk | Gate before implementation |
|---|---:|---|---|
| Transfer decoded Store patch ownership into the mirror instead of cloning it again | Largest remaining 15k Store CPU/live-tree reduction | High: `onBatch`, retained journal and Store must not share mutable values | Define an internal ownership token and mutation tests before removing any clone |
| Negotiated RPB/3 route predictor | Repeated calls/callbacks can reuse the schema last seen for the same route and omit repeated schema selection metadata | High: requires a clear packet prefix, rollback-safe SAME/CHANGE state and exact generation/request/callback ownership | Specify the v3 prefix and differential new↔old/reconnect/re-entrant tests before changing the wire |
| Declare custom policy locality (`record-local` versus `global`) | One changed record across ten 15k-item views measured 5.18 ms on the owner fast path versus 1,239.58 ms with a global custom policy | High: silently assuming locality can expose revoked records | Add an explicit locality contract plus `invalidateAll`/policy revision |
| Keyed/chunked offline persistence | A 250-record change currently snapshots the complete 15k Store; the in-memory adapter measured 34.82 ms per flush | High: changes durable format, migration and crash recovery | Specify chunk revision, atomic manifest and old-snapshot migration |
| Parallel StoreManager startup | Three independent 80 ms reads measured 266.9 ms sequentially versus 91.6 ms in parallel | Medium: current failure and side-effect order is observable | Discuss an explicit concurrency option before changing startup behavior |
| Sacred Peer publish backpressure | Bounds producer memory when lossless transport is stalled | High: lossless data cannot be silently conflated or dropped | Add public `pending`/`drain`, byte high-water and a defined overflow failure |
| Media frame-version capability | Allows a future media header version without guessing from payload bytes | Medium: control negotiation must precede frame emission and preserve v1 peers | Add explicit media capability exchange and new↔old matrix |
| Dynamic media fan-out plus transport-aware latest-frame backpressure | Can avoid repeated work when many viewers follow one source | High: changes delivery/retention semantics | Choose queue vs latest per media kind and expose the choice explicitly |
| Real JPEG/WebP/GPU profiling | Finds browser decode/paint bottlenecks absent from synthetic Node stress | Measurement work, no protocol risk | Run the stand on representative devices before changing codecs or frame policy |

### Future RPB/3 route predictor

This is not part of current RPB/2. RPB/2 deliberately sends a schema definition once and then its
short id, independently of the RPC route. A safe route predictor needs a newly negotiated RPB/3
packet layout with a clear prefix: the decoder must know the packet kind and stable route identity
before it can interpret a compact `SAME` body or a `CHANGE(schemaId, body)` body.

Local JavaScript function identities must be keys only in a `WeakMap`; the predictor must never keep
dynamic callback or facade functions alive. Functions are not a wire identity. Stable state on the
wire belongs to the route/member identity for CALL/PIPE, the request id for RESP and the callback id
for CB/CB_BATCH. All predictor state is directional and connection-generation-local, commits only
after successful send/decode, and resets on reconnect, server replacement or failed stateful decode.
Until that prefix and lifecycle matrix are specified, keeping RPB/2's explicit schema id is the
smaller and safer implementation.

### Compression and dictionary routes

The current mode is **binary application RPC**, not a byte-only connection: after the CAPS + byte
probe, CALL/RESP/PIPE/callback/error traffic uses the RPB `Uint8Array` envelope, while
CAPS/MAP/HELLO/bootstrap stays as backward-readable arrays. Socket.IO already transports those byte
frames without JSON conversion. The same RPB envelope can later ride raw WebSocket, QUIC,
DataChannel or another binary transport; making the connection itself byte-only would additionally
need a binary bootstrap/control envelope and would trade away the present old-peer fallback and
Socket.IO reconnect/framing behavior. There is no demonstrated need for that migration now. Direct
Replay DataChannels are separate from RPB: they now negotiate their own exact-value byte frames
after an ordered text hello/ready, while old endpoints retain the original JSON/base64 route.

The following figures are historical RPB/1 compression-sensitivity measurements on deterministic
quote workloads, before Socket.IO/Engine.IO/WebSocket framing. They predate RPB/2 and Store v6 and
must not be read as current-version benchmark results. They are decision aids, not throughput guarantees.
Reproduce the complete-payload sizes, round-trip checks and local codec CPU with
`npm run bench:rpc-compression`; zstd rows are skipped on runtimes without that optional Node API.
The current mixed demo socket also carries already-compressed JPEG media, so enable whole-socket
compression only after a CPU/latency stand run and exclude incompressible media packets where possible.

| Route | What it improves | Representative benefit | Complexity | Recommended use |
|---|---|---:|---|---|
| Socket.IO `perMessageDeflate` | WebSocket RPC frames | historical warm RPB/1: 2,058 → 423 bytes at 50 quotes (−79.4%); 28,579 → 4,545 at 700 (−84.1%). Isolated Store v5: −55.1% / −62.3% | Low–medium | First live-RPC candidate. Use a 1–2 KiB threshold, bound zlib concurrency/memory, decide context-takeover policy, and load-test media CPU |
| Application gzip | Any byte transport | 18 bytes larger than raw deflate on the measured RPB frames; otherwise nearly the same ratio | Medium | Little value on WebSocket where `perMessageDeflate` already negotiates compression; would need a new RPC capability elsewhere |
| Reverse-proxy gzip / zstd | HTTP static files, HTTP facade and polling responses; **not** messages after WebSocket Upgrade | current 333,858-byte demo bundle: gzip 109,559 (−67.2%), zstd 113,249 (−66.1%) | Low | Keep the existing Caddy `encode zstd gzip`; this is HTTP optimization, not binary-RPC compression |
| Reverse-proxy Brotli q5 | Same HTTP surfaces, not WebSocket frames | current demo bundle: 104,285 bytes (−68.8%), about 4.8% smaller than gzip output | Medium | Use only when the CDN/proxy already supports it; the small extra bundle win does not justify a custom proxy build alone |
| Application-frame zstd | Any `Uint8Array` transport | historical warm RPB/1: −80.0% at 50 and −86.4% at 700; much faster locally than Brotli | High | Consider for a transport without native compression. Needs a codec dependency/WASM for supported Node 16 and browsers, a capability bit, uncompressed-size limits and bomb protection |
| Application-frame Brotli q5 | Any `Uint8Array` transport | historical warm RPB/1: −84.5% at 50 and −90.0% at 700; another 25–37% below deflate output | High | Best measured ratio, but materially more encode latency. Reserve for bandwidth-dominated links and negotiate explicitly |
| Bounded string/path dictionary | Repeated string **values** and path segments not already removed by the layout cache | idealized repeated-value workload: about −14.7% raw; after deflate it was 0.9% worse, after zstd 1.9% worse, and only 6.3% better after Brotli | High | Last resort after production traces. Cap at 1,000 entries per direction/generation, update transactionally, reset on reconnect, and add mixed-version/eviction tests |

Proxy compression and application compression are separate routes. A reverse proxy can compress the
HTTP polling phase, bundle and facade responses, but it cannot retrospectively compress WebSocket
messages after the connection upgrades. A stateful string dictionary is also separate from the
existing ordered-layout cache: layouts remove repeated object keys, while the future dictionary
would target recurring data strings/path components and must never reuse layout-cache ids.
