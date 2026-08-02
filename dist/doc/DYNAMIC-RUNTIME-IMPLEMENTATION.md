# Dynamic runtime internal vertical slice

Status: implemented internal prototype, direct-source imports only. No package export was added.
This is executable evidence for the architecture in
[`DYNAMIC-RUNTIME.md`](DYNAMIC-RUNTIME.md), not a production deployment subsystem.

## Outcome

The repository now contains one end-to-end path:

```text
serialized manifest + immutable bytes
    -> inert manifest validation
    -> content hash + signature + host policy
    -> verifier-owned artifact capability
    -> fresh worker_threads realm
    -> warmup + health candidate gates
    -> slot-scoped ContractOffer
    -> ContractRuntime atomic binding
    -> stable handle + lease
    -> bounded worker call
```

The same control facade is driven through a temporary loopback Streamable HTTP MCP adapter:

```text
official MCP Client
    -> module.stage / module.activate / module.rollback
    -> DynamicHostModuleControl
    -> DynamicModuleHost
    -> ContractRuntime
    -> worker_threads
```

The MCP adapter is control plane only. Normal module calls do not pass through MCP.

The first dynamic contribution slice is also executable. A module registers a namespaced tool with
its injected `context.mcp`; the parent checks an exact policy, the host-owned experiment gateway
attaches the registration, and the official-SDK adapter routes the contributed call back to the
exact isolated worker. Runtime add/remove and catalog relist are proven without returning MCP from
the module factory. Full host/session lifetime orchestration and activation-coupled generation
replacement remain separate work.

The external deployment boundary also has a restart-safe three-host reference path:

```text
signed Git build
    -> immutable manifest-hash registry coordinate
    -> existing content-addressed Artifact byte cache
    -> durable desired state + command receipt + audit
    -> fenced canary/batch rollout
    -> three DynamicModuleHost worker nodes
    -> post-activation probes
    -> complete or quarantine + automatic rollback to LKG
```

This is deliberately under `experiments/dynamic-runtime`: registry, deployment policy, fleet
coordination, and persistence are host responsibilities rather than new library exports.

## Corridors and file ownership

| Corridor | File | Responsibility |
| --- | --- | --- |
| Manifest schema | `src/Common/dynamic/module-manifest.ts` | Bounded inert parse, exact structure, normalization, signature payload |
| Trust gate | `src/Common/dynamic/module-verifier.ts` | Owned bytes, SHA-256, signature callback, allowlists, policy, unforgeable-in-process provenance |
| Isolation contract | `src/server/dynamic/module-isolation.ts` | Host-neutral verified-artifact/session port |
| Node isolation adapter | `src/server/dynamic/module-worker-isolation.ts` | Manifest-to-worker budget mapping and unsupported-policy rejection |
| Parent worker session | `src/server/dynamic/module-worker.ts` | Handshake, calls, timeouts, heartbeat, termination, dependency broker |
| Worker realm | `src/server/dynamic/module-worker-bootstrap.ts` | Factory evaluation, method dispatch, AbortSignal, result/dependency messages |
| Lifecycle host | `src/server/dynamic/module-host.ts` | Stage, warmup, health, offer, activation, rollback, handles, audit facts |
| MCP domain port | `experiments/dynamic-runtime/module-control.ts` | Transport-neutral experiment contract and deterministic fake |
| Real-host adapter | `experiments/dynamic-runtime/dynamic-host-control.ts` | Immutable artifact lookup, idempotent commands, explicit slot mapping |
| MCP adapter | `experiments/dynamic-runtime/mcp-adapter.ts` | Official SDK tools/resources and loopback Streamable HTTP |
| Real self-client | `experiments/dynamic-runtime/runtime-self-client.ts` | MCP-to-real-worker proof |
| MCP contribution gateway | `experiments/dynamic-runtime/mcp-contribution-gateway.ts` | Host-owned catalog, publication receipts, leases, attach/detach, isolated invocation |
| Contribution self-client | `experiments/dynamic-runtime/contribution-self-client.ts` | Official-client dynamic add/call/remove/relist proof |
| Artifact registry/provider | `experiments/dynamic-runtime/artifact-registry.ts` | Immutable verified publication, Git provenance, existing byte-cache adapter |
| Durable rollout journal | `experiments/dynamic-runtime/rollout-journal.ts` | Atomic desired-state commits, authority/generation fence, receipts, LKG, quarantine, audit |
| Fleet rollout | `experiments/dynamic-runtime/rollout-fleet.ts` | Per-node fence, prepare-all, canary/batches, probes, rollback |
| Fleet self-client | `experiments/dynamic-runtime/fleet-self-client.ts` | Three real worker hosts, restart recovery, v1/v2 update, injected v3 rollback |

