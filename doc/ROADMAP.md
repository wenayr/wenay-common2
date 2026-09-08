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
- real Socket.IO transport, including native binary attachments on JSON RPC, is covered by an oracle.

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

## 3. RPC authorization — two deliberately deferred seams

The in-band token lifecycle is complete and canonical in `doc/RPC-AUTH.md`. Two extensions were
identified while building it and deliberately not built; both need a consumer before they are worth
their cost.

**`PIPE` retry after `E_UNAUTHORIZED`.** Only a waiting, callback-free `CALL` is retried once. A pipe
chain is opaque and any step may carry a callback whose ids the first `RESP` already released, so a
replay could reference dangling ids. Trigger: a consumer whose real workload is pipe-shaped and hits
token expiry mid-chain often enough to matter. Before implementing, define what a partially executed
chain means on replay — the retry is only safe if the whole chain is.

**A distinct client state for an unsolicited application grant.** `control.grant` moves the deadline
behind the application's back exactly like a renewal, but it reaches the client as an unsolicited
authAck-bearing `Pkt.MAP`, not through the renewal seam, so it emits no `'renewed'`. Giving it its
own state is a protocol-level decision: an unsolicited grant MAP would first have to be
distinguishable from a downgrade by more than `ack.ok !== false`. Trigger: a consumer that must react
differently to "the server raised my privileges" than to "my own renewal succeeded". Widening the
stream stays additive, so waiting costs nothing.

## 4. Multi-hop and group topology — complete

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

## 5. Media and binary performance — measure first

The stand has balanced media and an explicit max-video load mode. MAX preserves the selected camera
and resolution and removes capture pacing: every completed encode immediately starts the next frame.
It reports encoded FPS, MiB/s, average frame bytes, receive FPS and latency. Use those numbers to
identify the actual limiting stage.

Possible one-time adapters, only after measurement:

- `MediaStreamTrackProcessor` or `VideoFrame` capture when `ImageCapture.grabFrame()` is the ceiling;
- native WebRTC tracks/SFU when JPEG-over-RPC bandwidth or decode is the ceiling;
- tighter replay frame scheduling or domain-specific deltas when transport framing is the ceiling.

Do not optimize all three layers at once: that destroys the measurement.

## 6. Scale tier — the growth path (seams and presets, not implementations)

The Scale tier (`Scale.createAuthority` / `Observe.createStoreNode` / `Scale.createClusterClient`,
`doc/changes/2.16.0.md`) closes the middle of one deployment shape: one source of order, N serving
nodes, M consumers. For a library whose job is to START projects fast, the criterion is different
from "how many scaling kinds are covered": the growth path must be monotonic and rewrite-free. A
project starts as ONE process, grows to N nodes, gains a standby, later partitions — and the
application code (the authority config, the client config, the domain module) never changes; only
config and env do. What follows is the list of gaps on that path, in order of payoff, with the
decisions that keep the invariants narrow.

1. **Solo start is the cluster config.** An authority with zero nodes IS a deployment: it serves
   readers itself (`serve.reader()` / `serve.browser()`), the cluster client places on the leader
   row, a node added later takes the readers over by weight. Proof: `observe/scale-solo.test.ts`
   (authority alone → a node joins by config → drain returns the clients gap-free → two authorities
   in one process share nothing). The scaffold ships the day-1 process: `template/leader.ts` is
   both the factory and the leader ENTRYPOINT (`npm run leader`), the same way `node.ts` is.
2. **Partition address = `storeId` — no new field.** A partition is one authority on its own
   `storeId` with the same three factories; per-partition lazy lines already exist on the read
   side. The future coordinator is a `key → storeId` map over N authorities plus a client facade
   holding one cluster client per partition. Rule fixed now so it never becomes a breaking change:
   a command lives inside ONE partition; cross-partition atomicity is a different library.
   Trigger for the coordinator: a consumer whose ONE authority is the measured write ceiling.
