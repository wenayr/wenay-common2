# Scaling and deployment — staged plan

Status: **agreed direction, staged plan for discussion**. Every stage below that names a new export
touches the public API and therefore requires its own explicit public-interface discussion before
code (see `CLAUDE.md`). Read together with [`../ROADMAP.md`](../ROADMAP.md),
[`../RECOMMENDATIONS.md`](../RECOMMENDATIONS.md), [`../RPC-AUTH.md`](../RPC-AUTH.md),
[`../DYNAMIC-RUNTIME.md`](../DYNAMIC-RUNTIME.md) and
[`KEYFRAME-CHUNKING.md`](KEYFRAME-CHUNKING.md).

## Why this plan exists

The distributed primitives are shipped and oracle-covered: seq replay with keyframe catch-up,
follower cascades and `promote()` failover, self-assembling replica sets with epoch fork-choice and
`diffKeyedState`, the full in-band token lifecycle, `(account, requestId)` idempotency in the
protocol hosts. What is missing is not machinery but **layers**: the demo hand-writes, as
application code, what a deployment needs as library surface:

- command forwarding through a mirror is hand-built per command (`demo/server.ts` `mirrorFragment`);
- the mirror authenticates to the leader with a static env service token and **asserts** the end
  client's account — the leader must fully trust the mirror;
- every node is ~800 lines of hand wiring; there is no config-driven node role;
- connection placement/rebalancing has no library answer, although gap-free line hand-off
  (`syncStoreReplayRoute.switch`) already exists;
- a Store keyframe is monolithic (the known slow-link blocker, measured in
  `experiments/slow-network-2026-08`).

Architecture rule adopted for balancing (discussed 2026-08): **the center distributes facts and
weights; the edge decides and switches.** No component owns another component's connections; a
coordinator outage degrades to "clients keep acting on last known facts", never to an outage of the
data plane. Fine-grained rebalancing moves **lines** (gap-free by seq); whole-socket moves happen
only at placement and drain.

## Stage 0 — mirror trust model (decision, no code)

The choice shapes stages 1–2. Two modes:

1. **trusted-mirror** — the leader authenticates the mirror by a service token; the mirror asserts
   the end client's account (today's demo shape). Cheap, but the leader cannot distinguish a
   compromised mirror from a client.
2. **end-to-end** — the end client's token crosses the hop and the leader re-verifies it itself.
   `createTokenCodec` with a shared secret already permits this; the mirror also verifies locally
   to serve its own per-principal facade.

Recommendation: support **both as explicit modes**, end-to-end as the default where the secret can
be shared. Acceptance: the decision recorded here plus a planned `RPC-AUTH.md` addendum; no code.

## Stage 1 — command corridor (standard forwarded requests)

Goal: one library layer for "commands execute on the single point of order, with the end client's
identity, idempotently, through any number of hops".

- Extract the `(principal, requestId)` receipt + rate-limit pattern (today repeated inside the
  Conversation/Ai/FileJob hosts and the demo) into `createCommandHost({commands, authority})`.
- `forwardCommands({upstream, principal})` — the standard mirror fragment replacing the demo's
  hand-built `mirrorFragment`.
- Contract: after `follower.promote()` the command host adopts the same store (the demo already
  does this by hand; make it the documented seam).

Acceptance: the demo mirror rewritten on the new layer with no behavior change; an oracle proving
one receipt for one `(account, requestId)` across two hops, including replay after reconnect.

## Stage 2 — principal across hops (tokens)

Goal: any mirror is as good as the leader for authentication; the on-behalf-of hop is a contract,
not a convention.

