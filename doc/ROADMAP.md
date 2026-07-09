# wenay-common2 — Roadmap (open / deferred)

> Forward-looking backlog of distributed-state / transport features that are **not fully built**.
> Everything here sits on top of the existing seams — `{emit,on}` transport, `exposeStore` /
> `createStoreMirror`, and the replay `seq` / `keyframe` / `frame` contract. None of it requires
> changing the store core; the store stays single-authority (one `seq` sequencer, last-writer-wins
> per path), and these features are layers or adapters above that.
> Status: 🔴 not started · 🟡 partial / ongoing · 🧊 deferred (super-low priority, not forbidden).
>
> Current focus is NOT more transport: see `doc/target/library-uplift-tasks.md` (showcase, SDK facade,
> vertical demo app). Transport items below stay available but rank below everything in that plan.

## 0. Distributed Runtime Model

The strategic direction is not "RPC plus store helpers"; it is a small distributed-state runtime:
application code keeps a stable typed API while lower layers can choose the transport, route, replay
source, and authority model.

Four concerns must stay explicit:

- **Transport** - how two endpoints exchange `{emit,on}` messages: socket.io, in-process loopback,
  relay, WebRTC/direct channel, or a future adapter. Transport is replaceable infrastructure.
- **Routing** - where a logical call or stream goes: server, peer through relay, peer directly, or a
  promoted relay <-> direct path. Routing must be allowed to change without changing the facade API.
- **Authority** - who is allowed to write truth: one server, partitioned peer-owned slices, server
  authority with client prediction, or true multi-writer conflict resolution. This is a semantic
  decision, not a transport decision.
- **Replay** - how live state survives reconnect, lag, transport swap, and history playback:
  `seq` + keyframe/frame + deltas. Replay is the continuity layer that makes route changes boring.

Design rule: direct peer links and relay hand-offs are optimizations of transport/routing. They must
not silently change auth, ownership, validation, or conflict semantics. If a method is exposed as
`api.hit(playerId)`, it may travel through the server or a direct channel, but the authority rules
behind that method must remain the same.

This implies a useful split:

- **API surface** remains facade-shaped and typed.
- **Transport/routing layer** may substitute sockets and promote paths.
- **Replay layer** resumes streams and mirrors from the last known `seq`.
- **Authority layer** decides whether an incoming write is accepted, predicted, reconciled, or merged.

Critical ordering rule: do **not** start with WebRTC/NAT plumbing or CRDTs. The next useful layer is a
small route/account/policy coordinator with a fake/in-process transport adapter. Direct transport and
multi-writer merge are expensive adapters; they only become safe after the coordinator state machine is
boring and well-tested.

### 0.1 Account route coordinator ("wrapper over wrappers") 🟡

Some deployments need separate client/account identities to communicate directly when policy and
network conditions allow it, while still allowing the server/relay to step back into the path later.
This is not just a socket trick; it is an account-aware routing shell above the existing facade,
mirror, and replay primitives.

- **Account model:** every participant has its own account/session identity and a scoped facade/store
  set. Runtime-account maps are a dynamic keyspace, so they should look like `noStrict(accountMap)`
  rather than a fixed schema. Access checks stay in the facade/policy layer; `noStrict` is not an ACL.
- **Wrapper over wrappers:** an app-level coordinator owns the set of per-account clients, exposed
  facades, mirrors, replay subscriptions, and route state. "State of other accounts" is represented as
  selected `Observe` mirrors/replay/offline resources, ideally started and stopped through
  `createStoreManager`, not as a new global store core.
- **Route states:** a pair of accounts may be `relay`, `direct`, `direct+shadowRelay` (audit/observe
  copy), `blocked`, or `fallback`. Direct links are optional optimizations, useful for latency or
  traffic cost, not a semantic change.
- **Re-interposition:** if NDA/privacy policy, audit, moderation, throttling, reauth, direct-link
  failure, or group topology changes require it, the relay must be able to re-enter the data path.
  This is the reverse of direct promotion: open the replacement route, resume from the last `seq`,
  switch consumers after catch-up, then close or demote the old route.
- **Privacy rule:** direct account links are opt-in and policy-gated. Peers only receive the endpoint
  and session material needed for that specific relationship; no implicit broad account discovery.

Concrete next API shape, not final names:

