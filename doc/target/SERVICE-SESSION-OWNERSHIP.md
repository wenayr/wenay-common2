# Service session and agent ownership: composition review

SC1 update, September 10: v1 is approved and implemented for 2.19.0; its durable contract is
[SERVICE-RESOURCES.md](../SERVICE-RESOURCES.md). The SC1 discussion below is historical.
H1/H2 remain separate proposals and are not prerequisites for the shipped session resource API.

September 10, 2.20.0 review: H3/M1/A1 are implemented separately. H1/H2 were checked again
against both Docker/LXD agent sources and the generated queue/host declarations. The public
composition starts with `createAsyncQueue(1).add(pass)` + `onIdle()`, a Store `snapshot()` read
inside each pass, `listen().on(request)` for subscription ownership, `AbortController` for
cooperative cancellation, and `installServiceSignals({close})` at the process edge. This does
not remove the pending-notification flag or retry/disposer ownership: wrapping every event
in `queue.add` still enqueues every pass, and throttle/debounce cannot supply the missing
post-IO wake-up contract. Thus a supported adapter needs its own deliberately specified
reconcile/ownership facade; exposing private host lifecycle would not solve it.

The concrete dependent shutdown in Docker is cancellation/subscription and retry removal,
gateway/client shutdown, completion of the current pass, then lock close/unlink. LXD has no
gateway and one retry timer; it still needs the pass to finish before releasing the lock.
Neither is equivalent to parallel disposal of independent host resources. A timeout must
leave uncertain external work explicit. The proposed contract below remains the smallest
extension to discuss; 2.20.0 adds no speculative H1/H2 export and does not claim consumer
agent adoption. The latest request asks for this assessment separately from H3/M1/A1.

Review of SC1/H1/H2 from the September 9, 2026 consumer package, against common2 2.18.1.
PC1/PC2 have a separate patch; H0 uses the existing Store API. This document is a
proposal, not a declaration of implemented exports or consumer acceptance.

## SC1: a protected session resource

The public declaration map was checked at `service`, `service/client`, `service/server`
and `service/host`. `describeService` carries names, view allow lists and phantom
definition types. `createServiceClient` owns private endpoint hubs, token renewal and
permissions reconciliation. The host mount receives Express, leader/node and a lifetime
signal; it is not a per-principal factory hook. `createServiceAccess` already owns
per-session projections, current roles and disconnect/account replacement cleanup.

Low-level `createHostResource` plus `createRpcServerAuto` and the leader's identity can
host a peer facade, as the network regression proves. That does not supply an additional
facet through the existing service client. Repeating those auth/renewal/placement loops
in each application fails the requested composition boundary. `readerFacet` cannot
own publication, signal subscriptions or asynchronous resources.

The smallest candidate extension belongs to the service session boundary:

- A definition declares named resource permissions and a server factory receiving a
  verified principal, server-generated session ID and cancellation signal. The result
  contains an explicitly addressed remote facet and a disposer. Its type is inferred.
- The descriptor serializes only names, placement and permissions. Factory functions,
  credentials, seed data and resources remain server-side.
- The client provides a typed resource handle plus current availability facts. Initial
  support pins resources to authority. Main-view placement must not relocate a room.
- Session ownership reuses access's account/expiry/role checks. Late factory results
  are disposed. Account changes replace ownership; same-account renewal needs an
  explicit reuse rule. A denied resource does not remove unrelated commands/views.

An unresolved implementation seam must be settled before exposing this contract:
peer `peers` is a dynamic `noStrict` map. RPC principal pruning cannot revoke its
existing subscriptions. Closing a peer connection stops outgoing effects but preserves
host-owned journal reads. Therefore the resource boundary needs enforceable per-session
read/subscription teardown, not merely `{...peer.fragment}` plus an abort signal.
The existing RPC subscription registry, request admission and service access guards
are the primitives to reuse. A second transport or a recursive ad-hoc RPC proxy is
not a supported shortcut.

Before marking SC1 complete, exercise peer and one non-peer resource through public
entrypoints: exact remote inference, safe JSON descriptor, live subscription revocation,
two tabs, pending factory cancellation, reauth/account change/reconnect, and main node
handoff with authority-pinned resources. Browser integration remains consumer work.

## H1/H2: agent orchestration

Both `apps/hosting/backend/agent.ts` and `lxd-agent.ts` repeat busy/dirty/running,
subscription removal, retry timers and shutdown. Their Docker operation-keyed retries
and LXD retry timer have different policy. Both now read `snapshot()` per pass.

`createAsyncQueue(1)` already supplies serialization and idle completion, but queues
every admitted task and has no close/cancellation scope. A small wrapper may reuse it
with one pending-notification flag. `createThrottle` drops calls while busy; its debounce
does not guarantee a second pass for a notification arriving inside the active callback.
Neither adds the required ownership contract by itself.

The candidate reconcile wrapper should expose `control.request`, shared `close`, an
injected pass receiving an AbortSignal, and outward errors. One pending pass reads a
fresh snapshot when it actually starts. Retry delay/keys remain caller policy. Close
must unsubscribe/cancel timers and await the active cooperative pass; do not label an
uncancellable external operation stopped because a timeout elapsed.

For H2, the internal `createHostLifecycle` disposes independently in parallel and has
bounded host shutdown. Exporting it unchanged would violate dependent agent teardown.
The candidate public ownership scope needs reverse acquisition order for dependent
resources, explicit parallel groups for independent disposers, shared close completion,
late-acquisition cleanup, aggregate disposal failures and preservation of the primary
startup error. This belongs below the reconcile consumer; it need not alter host policy.

The user subsequently approved implementation of all waves. Version 2.21.0 implements
this boundary as `createResourceScope` and `createReconciler`; the contract is now
documented in [ASYNC-OWNERSHIP.md](../ASYNC-OWNERSHIP.md). The original comparison
above explains why existing queue/host lifecycle behavior was preserved.

## Status

SC1 is shipped in 2.19.0 and accepted by the consumer. H1/H2 are implemented in 2.21.0
with primitive tests, public types, a generated hosting example and a migration patch
verified on isolated copies of both actual agent sources. The existing Docker/LXD
protocol fixtures pass. Applying the supplied patch to the consumer checkout remains
consumer work; the current task changes only common2. No live VM acceptance is claimed.