- `resolveAuth` at the mirror (shared-secret verify, per-principal facade served locally).
- The on-behalf-of envelope for the mirror→leader hop in the stage-0 mode(s).
- Renewal/expiry semantics across the hop (what happens to an in-flight forwarded command when the
  end client's grant expires).
- Mandatory `RPC-AUTH.md` sync — it is the canonical page.

Acceptance: oracle with a real two-hop socket chain: expiry mid-stream downgrades exactly like the
single-hop corridor; a revoked end client loses the mirror facade without the mirror restarting.

## Stage 3 — node constructor, directory, balancer (deployment)

Goal: a node is configuration, not wiring; placement and rebalancing are library behavior.

- `createStoreNode` (name to be discussed): config → role (`leader | mirror | edge`), exposed
  lines, upstream, token source, durable persistence, `createNodeHealth`, HTTPS-manager hookup.
  Deliverable: the demo server's wiring collapses into config; a second node = same binary + env.
- `createNodeDirectory` — a replicated Store of node facts `{nodeId, endpoints, role, health,
  load, weight, draining}`, fed by `createNodeHealth`, mirrored everywhere like any other line
  (monitoring of the replication IS replication).
- `createConnectionBalancer` (client side) — directory subscription → offers (the
  `createStoreReplicaSet` / `createPeerPacketMesh` offer model, reused, not reinvented) → policy
  (directory weight + own measured latency + priority + hysteresis + optional `hash(account)`
  stickiness; placement by power-of-two-choices) → execution via the hub's socket factory and
  `syncStoreReplayRoute` for line-level moves.
- `drain()` on the node: publish `draining`/weight 0 in the directory, let clients leave gap-free,
  hard-close the remainder after a timeout (SIGTERM-shaped lifecycle).

Dependencies: stage 2 (a mirror must authenticate anyone the balancer sends to it) and stage 1
(writes forwarded from wherever the client lands). Read `doc/DYNAMIC-RUNTIME.md` before this stage:
the node constructor borders the host/runtime ownership boundary and must not absorb host duties.

Acceptance: a three-node stand (leader + two mirrors) where killing a mirror moves its clients
without losing a single per-key event; `drain()` empties a node with zero client-visible gaps.

## Stage 4 — measured scaling (protocol work)

Only with measurements, per `RECOMMENDATIONS.md`:

- **Keyframe chunking** — the three gates in [`KEYFRAME-CHUNKING.md`](KEYFRAME-CHUNKING.md)
  (chunk identity, total revision, atomic apply) decided and implemented. The only genuinely risky
  wire change in this plan; it changes Store Replay V2 and needs a compatibility matrix.
- **Journal byte budget** beside `history`/`keepMs` (`journalWindow()` gains bytes).
- **Partitioning axis** — per-partition selected lazy lines / replicated maps already cover current
  scenarios; a shard coordinator only when a real consumer outgrows them (ROADMAP discipline).

## Stage 5 — separate Kubernetes package (outside this repo)

A new package (working name `wenay-k8s`) built **on** this library. Per the ownership boundary in
`DYNAMIC-RUNTIME.md`, the K8s package is a **host**: it owns deployment, rollout, discovery and
lifecycle, and adapts them onto library seams — it re-implements no binding runtime, no replay
protocol, no second registry.

- **Discovery adapter**: K8s API (endpoints/pods/readiness) → node-directory entries / balancer
  offers. The directory stays the library contract; K8s is one feeder.
- **Probes**: readiness/liveness served from the `createNodeHealth` store.
- **Lifecycle**: `preStop`/SIGTERM → `drain()` → gap-free client departure → exit.
- **Roles**: leader + mirrors as a StatefulSet; leader election via a K8s Lease injected into
  `createStoreReplicaSet`'s `leadership.elect/accept` seam (the library deliberately keeps
  election injectable — no consensus hidden inside Store, per ROADMAP).
- **Manifests/Helm chart** for the three-node stand from stage 3.
- **Optional dynamic updates** (last): a control plane adapting the existing Contract-runtime
  corridor (offers → stage → health → activate → rollback), following the reference control plane
  in `experiments/dynamic-runtime` — canary/quarantine/LKG shapes exist there already.