The package entrypoints do not re-export any of these new runtime symbols. The existing
`ContractRuntime` remains the only active-binding engine.

## Three-hop external control plane

### Hop 1: immutable artifact delivery

`createModuleArtifactRegistry` accepts serialized manifest bytes, code bytes, and an exact Git
source coordinate. Publication runs the full existing `ModuleArtifactVerifier` first. The registry
key is the verified manifest hash, while `contentHash` continues to identify the code bytes. This
allows two signed manifests over identical bytes to remain distinct rollout artifacts without
duplicating the byte cache. Repeating the exact publication is idempotent; conflicting Git
provenance for an existing reference is rejected.

`createModuleArtifactProvider` adapts the existing `createArtifactByteCache`. A miss fetches bytes
from the registry, checks that the descriptor and canonical manifest still hash to the requested
artifact reference, recomputes code SHA-256 against the descriptor content hash, owns a defensive
copy, and folds concurrent same-hash fetches into one source request. Every `DynamicModuleHost`
still runs its own manifest, integrity, signature, and policy verification before worker creation.
A trusted registry therefore does not become a bypass around the host trust gate.

Git is metadata at publication time. Runtime nodes know only an immutable artifact reference and
never run `git pull`, `checkout`, package installation, or source compilation on the call path.

### Hop 2: durable desired state and facts

`createModuleRolloutJournal` writes whole-state events through the existing `ReplayStorage` port.
Each command appends exactly one event before the command is exposed as accepted; in-memory state
advances only after that append succeeds. Periodic keyframes bound recovery work. The file
demonstration uses `openFsReplayStorage`; its newline commit boundary discards a torn final append
during restart.

The durable state records:

- one authority id and monotonically dominant authority epoch;
- one global rollout generation and desired command;
- semantic command fingerprints and accepted/completed/failed receipts;
- active and last-known-good bindings per node;
- quarantined artifact references;
- ordered audit facts.

The same `commandId` plus the same semantic fingerprint replays its receipt. Reusing an id for
different intent fails. A lower epoch, a different authority at the same epoch, or a non-increasing
new generation fails before node work. The reference journal permits only one accepted unfinished
rollout at a time; superseding a live rollout requires an explicit future policy. Accepted but
unfinished receipts are returned by
`view.pending()` and `reconcile()` resumes them after control-plane restart. This is recovery of a
desired effect, not cancellation on transport disconnect.

An event-append failure leaves both the in-memory generation and receipt unchanged. Keyframes are a
recovery optimization after the event commit: a keyframe failure marks journal health degraded and
is retried by a later commit, but cannot turn an already durable command into an ambiguous failure.

The reference Store snapshot is intentionally small. Production should move the same port to a
transactional database, define retention/compaction, and make the command receipt plus outbox/audit
write one database transaction.

### Hop 3: fenced canary fleet rollout

Each `createModuleRuntimeNode` owns a local `(authorityId, authorityEpoch, generation, commandId,
artifactRef)` fence. It fetches and stages through `DynamicModuleHost`, activates through the
existing `ContractRuntime`, and exposes only a stable handle on the data plane. This local fence
prevents a stale coordinator from bypassing the central journal in the running process. A
production node must persist that fence or obtain a valid coordinator lease before effects.
Repeated prepare/activate/rollback for the same fenced command observes the current binding first,
so restart reconciliation does not re-activate an already active generation or roll back twice.

`createModuleFleetRollout` performs:

1. durable command acceptance;
2. prepare on every node, with no activation if any prepare fails;
3. activation of a deterministic canary set;
4. injected post-activation probes and a failure threshold;
5. activation/probe of the remaining nodes in bounded batches;
6. durable completion and LKG promotion only after every batch passes;
7. reverse-order rollback of every node switched by the failed command;
8. durable failure, current-binding snapshot, and artifact quarantine.