```ts
createRouteCoordinator({
  policy,
  routes,
  resources,
}) -> {
  pair(a, b),
  state(pair),
  promoteDirect(pair, opts?),
  reinterposeRelay(pair, reason?),
  block(pair, reason?),
  fallback(pair, reason?),
  onRoute(cb),
}
```

Policy must run **before** transport promotion:

- `canDirect(pair, ctx)` - may these accounts attempt direct at all?
- `mustRelay(pair, ctx)` - force relay path because of NDA/audit/moderation/reauth.
- `mustShadowRelay(pair, ctx)` - allow direct payload path, but keep audit/observe copy.
- `canExposeEndpoint(pair, ctx)` - whether signaling may reveal endpoint/session material.
- `canReinterpose(pair, ctx)` - whether/when relay is allowed or required to step back in.

Minimum state machine:

- `relay` -> `direct:connecting` -> `direct` -> `relay:reinterposing` -> `relay`
- `relay` -> `direct:connecting` -> `fallback` -> `relay`
- `direct` -> `direct+shadowRelay`
- any state -> `blocked`

Required failure modes:

- direct setup never completes: keep relay active and mark fallback;
- replacement route catches up too slowly: keep old route active and fail the switch;
- policy changes mid-stream: re-interpose relay through replay hand-off;
- account reauth changes facade/ACL: rebuild route policy before accepting new writes;
- endpoint/session material is revoked: close direct and resume relay from `seq`;
- audit/shadow route lags: decide whether to throttle, fallback, or block by policy.

Acceptance tests for 0.1:

- policy denial: direct is never attempted;
- direct promotion: old relay stays live until replacement catches up;
- failed direct: old relay continues with no data gap;
- re-interposition: direct -> relay resumes from `seq`;
- `direct+shadowRelay`: direct path is active while relay/audit mirror observes;
- revocation: direct closes and relay resumes without changing facade API;
- account map uses `noStrict`, but all access checks live in policy/facade code;
- `createStoreManager` starts/stops selected per-account mirrors without store-core changes.

Open questions: whether the relay sees payloads or only coordinates encrypted direct streams;
backpressure across multi-hop and direct paths; group topology beyond a pair of accounts;
`noStrict(accountMap)` / `createStoreManager` lifecycle integration for dynamic peer maps.