Dependency: stage 3 (the package configures `createStoreNode`; without it, it would own wiring that
belongs to the library). Stages 5a (discovery/probes/lifecycle) are useful long before 5b (dynamic
updates); ship them separately.

## Stage 6 — project template (scaffold, outside this repo)

Goal: "a rental/booking-style server starts in a day" — a scaffold package that composes the
finished stages into a running project where the application author writes only the domain: the
store shape, the commands with validation, and the visibility policies. Everything below the domain
is the same for any product on this stack.

- The template wires: `createStoreNode` roles, the command corridor + token threading, the
  directory + balancer, durable journal + keyframe backups (`createDurableStoreReplay` + fs
  adapters, already shipped), health, HTTPS, and the stage-5 K8s charts.
- **Observability is a template page, not a subsystem**: every balancing decision at every level
  (directory, health, follower status, route events) already lives in a store, so the admin
  dashboard is one more mirror consuming the same data the decisions are made from.
- **Balancing levels the template makes visible** (one owner per level, no level reaches into
  another): 1 — entry (DNS/ingress, deliberately dumb, infrastructure-owned); 2 — socket placement
  (client decides by directory facts, stage 3); 3 — per-line routes (`syncStoreReplayRoute`,
  shipped) plus functional implementations via Contract runtime; 4 — in-stream volume
  (frame policies, conflation, lazy lines, shipped).
- Additive REST/OpenAPI slice: `createHttpFacadeServer` already walks a facade tree into static
  GET/POST routes; an OpenAPI descriptor generated from the same walk is the documented seam for
  external integrations (Swagger UI). Additive adapter in the template, no new wire.

Dependencies: stages 1–3 (stage 5 for the K8s part). The template is a host per the
`DYNAMIC-RUNTIME.md` ownership boundary; its skeleton can start any time after stage 3.

## Delivery rhythm: every step lands on the SAME living stand

The mini-horizontal-scaling stand (Lab, `npm run demo`) is the acceptance vehicle: each step adds
one capability to it and is proven by hand in the browser, on top of its oracle. A step is not done
while its stand scenario has not been walked live. Big steps are cut into slices, each with its own
intermediate stand pass — never more than a day of blind building between two live proofs.

### Step 1 — node directory + client rebalancing (stage 3 core) — DONE

- Library: `createNodeDirectory` / `nodeDirectoryViews` / `pickDirectoryNode` /
  `followNodeDirectory` (`src/Common/Observe/node-directory.ts`) + the `directoryReplicaOffers`
  bridge into the existing `createStoreReplicaSet` — route selection, hysteresis and seq hand-off
  stay in the replica set; no new balancer code.
- Oracle: `observe/node-directory.test.ts` — host verbs, staleness, weighted pick, follow over a
  replay wire, and the balance part: drain moves a replica-set client mirror→leader with identical
  snapshots (zero loss); full outage → route null → comeback on undrain.
- Stand, proven live: Spawn → the tab rebalances onto the mini node (weight 4 vs 1); Drain → back
  on the leader in ~2 s with the tick line monotonic the whole way; the node exits on its OWN
  directory row (drain is data, no control channel); hard kill of both minis → the client walks the
  live offers back to the leader, no reset.

### Step 2 — command corridor (stage 1) — DONE

- Library: `Command.createCommandHost` — at-most-once per `(account, requestId)`: a duplicate
  answers a cloned receipt, concurrent duplicates share one execution, an error commits nothing
  (honest retry), keepMs/maxPerAccount retention, perMinute budget burned only by new executions —
  plus `Command.forwardCommands`: a mirror serves the byte-identical fragment shape, so the client
  cannot tell nodes apart.
- Oracle: `replay/command-host.test.ts` — including the headline property: two hops share ONE
  receipt space.
- Stand, proven live: "+10 via my node" wrote through mini-1 (forwarded to the leader as person-a);
  "Repeat last requestId" via mini-1 → receipt; Drain mini-1 → repeat the SAME requestId through
  the leader → receipt again, counter stayed 20. Exactly the production case: a node dies, the
  client retries through another node, no double effect.