The distributed transition is deliberately not claimed to be globally atomic. Each node swap is
atomic, and rollout policy bounds how many nodes can be on the candidate at once. During rollout,
different nodes may legitimately serve different versions. Protocol/schema changes therefore need
an expand/contract compatibility window or explicit traffic partition. Strong global cutover
requires a routed generation gate or distributed transaction outside this library.

The demonstrator uses one canary and one-node batches. v3 is healthy during candidate staging and
on the canary, then an injected observation failure occurs after the second node activates. The
controller rolls both changed nodes back; the untouched third node stays on v2. Rollback is a new
binding generation, so the first two nodes finish on generation 4 while the untouched node remains
on generation 2. This difference is expected; correctness is keyed by version/hash plus each
node's binding generation, not by requiring equal local counters.

## Trust boundary

### Serialized input

The network/file boundary accepts only `string | Uint8Array`. Validation:

- limits manifest bytes before parsing;
- uses fatal UTF-8 decoding for bytes;
- accepts exact own data properties, rejecting accessors and unknown fields;
- rejects sparse/non-data arrays, duplicate values, invalid identifiers, traversal entrypoints,
  unsupported protocols, inconsistent hashes, and invalid budgets;
- requires `signature.signedFields` to cover every present root field except `signature`;
- freezes the normalized manifest deeply.

Trusted local callers may call the underlying validator with an object for fixtures. External
adapters should use the serialized parser.

### Integrity, signature, and policy

The verifier copies artifact bytes before its first asynchronous boundary. It then:

1. parses the inert manifest;
2. checks exact byte length;
3. hashes the copied bytes with the existing `Artifact.sha256Hex`;
4. compares the digest without early string exit;
5. checks publisher key allowlisting;
6. calls an injected signature verifier over the canonical signed payload;
7. applies capability and permission allowlists;
8. applies the optional host policy;
9. returns frozen evidence plus defensive byte copies.

Verified artifacts are registered in a private `WeakSet`. The worker isolation adapter calls
`assertVerifiedModuleArtifact` before decoding. A structurally similar object cannot cross that
in-process seam.

There is no replaceable post-verification decoder. The exact verified byte copy is decoded as
fatal UTF-8 immediately before worker construction.

### What worker_threads does and does not guarantee

The current adapter supports only:

- `compatibility.runtime.name == 'node'`;
- a deliberately small accepted Node range grammar (`*`, exact, `>=`, or `^`);
- bundled factory source at `./index.js`;
- no declared network, storage, or secret permissions;
- no `cpuMs`;
- memory from 16 through 4096 MiB.

Unsupported declarations are rejected. They are never silently treated as enforced.

`worker_threads` gives a separate JS realm/heap and a deterministic kill mechanism. It is not a
hostile-code security sandbox: ambient Node globals and process-wide OS authority are not safely
virtualized. Only signed, allowlisted first-party code is suitable. Code needing ambient
permissions, hard CPU enforcement, or an untrusted publisher must use a child process, container,
or separate service isolator.

## Module artifact form

The prototype artifact is one UTF-8 JavaScript expression evaluating to a factory:

```js
function createModule(context) {
    return {
        'health.warmup'() {
            return {ok: true}
        },
        'health.check'() {
            return {ok: true}
        },
        async operation(input, call) {
            return {ok: true, input, generation: call.bindingGeneration}
        },
    }
}
```

The factory receives immutable identity metadata,
`context.dependencies.call(moduleId, method, input)`, and the internal scoped
`context.mcp`. A method receives its input and a call context containing an `AbortSignal`,
module/version/hash/candidate identity, correlation id, and the exact active binding generation.
The registrar is disabled unless the verified artifact's host policy supplies exact allowed
descriptors. Nested factories may capture it, but it is never stored as process-global state.

This source form is an experiment. A production build format, ESM/CJS packaging contract, source
maps, and reproducible builder are still decisions.

## Worker protocol and containment

The private protocol string is `wenay-common2/module-worker@2`. It is not public or stable.

Parent-to-worker messages:

- `ping`;
- `call` with call id, method, input, correlation id, and binding generation;
- `cancel`;
- `dependency-result`.
- `mcp-call` and `mcp-registration` publication acknowledgement.

