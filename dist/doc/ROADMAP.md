# wenay-common2 — conditional roadmap

The core contract is complete: typed RPC, Listen/replay, Observe Store, offline/mirror helpers,
route hand-off, Peer/media, resource/AI/artifact/conversation protocols, self-assembling Store
replicas and versioned implementation bindings are shipped. Published history belongs in
`doc/changes/`; this file lists only work that still has a concrete reopen condition.

The library guarantees contracts. Frontend frameworks, application package delivery, databases,
provider clients and product-specific persistence adapters are outside this repository.

## 1. Shared documents — candidate

Trigger: a real consumer needs concurrent editing of the same text/document, including offline
edits. Do not turn every Store into a CRDT and do not implement a text CRDT here.

The useful library-sized addition is an engine-neutral provider factory over a proven CRDT engine:

```ts
createSharedDocument({
    documentId,
    engine,       // encode snapshot/state vector, apply update, observe local update
    remote,       // snapshot/state-vector request + binary update Listen + submit command
    awareness?,  // separate ephemeral presence/cursor line
    policy?,
}) -> {document, ready, status, awareness?, close}
```

RPC carries `Uint8Array` updates and initial/differential sync messages. The host checks account and
document ACL before accepting an update, deduplicates through the engine's idempotent update format,
and fans accepted updates out through Listen/replay. Content snapshots and the update journal are a
persistence-port concern. Cursor/selection awareness is ephemeral and must not enter the durable
document log.

Acceptance before promotion into public API:

- two clients edit the same position concurrently and converge;
- disconnect, offline edits and reconnect converge without full replacement;
- duplicate/reordered updates are harmless;
- unauthorized documents and updates remain invisible;
- a compacted snapshot plus later updates reconstructs the same document;
- awareness disappears after disconnect without modifying document history;
- real Socket.IO/RPC binary transport is covered by an oracle.

## 2. Predicted Store — candidate

Trigger: a game or latency-sensitive command UI needs immediate local feedback and visual-only
optimism is insufficient.

`predictedStore` is not multi-writer truth. The server mirror remains authoritative. The client keeps
`confirmed state + ordered pending commands`, renders the result of replaying pending commands over
the latest confirmed snapshot, removes a command when its receipt/authoritative result arrives, and
rebases the remaining commands. A rejection removes the command and therefore snaps the projection
back deterministically.

Do not build it until one consumer defines command identity, confirmation, rejection and rebase
semantics. Generic Store patches alone cannot infer them.

## 3. Multi-hop and group topology — complete

Store multi-hop is already compositional: `createStoreReplicaSet` supports leader → follower →
follower cascades, dynamic connection offers, accumulated latency, anti-cycle paths and route
selection. No separate topology engine is required.

Arbitrary peer packets now use `createPeerPacketMesh`: dynamic reusable connection offers open
transport-neutral sessions, exchange path-vector route capabilities, measure additive cost, select
the cheapest live next hop and reconcile when an offer disappears. Packets carry stable identity,
origin, sequence, TTL and traversed path; intermediate clients forward without learning payload
semantics. `broadcast(targets, payload)` is group delivery as independent routed packets, so one slow
member does not stall the others. Oracle: `replay/peer-packet-mesh.test.ts`; interactive Lab stand:
**Peer packet mesh**.

Store replication remains separate because it adds authority, epochs and conflict semantics on top
of transport. Pair replay routing remains separate because it guarantees seq catch-up across a
relay/direct hand-off. The packet mesh is specifically the higher arbitrary-data topology which was
missing between those two completed layers.

## 4. Media and binary performance — measure first

The stand has balanced media and an explicit max-video load mode. MAX preserves the selected camera
and resolution and removes capture pacing: every completed encode immediately starts the next frame.
It reports encoded FPS, MiB/s, average frame bytes, receive FPS and latency. Use those numbers to
identify the actual limiting stage.

Possible one-time adapters, only after measurement:

- `MediaStreamTrackProcessor` or `VideoFrame` capture when `ImageCapture.grabFrame()` is the ceiling;
- native WebRTC tracks/SFU when JPEG-over-RPC bandwidth or decode is the ceiling;
- tighter replay frames, binary batching or delta formats when transport framing is the ceiling.

Do not optimize all three layers at once: that destroys the measurement.

## Explicitly not backlog

- frontend-framework adapters in this package;
- application-specific storage, database, provider or persistence implementations;
- a home-grown CRDT/OT engine;
- Raft/quorum/consensus hidden inside Store replication;
- coordinated lockstep fan-out without an all-or-nothing broadcast requirement;
- speculative binary formats or native SFU without measured need;
- storefront GIFs and historical showcase task lists.

## Next decision

The only plausible new library surface is the shared-document provider. Before implementation,
choose one engine integration and lock the minimal host/client RPC contract above. Everything else
waits for a consumer or a measured bottleneck.