### Step 3 — tokens across hops (stage 0 decision + stage 2) — DONE

Stage-0 decision (recorded): both modes explicit — `trusted-mirror` (`forwardCommands`, relay
asserts the account, application-authenticated link) and `end-to-end`
(`verifyCommands` + `forwardCommandsByToken`, the END client's token crosses every hop and only
the authority resolves it), end-to-end the default where the secret can be shared. `RPC-AUTH.md`
was read before the code and is unchanged — no transport-auth surface changed; the envelope rides
INSIDE authenticated calls and the trust modes are documented in the Command block of
`wenay-common2.md`.

- Library: `src/Common/command/command-token.ts` — `CommandTokenFragment`,
  `verifyCommands({host, accountOf})` (authority: verify EVERY call; a throw commits nothing),
  `forwardCommandsByToken({upstream, names}).fragment(token)` (relay: client-facing shape
  identical, identity never asserted). Owns no crypto and no token format.
- Oracle: `replay/command-token.test.ts` ALL GREEN with the real `createTokenCodec` — verified-sub
  execution, opaque token pass-through, receipt space shared between the token hop and direct
  execution, malformed/expired rejection leaving NO receipt, deny-listed sub refused, accounts
  separate. Two-hop auth semantics hold by composition: each node runs the harness-pinned
  single-hop corridor (`npm run test:rpc` stages 1–6) and the envelope itself is stateless.
- Stand, proven live (3a+3b): anonymous "+10" → `leader refused the write — login first (gated
  facade)`; Login mints a codec token, presented in-band to the leader AND each mini
  (`mini-1 verified the token locally — person-a @ mini-1`); writes flow via whatever node the tab
  reads from, `(by person-a, verified at the leader)` on every hop; **Revoke → `auth[leader]:
  revoked` and `auth[mini-1]: revoked` in the same second** — the mini cut its OWN session on the
  replicated deny-list fact (`revocation fact applied: person-a` in its console), no restart, the
  read line kept ticking (only the write plane died); renewal refused while revoked; re-login
  lifted the ban and writes resumed on every node. Cross-node receipt retry re-proven under
  tokens: +10 via mini-1 → drain → repeat the SAME requestId via the leader → receipt, counter
  unchanged.
- 3c, proven live: the demo workboard host's private receipts replaced by `createCommandHost`
  (domain rules stayed; `forward` = library `forwardFragment`), the mirror hop rewritten on
  `forwardCommands` (trusted-mirror mode). `replay/workboard-demo.test.ts`,
  `oracle/realsocket/store-mirror.spec.ts` (15/15) and `store-promote.spec.ts` (16/16) all green —
  receipt-through-mirror and promote semantics unchanged; a live mirror instance on :3200 created
  an item that appeared on the leader as "Participant ZA added …". Both trust modes now run on the
  stand: workboard = trusted-mirror, mini-scale = end-to-end.

### Step 4 — node from config + placement + panel (stage 3 remainder) — DONE at demo level

`DYNAMIC-RUNTIME.md` was re-read before design; consequence applied: the node factory owns node
behavior, the HOST keeps what only a process can own (env, transports, exit) and passes them as
adapters through `deps`. NO library surface changed this step — placement and the panel compose
entirely from existing exports; promoting the factory into the library stays a separate
public-interface discussion (see the open decision below).

- 4a, proven live: `demo/scale-node.ts` — `createScaleNode(deps)` closure factory owning the
  leader link, replica line + to-leader offer, local token verify + replicated deny-list cuts,
  gated `scale` + ungated `app` serving, `forwardCommandsByToken`, register/heartbeat, and the
  watch-own-row leave (grace → goodbye → `deps.onLeave`). `demo/mini-scale-node.ts` collapsed to
  env → config → factory. On the stand the factory nodes passed EVERY step-1..3 scenario:
  local token verify (`person-a @ mini-1`), forwarded writes verified at the leader, Revoke cut
  `auth[leader]` and `auth[mini-2]` in the same second, receipt repeat, drain self-exit.