Worker-to-parent messages:

- `ready` with exact module metadata and method list;
- `pong`;
- `result`;
- `dependency-call`;
- `mcp-register` and `mcp-unregister`;
- `fatal`.

The parent verifies the ready metadata against the candidate it started. Input and output are sized
with `node:v8.serialize`; source, concurrency, input, output, startup, call, heartbeat, and memory
budgets are enforced at their corresponding boundaries.

A call timeout or AbortSignal posts best-effort cancellation and terminates the entire unsafe
generation. Arbitrary synchronous JS cannot be reliably preempted inside one worker while keeping
that worker trustworthy. Late replies are ignored because pending call ownership has already been
removed.

Termination is idempotent and awaitable. It clears startup/heartbeat timers, rejects pending calls,
terminates the worker, and closes the event line exactly once.

## Host lifecycle

The implemented candidate states are:

```text
verifying
    -> instantiating
    -> warming
    -> health-checking
    -> ready
    -> activating
    -> active
    -> retired
```

Any gate can instead end in `rejected`; explicit disposal or host shutdown ends in `closed`.

Control commands are serialized through one host control chain. This keeps stage, activation,
rollback, revoke, and discard from interleaving ownership mutations. The data plane does not use
that chain.

Stage:

1. creates an inert candidate record;
2. awaits the full verifier;
3. checks required active dependencies;
4. creates isolation only after verification;
5. starts the worker and waits for handshake;
6. runs warmup with binding generation zero;
7. runs health with binding generation zero;
8. records `ready`.

Generation zero cannot call live dependencies through the host broker. This prevents candidate
warmup/health code from accidentally reaching authoritative downstream services. A later shadow
facility may offer explicit read-only fixtures.

Activation:

1. rechecks required dependencies;
2. creates a `ContractOffer` scoped to exactly one `slotId`;
3. lets `ContractRuntime` open and accept the prepared session;
4. atomically switches the Contract binding;
5. changes the candidate to active only after the selected binding points to its offer.

An offer cannot bind another slot merely because that slot demands the same contract. The offer
checks `ContractOfferContext.demand.slotId` before opening.

Rollback delegates to `ContractRuntime.rollback`. It opens a fresh worker from the previously
verified immutable artifact and produces a new binding generation. It never reuses arbitrary
process module cache state.

## Failure handoff and leases

The isolated-session failure signal is sticky across the small handoff window between
`ContractOffer.open()` and `ContractRuntime` subscribing to `session.onFail`. The wrapper retains
the first terminal reason and immediately presents it to a late subscriber. A worker that dies
during activation cannot become a permanently dead active binding.

The stable handle performs:

```text
ContractRuntime.acquire(slotId)
    -> isolated call(bindingGeneration from lease)
    -> release in finally
```

A synchronous throw from the isolated call is caught and releases the lease before rejection.
Retired sessions are not directly terminated by candidate discard after ownership has transferred
to `ContractRuntime`; they follow its lease drain/timeout policy. Host shutdown is an explicit
cancellation boundary and awaits worker termination.

## Dependencies: A -> B -> C and B -> D

A stores only `host.resource.handle('b-slot')`; it never captures B's implementation object. A
replacement of B changes the Contract binding pointer, not A.

B's verified manifest carries the complete dependency descriptors. The worker parent keeps those
descriptors and rejects undeclared module ids before invoking the host broker.

The host broker:

- identifies the verified active caller by module id, version, and content hash;
- resolves the dependency slot through an injected mapping or the default module-id convention;
- checks active implementation id;
- checks API compatibility (exact by default, injectable policy for ranges);
- checks required capabilities;
- acquires a fresh dependency lease for every call;
- applies its own timeout and correlation suffix.

This lookup is why an already-active B v2 can begin using optional D immediately after D becomes
available.

For optional `degradation: 'unavailable-result'`, missing D or a failed D call produces:

```ts
{
    ok: false,
    code: 'E_UNAVAILABLE' | 'E_DEGRADED',
    moduleId: 'compression-d',
    retryable: true,
}
```

Required dependency absence rejects staging before isolation. `cached-read` needs an explicit cache
owner and is not implemented. Method-level dependency ports/schema validation are also deferred;
the current descriptor does not yet contain a method allowlist.

