# Recommendations — current seams only

Completed migrations and released work are recorded in `doc/changes/`, not repeated here.

## Current Store/RPC default

Use Store Replay V2 over the ordinary JSON-array RPC lane. `api.replay` is the only Store replay
facade; it has no legacy fallback or numbered generation members.

RPC application traffic uses JSON arrays only. Keep `RpcOpt` limited to measured JSON-wire
optimizations (`compact` and `callbackBatch`) rather than adding another application serializer.

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
an explicitly negotiated retention or persistence change:

- Chunk large keyframes before encoding. A single Store keyframe is still monolithic and measured
  about 3.3 MiB at 100,000 representative keys. Define chunk identity, total revision and atomic
  apply before changing the wire path.
- Add a byte budget beside the batch-history entry count. A legal history window can retain many
  large patches even when the number of envelopes is bounded.
- Add a maximum wait to offline debounce only after defining the write-amplification trade-off; the
  current quiet-period debounce can postpone persistence under a permanently busy feed.

### Remaining local-resource routes

The current LAN profiles are CPU/allocation-bound; wire compression is a separate bandwidth
trade-off. Do not combine these routes without measuring the target deployment:

| Route | Likely benefit | Complexity / risk | Gate before implementation |
|---|---:|---|---|
| Transfer decoded Store patch ownership into the mirror instead of cloning it again | Largest remaining 15k Store CPU/live-tree reduction | High: `onBatch`, retained journal and Store must not share mutable values | Define an internal ownership token and mutation tests before removing any clone |
| Declare custom policy locality (`record-local` versus `global`) | Avoids a full projection rescan for record-local rules | High: silently assuming locality can expose revoked records | Add an explicit locality contract plus `invalidateAll`/policy revision |
| Keyed/chunked offline persistence | Avoids snapshotting the complete Store for a small update | High: changes durable format, migration and crash recovery | Specify chunk revision, atomic manifest and old-snapshot migration |
| Parallel StoreManager startup | Reduces latency for independent reads | Medium: current failure and side-effect order is observable | Discuss an explicit concurrency option before changing startup behavior |
| Sacred Peer publish backpressure | Bounds producer memory when lossless transport is stalled | High: lossless data cannot be silently conflated or dropped | Add public `pending`/`drain`, byte high-water and a defined overflow failure |
| Media frame-version capability | Allows a future media header version without guessing from payload bytes | Medium: control negotiation must precede frame emission and preserve existing peers | Add explicit media capability exchange and a mixed-version matrix |
| Dynamic media fan-out plus transport-aware latest-frame backpressure | Can avoid repeated work when many viewers follow one source | High: changes delivery/retention semantics | Choose queue vs latest per media kind and expose the choice explicitly |
| Real JPEG/WebP/GPU profiling | Finds browser decode/paint bottlenecks absent from synthetic Node stress | Measurement work, no protocol risk | Run the stand on representative devices before changing codecs or frame policy |

### Compression routes

Application traffic and CAPS/MAP/HELLO bootstrap use JSON arrays. Binary business-data leaves remain
native transport attachments rather than being expanded into JSON number arrays.

Reverse-proxy compression applies to HTTP assets, facade responses and polling, not WebSocket
messages after Upgrade. Socket-level `perMessageDeflate` is the first candidate for
bandwidth-constrained RPC, but it needs a production CPU/latency measurement and should avoid
already-compressed media. Application-frame compression would require a separate capability,
uncompressed-size limits and decompression-bomb protection; there is no current evidence that its
complexity is justified.