Status: 🟡 partial (2026-07-09, v1.0.67). Core implemented as `Replay.createRouteCoordinator`
(`src/Common/events/route-coordinator.ts`): `RouteConnector` contract (pure transport: open/close/state/
metrics/onFail/capabilities), all five policy hooks, the full state machine above (including
`direct+shadowRelay` audit copy, catch-up timeout, revocation auto-fallback, terminal `blocked`), data
continuity through `replayRouteSubscribe`. Acceptance oracle: `replay/route-coordinator.test.ts` over
fake in-process connectors — policy denial never touches transport, promotion keeps the old relay live,
failed/slow direct falls back gap-free, re-interposition resumes from `seq`, shadow relay observes the
switch window, revocation closes direct without facade changes, block is terminal.
v1.0.68 added step 9: `createSignalHub` (offer/answer/ICE/session/revoke over the EXISTING socket/RPC
control channel; `authorize` = server-side `canExposeEndpoint`), `createWebRtcConnector` /
`acceptWebRtcDirect` (RTCPeerConnection injected as a runtime factory, structural types, no lib.dom),
and `serveReplayChannel`/`channelReplayRemote` (replay wire over any ordered channel — the datachannel
path bypasses the RPC core by design). Oracle `replay/route-webrtc.test.ts` drives promotion, endpoint
denial, session rejection, and server revoke over both an in-proc hub and a real Socket.IO/RPC wire.
Still open: browser/Node WebRTC glue (step 10 — now a one-line `rtc` factory plus media re-emit) and
the account-map lifecycle integration (step 7). Media-side candidates (2026-07-10, after the demo
stand stress test): a real `transport:'webrtc'` media track — SDP over the existing signal hub,
media bypassing the socket relay for call-grade smoothness; and `MediaStreamTrackProcessor` capture
for true 30fps (`grabFrame`'s ~50ms serial latency caps snapshot capture at ~15-20fps).

## 1. Connection hand-off — relay ↔ direct promotion ("port forwarding") 🟡

A relay/intermediary bootstraps a connection between two parties, then — on a signal — **steps out
of the middle**: both ends open a second, direct socket and migrate the live stream onto it,
bypassing the relay. The same mechanism must work in reverse: the relay can deliberately
**re-interpose** and become the middleman again. Under the hood the socket substitutes itself; data
starts flowing on the new path.

- Family: NAT hole-punching / WebRTC TURN→direct promotion, expressed over the existing `{emit,on}`
  abstraction rather than a specific transport.
- **Design lead (reuse what exists):** the socket swap is a *stream resume*, which the replay layer
  already solves. Migrate with `replaySubscribe(..., {since: prev.seq()})` /
  `syncStoreReplay(..., {since})` on the new socket — the consumer fold is gap-free by contract, so a
  mid-stream transport change is not a special case. The transport carries only `seq`; the semantics
  never learn the socket changed.
- **Implemented foundation (2026-07-08):** `Replay.replayRouteSubscribe(...)` and
  `Observe.syncStoreReplayRoute(...)` keep the old route alive, subscribe the replacement route,
  catch it up from the last delivered `seq`, then close the old route. This covers relay → direct
  promotion and direct → relay re-interposition for any ordered `ReplayRemote`; overlap is deduped by
  `seq`, and a failed replacement leaves the old route active.
- Open questions: auth continuity across the swap; per-socketKey vs whole-connection hand-off;
  policy trigger rules for direct → relay re-interposition beyond explicit calls and `onFail`.
- Status: 🟡 mostly done. Route hand-off/resume: `replay/route-handoff.test.ts`. Route decisions +
  state machine: `createRouteCoordinator` (v1.0.67). Signaling + direct endpoint negotiation over the
  existing control channel and fallback-if-never-establishes: `createSignalHub` /
  `createWebRtcConnector` / `acceptWebRtcDirect` (v1.0.68, `replay/route-webrtc.test.ts`). Remaining:
  real NAT/WebRTC runtime glue (injected `rtc` factory) and auth-continuity policy.

## 2. Coordinated fan-out send to a large group 🧊

Synchronized/batched send to a very large audience "at once", as opposed to the current model where
**each connection is paced independently** (per-connection lag gate + `frame` policy).

- Current reality: pacing is per-recipient by design — every client's link is unique. Even in video
  fan-out no two receivers drain at the same rate, so the per-connection gate is usually the *correct*
  answer. That is why this is shelved.
- When it would matter: true lockstep broadcast (all-or-nothing / same-instant delivery) — rare.
- Status: 🧊 deliberately shelved. Revisit only against a concrete lockstep requirement.

## 3. Multi-authority stores — two truths, one reconciliation (games) 🔴

Two stores, each **dynamically filled by its own authority ("truth")**, that must agree on a shared
source of truth. Decompose by write topology:

- **Partitioned authority — fits today.** Each peer authoritative over its own slice → two
  `exposeStore` / `createStoreMirror` pairs crossed over one duplex `{emit,on}`. No new primitive.
  "Confirmation" = the per-direction `seq` ack.
- **Authoritative server + client prediction — small layer on top.** Server store is the truth; the
  client applies optimistically, then reconciles when the authoritative patch arrives. Build a
  `predictedStore` = confirmed mirror + a pending-input list, rebased on each `mirror.each()` /
  `changed` tick. Helper factory, not a core change.
- **Symmetric co-write of the same path — needs a different model.** LWW-per-path converges but can
  silently drop a concurrent write. This is the one case that genuinely needs CRDT/OT. Design lead:
  wrap a Yjs/Automerge doc as a `RemoteStore`-shaped source and mirror from it — the store↔transport
  decoupling makes this a small adapter, not a rewrite.
- Status: 🧊 deferred, super-low priority. Prediction layer waits for the demo app to demand and shape
  it (`doc/target/library-uplift-tasks.md` task 4); CRDT adapter reopens only on a real co-write need.
  Partitioned-authority already expressible today.

## 4. Data-transfer optimization backlog (ongoing) 🟡

Open-ended transfer/perf work, especially for backend-heavy models. Never "done".

- Candidates: tighter `frame` condensation per line; delta/patch minimization; binary framing for hot
  paths; batching heuristics beyond the current `pipe` / `space` modes.
- Status: 🧊 deferred, super-low priority; pick items only as real bottlenecks surface in the SDK/demo
  consumers, not speculatively.