- 4b, proven live: whole-socket placement is level-2 balancing done at the edge — a sticky
  weighted pick (`pickDirectoryNode`) fed through `directoryReplicaOffers.priorityOf`; re-pick
  only when the placed node loses eligibility. Six simulated readers (each with its OWN sockets
  and placement) spread 3/3 over two weight-4 minis with the weight-1 leader at 0; on drain the
  three placed readers re-picked within one directory tick. Deliberate semantics shift: spawning
  a node no longer yanks placed clients — they move only when their node stops being eligible.
- 4c, proven live: who-reads-where is DATA. Key finding: a replica-set client keeps sessions to
  ALL nodes (fork-choice needs their descriptors), so socket counts lie about reading; the honest
  fact is the replay line's subscriber count — only the ACTIVE route subscribes to the line.
  Every node publishes `meta.readers` from its own line via the ordinary heartbeat, and the panel
  renders the REPLICATED directory rows. The cascade shows up honestly: leader readers = tabs on
  the leader + the mini nodes themselves. kill -9 of a mini removed its row and dropped the
  leader's readers in real time; the tick line never gapped.

Resolved (user approved 2026-08-28): the factory shipped as PUBLIC `Observe.createStoreNode`
(`src/Common/Observe/store-node.ts`; instance type `StoreNodeInstance` — `StoreNode` was taken by
the store tree). Crypto stays with the host (`deps.auth.verify`), the upstream link arrives
resolved (the host owns hub/transport), `wrap()` shapes the served RPC object. Oracle:
`observe/store-node.test.ts` (real RPC over an in-process loopback, 16 checks). The demo mini
node is now a ~90-line process host around the library factory; proven live end to end
(verify/forward/revoke-by-fact/drain-self-exit 0).

### Step 5 — size ceilings (stage 4, measured)

- 5a — DONE: `keepBytes` + `sizeOf` on the replay journal (`replay-listen.ts`), newest entry never
  evicted, all three bounds coexist (whichever bites first), `journalWindow()` gains
  `bytes`/`keepBytes`/`cappedByBytes`; Store layer defaults `sizeOf` to the SAME wire estimator
  batch admission uses. Oracle `replay/journal-bytes.test.ts` (34 checks; 27 fail with the feature
  stashed — proof before fix run literally); full sweep + realsocket replay specs green.
- 5b — DONE. Gates decided (KEYFRAME-CHUNKING.md "decided protocol v1": pull facet `chunks`,
  per-call budget 256K clamped 16K..4M, no interleaving change, producer retains the ENCODED set
  60 s TTL / LRU 4, capability = facet presence — no Caps bit, monolithic fallback on any
  failure). Implemented additively in store-replay.ts; V2 patch shapes and since/keyframe/frame
  semantics untouched, so the compatibility matrix collapses to "member absent = today's wire",
  pinned by the oracle. Oracle: replay/keyframe-chunks.test.ts 18/18 (split/disjoint/one-seq,
  oversized value, assembly+tail, TTL/LRU, fallback, opt-out, legacy peer).
- Final stand — DONE (experiments/slow-network-2026-08/chunked-keyframe.ts, 100k keys ≈ 4.3 MiB
  over a throttled relay, 3 green runs, numbers in RESULTS.md): monolithic = deterministic
  `ping timeout` disconnect (line occupation 6.6× the heartbeat budget); chunked = 19 chunks,
  largest message 240 KiB, ZERO ping timeouts, deep-equal convergence, live tail resumed;
  a mid-assembly socket kill → fresh begin → converged. Found in passing: bench.ts's relay can
  deliver out of order at high rate (WS stream corruption) — flagged separately; the new stand
  drains one FIFO queue.