## MCP control experiment

The experiment pins `@modelcontextprotocol/sdk@1.30.0` and `zod@4.4.3` as development
dependencies. The SDK root declares Node `>=18`, but its currently resolved secure
`@hono/node-server@2.0.12` dependency declares Node `>=20`; run the MCP experiment on Node 20 or
newer. This does not change the library's exported Node `>=18` runtime. The adapter registers:

- tools: `module.stage`, `module.activate`, `module.rollback`, `module.explain`, `module.health`;
- resources: `wenay://dynamic-runtime/guide` and
  `wenay://dynamic-runtime/implementation-prompt`.

The HTTP host:

- binds only `127.0.0.1`;
- applies official localhost Host validation;
- checks Origin when supplied;
- checks a constant-time Bearer token before JSON parsing;
- uses bounded JSON;
- creates and closes one stateless MCP server/transport pair per request;
- begins session cancellation and listener shutdown concurrently;
- has a forced connection-close deadline.

This shared-token model is development-only. Production needs principal identity, per-tool
authorization, durable audit, secret rotation/OAuth policy, rate limits, and deployment-specific
network controls.

`slotId` and `moduleId` are explicit and distinct in every control command. The real self-client
uses `compression.primary` and `compression.impl` so a hidden equality cannot mask an addressing
bug.

Command receipts are keyed by `commandId` and retain a semantic fingerprint. Identical concurrent
requests share one in-flight promise. Reuse with different intent is rejected. Accepted commands
are durable relative to the HTTP request: client disconnect does not define rollback or
cancellation. A production coordinator must persist the receipt and outcome.

### Implemented internal boundary: scoped MCP contributions

The first transport-neutral boundary from `DYNAMIC-RUNTIME.md` is now implemented internally:

```text
module context.mcp registrar (inside its isolation owner)
    -> cloneable signed descriptors + bounded invocation port
    -> host-owned McpContributionGateway
    -> official-SDK MCP adapter / HTTP adapter / in-process test adapter
```

The worker injects `context.mcp` into the root module factory. The module calls
`context.mcp.contribution({id, lifetime}).tool(descriptor, handler)` and continues returning only
its runtime facade. Each tool gets a receipt with `control.remove` and synchronous
`view.snapshot`; contribution/root registration facts are available through `events.on` and
`view.snapshot`. The handler stays inside isolation; only inert descriptors, registration facts,
and invocation messages cross the worker seam.

The receipt progresses through `pending`, `accepted`, `attached`, `detached`, `rejected`, or
`removed`. Parent acceptance means the descriptor exactly matches `mcpPolicy`; attachment means an
external gateway has actually published it. With no policy the registrar is disabled, so a module
cannot self-authorize a new tool.

The gateway is logically shared by one host but is constructed and injected through `deps`, not a
static singleton. The implemented slice owns namespaced worker sources, catalog generations,
publication receipts, attach/replace/detach, invocation leases, authorization callback, events,
health, and disposal. Detach blocks new calls immediately while an already leased call may finish.
The external MCP adapter owns protocol transport. Required probes remain deterministic rollout
policy even when an architect/agent prompt also encourages discovery and exploratory calls.

Long-lived desired-coordinate persistence, session TTL, and activation-coupled aliases are not yet
implemented. Their target invariant remains: reconstruct verified code after restart, never
serialize live handlers/workers, swap a generation alias with its runtime binding, drain old leases,
and remove a session contribution at verdict/TTL/close.

`experiments/dynamic-runtime/contribution-self-client.ts` is evidence for tool registration,
publication, invocation, runtime add/remove, explicit client relist, and detach. The HTTP adapter
creates a stateless MCP server per request, so it does not yet prove unsolicited
`notifications/tools/list_changed` delivery on a long-lived client session.

## What remains outside the prototype

- Production registry/HTTP/object-store adapters, reproducible Git builder, channel promotion, and
  verified offline LKG boot.