3. **The storage seam on the authority line.** `createAuthority({line: {durable: {storage,
   everyEvents?, everyMs?}}})` puts the replica line on the existing persistence port
   (`ReplayStorage`: memory, fs, or the host's DB adapter — the port, never a provider): a restart
   restores the state, continues the seq space, and serves reconnecting followers from the journal
   (no forced keyframe reset). `view.restored()` says what the boot found. Oracle:
   `observe/scale-durable.test.ts`. Done 2026-09-06 (the SaaS examples were the trigger): the
   CONTROL line has its own archive (`control: {durable}`) — receipts and the deny list survive a
   solo restart, the roster is wiped on restore; `observe/scale-durable-receipts.test.ts`. A
   promoted standby still keeps what it followed (attach-on-succession is the remaining seam).
4. **Scaffold and Helm out of the incubator** — for a "deploy fast" library these are product, not
   experiments. Gate before graduation: one run against a REAL cluster
   (`experiments/wenay-k8s/cluster-check.ts`, then the minikube runbook). Status 2026-09-03:
   `minikube start --driver=hyperv` needs an elevated shell (`PROVIDER_HYPERV_NOT_RUNNING`); the
   run is the next manual action, everything below it is prepared.
5. **Recipes, not features:** multi-tenancy (N authorities in one host, each closed over its own
   `storeId`) is proven in the solo oracle and documented in the rare docs. Cascade is stated
   honestly: authority → node → client is the shipped two-hop; a node serves no node link, so a
   regional node feeding other nodes is an OPEN seam (a node-served node link), not a recipe.

Explicitly not built, even under "universal": Raft inside the Store, multi-master writes to one
store, cross-partition transactions, a coordinator without a consumer. One `seq` per partition as
the single source of order is exactly the invariant that lets everything else be configuration.

## 7. What the examples taught (2026-09-06) — and the verdict on layers

Three copyable products were built on the scaffold to probe the library from the startup angle
(`examples/README.md`: rental, pizzeria, apartments). The rule was "what two products need moves
down; what one product needs stays data". Outcome:

- **Moved into the library (additive):** a read projection as its own Store
  (`Observe.deriveStore`), the audience seams on both corners (`createStoreNode.serve.audience`,
  `createAuthority.serve.connection({principal})`, `identity.principal`), and the OpenAPI generator
  next to the HTTP facade. One defect found and fixed with a failing-first oracle: a node's
  forwarded commands were bound to the link captured at session time, so long-lived sessions (a
  device) broke after a leader restart (`observe/store-node-rehome-forward.test.ts`).
- **Stayed in the scaffold as DATA of the domain module:** roles from state, `allow` on commands
  and views, per-audience view lines, credential login/signup (the leader as identity provider),
  the generic role panel, the intent runner for external effects, `SERVICE_DATA_DIR` durability.
  None of it needed a new library layer; all of it needed the seams above.
- **Verdict on redundant layers:** none of the tier's layers (replica set → node → cluster client;
  command host → token corridor; control line → roster/deny/receipts) was bypassed or duplicated by
  any of the three products. The suspicious candidates were checked: `createStoreFollower` vs
  `createStoreReplicaSet` are two different consumers (a fixed line vs fork-choice over offers —
  the device uses the first, the app the second); `readerFacet` (one anonymous projection) is now
  subsumed by `views` and kept only for compatibility — the one piece to retire in the next
  breaking release; the demo's own `http-openapi` was a duplicate and is gone.
- **Second wave (pushing to the edge):** four more defects with failing-first oracles — a durable
  close lost the last acknowledged writes (`flushReactiveNow`), receipts did not survive a solo
  restart (`control: {durable}`), the host's principal shared a visitor's command budget
  (`limits.budgetOf`), and `initial` adoption bit a second authority in one process (scaffold
  clones; documented). What stayed above the library: the payments port with a Stripe-shaped
  adapter, the client facade, schema versioning with `migrate`, limits as definition data.
- **Open, with triggers:** promote `createEffectRunner` into `Command` when a second consumer
  outside the examples needs it (payments alone is one); a node-served node link (regional cascade)
  when a consumer places nodes across regions; refund/reversal semantics (a paid booking cancelled)
  when a product needs money to flow back — the intent pattern covers it, the example does not.

## Explicitly not backlog

- frontend-framework adapters in this package;
- application-specific storage, database, provider or persistence implementations;
- a home-grown CRDT/OT engine;
- Raft/quorum/consensus hidden inside Store replication;
- coordinated lockstep fan-out without an all-or-nothing broadcast requirement;
- speculative binary formats or native SFU without measured need;
- storefront GIFs and historical showcase task lists.

## Next decision

Three open items, in order: the real-cluster run that gates the scaffold/k8s graduation (§6.4 — a
manual elevated `minikube start`, everything else is prepared; the three examples are the workload
to deploy), retiring `readerFacet` in favor of `views` in the next breaking release (§7), then the
shared-document provider (§1) once one engine integration is chosen. Everything else waits for a consumer or a measured
bottleneck; §6 lists the exact triggers for the partition coordinator and the durable control line.

## Current scaling safety boundary

Local process failover and a two-authority socket partition fixture are verified; see [SCALE-SAFETY.md](SCALE-SAFETY.md). The fixture arbiter is not a real lease service. The K8s experiment currently deploys serving nodes behind one external leader; elect/accept do not renew leases or fence external effects. Real-cluster graduation therefore also requires the selected coordination/resource adapter and stale-writer acceptance tests.