### Step 6 — wenay-k8s (stage 5, separate package)

Skeleton SHIPPED, incubated at `experiments/wenay-k8s` (graduates to its own npm package): kube
endpoint-source port + fake api, `createK8sDirectoryFeeder` (pod facts → the directory's own
verbs: appear→upsert, unready→weight 0, deleting→drain one-way, gone→remove, periodic heartbeat
so staleness keeps meaning "feeder dead"), probes from `createNodeHealth`, and a 23-check
self-check incl. a REAL replica-set zero-loss move on `markDeleting`. Lease election is a
documented TODO onto the replica set's `leadership` seam — no fake stubs.

- 6a. Discovery adapter against a REAL cluster: swap the fake for `@kubernetes/client-node`.
  Intermediate stand: the step-4 admin panel lists pods from a kind cluster.
- 6b. Lifecycle: preStop/SIGTERM → `drain()` → gap-free client departure → exit (the drain half is
  already proven on real processes in step 1). Intermediate stand: `kubectl delete pod` = the
  Drain button.
- 6c. Leader election via a K8s Lease injected into the replica set's `leadership.elect/accept`
  seam. 6d. Helm chart for the three-node stand.
- Final stand: `helm install` into kind/minikube; `kubectl scale --replicas=5` and
  `kubectl delete pod` visible live in the same admin panel with the client counter never gapping.
- 6e (last, ships separately): dynamic updates over the Contract-runtime corridor per
  `DYNAMIC-RUNTIME.md`.

### Step 8 — the Scale facade family — DONE 2026-08-29

All three slices landed and were walked live: 8a public Scale namespace (createAuthority 36/36 +
createClusterClient 22/22 oracles, cast-free readers(), sweep 129/129); 8b demo on the facades
(host 368→206 lines, server.ts untouched, facet captions on every Lab card); 8c template
leader.ts 359→191 lines onto ONE createAuthority call with service.ts untouched (scaffold 19/19,
rental 16/16, REST rewired onto corridor.byToken()). The stand caught and we fixed an autoscale
flap at exact capacity boundaries (spawn now carries hysteresis like drain). Facade gaps
recorded for future discussion: view.onNodes push, read-projection home on serve.browser/reader,
drain(nodeId) authority verb.

(Approved by the user 2026-08-29:)

The user's course correction: the plan's endpoint is BIG LEGIBLE FACADES, and they lag the
primitives — the authority side is ~300 hand-wired lines (even the template mirrors them), the
browser cluster client is 4 primitives glued by hand, readers() hides behind an `as any`.
Decision (explicit public-interface discussion held): new namespace `Scale` with
`createAuthority` + `createClusterClient` (+ re-export of `createStoreNode` — the third corner),
each a deliberate multi-level facade (facets by audience: line / directory / identity / corridor /
serve.{browser,reader,nodeLink,connection} / view; client: store / status / placement / view).
Stands migrate fully onto the new facades and every card gets a facet caption — the stand shows
the REAL public API. Sticky placement moves from the demo into the library client.

- 8a. Library: src/Common/scale/ (authority + client + index), oracles, declaration diff.
- 8b. Demo migration onto Scale.* + facet captions on cards (host keeps spawn/autoscale/kill —
  process supervision is host work).
- 8c. Template leader.ts collapses onto Scale.createAuthority; scaffold + rental self-checks
  stay green — the "300 lines → config" payoff proven.

### Step 9 — authority succession + durable receipts — DONE 2026-09-02