- Real signature algorithm/key store, revocation, rotation, timestamp/transparency evidence.
- Versioned external state, prepare/commit/abort migration, recovery checkpoints.
- Authoritative output-generation gate and Store Replay projection.
- Circuit breaker, bulkhead, retry/idempotency policy, transactional/outbox effects.
- Continuous observation windows, shadow traffic, statistical thresholds, and operator approval.
- Database-backed receipts/audit, retention/compaction, and cross-region replication.
- Child process/container/service isolators and hard capability/resource enforcement.
- Consensus/leader election, node-local durable fences, leases, and large-fleet convergence.
- Production HTTP/RPC/MCP authorization.
- Signed host/generation/session MCP declarations, companion `D.mcp`/`D.verify` artifact binding,
  layered principal catalogs, desired-state recovery, session TTL, activation-coupled alias swap,
  stateful MCP list-change notifications, and architect/agent catalog injection.
- Public names, export path, generated declarations, and compatibility commitment.

No `RPC-AUTH.md` synchronization was required: the implementation does not change the library RPC
authorization surface. The MCP Bearer middleware is experiment-local and is documented here as
non-production.

## Verification

Focused commands:

```powershell
npx tsc -p tsconfig.json --noEmit
npx tsc -p experiments/dynamic-runtime/tsconfig.json
npx tsx observe/dynamic-module-manifest.test.ts
npx tsx observe/dynamic-module-worker.test.ts
npx tsx observe/dynamic-module-mcp-registrar.test.ts
npx tsx observe/dynamic-module-runtime.test.ts
npx tsx observe/dynamic-module-host-races.test.ts
npx tsx observe/dynamic-module-artifact-registry.test.ts
npx tsx observe/dynamic-module-rollout-journal.test.ts
npx tsx experiments/dynamic-runtime/self-client.ts
npx tsx experiments/dynamic-runtime/runtime-self-client.ts
npx tsx experiments/dynamic-runtime/contribution-self-client.ts
npx tsx experiments/dynamic-runtime/fleet-self-client.ts
npm run test:dynamic-runtime:acceptance
npm run test:all
npm run test:stress:extended
```

The tests independently cover:

- inert manifest structure and canonical signature payload;
- byte ownership, hash/signature/policy failures, and defensive copies;
- worker handshake/metadata/heartbeat;
- input/output/concurrency/time/abort limits;
- dependency allowlist and degradation;
- deterministic terminate/start/call races;
- exact MCP registration policy, rejected undeclared tools, receipt statistics, and cleanup;
- gateway attach/invoke/runtime-add/detach with an old in-flight contribution lease draining;
- required-dependency rejection before isolation;
- slot-scoped offers;
- v1 in-flight completion across v2 atomic activation;
- dynamic optional D recovery;
- failed health leaving the active binding unchanged;
- malformed manifest, corrupt bytes, bad signature, browser runtime, and unsupported CPU budget
  failing before worker session creation;
- rollback to a fresh generation;
- close during verification without candidate resurrection;
- failure in the offer handoff window without a dead active binding;
- synchronous isolated-call failure without a leaked lease;
- discard of a claimed retired candidate without killing its old in-flight call;
- MCP authentication before parsing, Origin rejection, resources/tools, command single-flight,
  command-id conflict, real activation, real stable-handle call, and real rollback.
- official-client dynamic tool relist, contributed isolated invocation, runtime removal, and source
  detach without a module factory MCP return value;
- immutable publication with Git provenance and conflict rejection;
- content corruption rejection during provider fetch;
- one shared content-addressed delivery across three hosts;
- durable accepted-command recovery from the existing file ReplayStorage;
- persistence failure leaving the in-memory desired state and receipt unchanged;
- command idempotency, authority epoch/generation fencing, and per-node fencing;
- canary then one-node batches, post-activation failure injection, quarantine, and automatic
  rollback of already switched nodes;
- rejection of a new rollout command for a quarantined artifact;
- old v1 in-flight completion while all later calls observe v2;
- one real Socket.IO/Store Replay mirror remaining continuous across v1-to-v2 replacement,
  transient transport reconnect, and rollback to a fresh v1 binding generation;
- reconnect deduplication, offline tail recovery, cascade failover, route hand-off, and fork
  reconciliation as one repeatable acceptance command;
- bounded 100+ MiB fan-out with four reconnect generations, exact binary integrity, zero remaining
  listeners/connections, and closed decode resources.

Before promotion, expand deterministic barriers to every lifecycle await, add parent-to-child
dependency cancellation, and add post-activation monitoring. Run the full project suite and build
only when a publication task is explicitly authorized.