The two architectural gaps named in review: the authority was a single point of failure for writes
AND for the control lines, and receipts lived only in its memory. Landed: `Command.createCommandReceipts`
(receipts as a replicated line; the host publishes commits/drops and `adopt()`s a line), an internal
line-succession primitive (`scale-succession.ts`: follow → promote from the followed snapshot → demote),
and `createAuthority({leadership})` — one factory runs as leader or standby, the replica set's fork choice
/ autoPromote / lease seam is the ONE leadership decision, the three control lines follow it. Nodes
re-home when their host resolves a different upstream link. Oracle `observe/scale-failover.test.ts`
(fails 6/28 without the seeded hand-over). Stated boundaries: a command in flight when the leader dies
may execute again on the successor (no receipt exists anywhere yet); transport rotation to the new
leader is host work (the standby's url is a roster row; the demo stand stays single-leader for now);
the K8s Lease still plugs into `leadership.elect/accept` (6c) — nothing here pre-empts it.

### Step 7 — template + OpenAPI (stage 6) — DONE 2026-08-28 (incubated)

All three slices landed the same day, each proven by its oracle plus a live pass: 7a scaffold
(experiments/wenay-scaffold, self-check 19/19), 7b OpenAPI + Swagger UI on the demo
(replay/http-openapi.test.ts 25/25, /docs live), 7c rental example
(examples/rental, self-check 16/16 incl. drain-mid-order receipt survival; live REST walk:
book → receipt → live board, duplicate requestId answered, overlap refused, 401 unauthenticated).
Run the rental stand: `node experiments/wenay-scaffold/examples/rental/run.mjs` → :3400/board,
/docs, /openapi.json. Graduation to a real npm scaffold package + the agents' recorded library
candidates (createStoreAuthority, readers() view, visibility filtering, validate-with-state,
codec TTL option, errToObj stack opt-out) are follow-up discussions, not part of this step.

Original slicing for reference:

- 7a. Scaffold, incubated at `experiments/wenay-scaffold` (graduates to its own package like
  wenay-k8s): `template/` where the author edits ONE domain module (store shape, commands with
  validation, visibility policies) and everything below arrives wired — `createStoreNode` roles,
  command corridor + token threading, directory, http facade; `create.mjs` instantiates the
  template; `self-check.ts` boots the instantiated service (leader + one node), runs a command
  through the corridor and proves replication + drain, ALL GREEN. Host boundary per
  DYNAMIC-RUNTIME.md: env/transports/crypto/exit stay in entrypoints, never in the domain module.
  Intermediate stand: the self-check IS the boot proof; the browser stand arrives with 7c.
- 7b. OpenAPI descriptor generated by REUSING the real facade walk through its public surface:
  call `createHttpFacadeServer` with a RECORDING `app` ({get, post} capture) — no new src export,
  no duplicated walk. Uniform operation shape (POST `{args: [...]}` envelope, result/error
  responses, bearer scheme), optional per-route summaries from an annotations map. Demo serves
  `GET /openapi.json` + a Swagger UI `/docs` page (swagger-ui-dist). Intermediate stand: open
  /docs on the running demo, try-it-out a facade call live.
- 7c. The rental-service example assembled FROM the scaffold (`examples/rental` inside the
  incubator): items + bookings store, `book`/`cancel` commands with receipts, REST via the http
  facade + generated spec.
- Final stand: the rental service runs as leader + minis, Swagger UI serves the generated spec, an
  order placed via REST appears in a live store subscription, a node drain mid-order loses nothing.
- Order: 7a ∥ 7b (independent), then 7c on top of both, then the final stand pass.

## Order and immediate next steps

Steps 1–3 are DONE (see above, proven on the stand). Order for the rest: 4 → 5 and 6
(parallel; 6e last); 7 assembles the finished steps and may start its skeleton after 4.

1. **Step 4a** — `createStoreNode` (read `DYNAMIC-RUNTIME.md` first; name needs its
   public-interface discussion) — the demo node wiring collapses into a config object.
2. **Step 4b** — whole-socket placement by directory facts (power-of-two-choices).
3. **Step 4c** — the admin panel as one more mirror of the same stores.

When a stage completes, move its durable outcome into `ROADMAP.md`/`doc/changes/` and trim this
page; delete the page when stage 5 ships.
