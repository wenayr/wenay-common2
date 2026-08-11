# Prompt: harden and extend the dynamic runtime vertical slice

Use this prompt for a separate, explicitly authorized implementation task. Replace bracketed
deployment choices before starting. Do not treat this document itself as authorization to change
the public API.

```text
Repository: wenay-common2

Goal
----
Harden and extend the existing internal vertical slice for safe dynamic module replacement,
following doc/DYNAMIC-RUNTIME.md and doc/DYNAMIC-RUNTIME-IMPLEMENTATION.md. Reuse the existing
Contract runtime and Artifact/RPC/Store Replay primitives. Do not introduce a second binding
runtime, generic MCP protocol, or Git-as-runtime-loader. Do not replace existing primitives: wrap
the present verifier, isolation port, worker session, host, and experiment adapters.

Before editing
--------------
1. Read AGENTS.md completely and follow its construction, facade, factory, type, syntax,
   verification, generated-declaration, documentation, and progress-file rules.
2. Read:
   - doc/DYNAMIC-RUNTIME.md
   - doc/DYNAMIC-RUNTIME-IMPLEMENTATION.md
   - doc/prompts/MCP-ARCHITECT.md when MCP contribution planning is in scope
   - doc/CONTRACT-RUNTIME.md
   - doc/ARTIFACT-RUNTIME.md
   - doc/RPC-AUTH.md before any RPC authorization work
   - doc/wenay-common2.md and doc/wenay-common2-rare.md
3. Start from generated declarations:
   - lib/index.d.ts
   - lib/server.d.ts
   - lib/Common/contract/contract-index.d.ts
   - lib/Common/contract/contract-data.d.ts
   - lib/Common/contract/contract-offers.d.ts
   - lib/Common/contract/contract-resolver.d.ts
   - lib/Common/contract/contract-runtime.d.ts
   - lib/Common/artifact/artifact-hash.d.ts
   - lib/Common/artifact/artifact-cache.d.ts
   - lib/server/httpFacadeServer.d.ts
4. Confirm behavior in:
   - src/Common/contract/contract-runtime.ts
   - src/Common/contract/contract-offers.ts
   - src/Common/contract/contract-resolver.ts
   - src/Common/artifact/artifact-hash.ts
   - src/Common/artifact/artifact-cache.ts
   - src/server/httpFacadeServer.ts
   - src/Common/dynamic/module-manifest.ts
   - src/Common/dynamic/module-verifier.ts
   - src/server/dynamic/module-isolation.ts
   - src/server/dynamic/module-worker-isolation.ts
   - src/server/dynamic/module-worker.ts
   - src/server/dynamic/module-worker-bootstrap.ts
   - src/server/dynamic/module-host.ts
   - experiments/dynamic-runtime/dynamic-host-control.ts
   - experiments/dynamic-runtime/artifact-registry.ts
   - experiments/dynamic-runtime/rollout-journal.ts
   - experiments/dynamic-runtime/rollout-fleet.ts
   - experiments/dynamic-runtime/fleet-self-client.ts
   - experiments/dynamic-runtime/mcp-adapter.ts
   - observe/dynamic-module-manifest.test.ts
   - observe/dynamic-module-worker.test.ts
   - observe/dynamic-module-runtime.test.ts
   - observe/dynamic-module-artifact-registry.test.ts
   - observe/dynamic-module-rollout-journal.test.ts
   - observe/contract-runtime.test.ts
   - oracle/realsocket/contract-runtime.spec.ts
   - src/Common/rcp/rpc.harness.spec.ts when RPC/auth is in scope
5. Create doc/progress/dynamic-modules-implementation.md before broad changes. Keep it current and
   delete it after completion.
6. Inspect the worktree and preserve unrelated user changes. Do not commit, push, publish, or change
   package engine/public exports without explicit authorization.

Existing baseline: preserve, do not duplicate
---------------------------------------------
- Stages 1-5 have internal direct-import/reference implementations and focused tests.
- The worker accepts only verifier-owned artifacts and permission-free signed first-party Node
  factory bundles. It rejects browser runtime, unsupported Node ranges, ambient permissions,
  `cpuMs`, and out-of-range memory rather than silently promising enforcement.
- `DynamicModuleHost` serializes control commands, reuses ContractRuntime for atomic binding and
  lease/drain, scopes offers to one slot, validates required dependency bindings, and exposes a
  stable handle plus a dependency broker.
- The temporary MCP experiment pins the official SDK, is loopback-only, uses pre-parse Bearer,
  Host, and Origin checks, explicitly separates slotId from moduleId, and drives the real host/
  verifier/worker chain with its own official client.
- No dynamic runtime symbol is exported from package entrypoints.
- The external reference control plane publishes verified immutable artifacts with Git provenance,
  adapts the existing Artifact byte cache, persists desired state/receipts/audit/LKG through the
  existing ReplayStorage port, fences authority/generation at coordinator and node boundaries, and
  performs canary/batch rollout with post-activation probes and automatic rollback.

Approved scope for the next task
--------------------------------
[Choose and state: lifetime-owned MCP contribution gateway + dynamic catalog / state migration +
authoritative output gate / production registry adapter / database journal + distributed lease /
continuous monitoring + shadow / HTTP adapter / child process isolator / public API proposal only.]

For the first dynamic contribution slice, use the narrower ready prompt in
`doc/prompts/IMPLEMENT-MCP-CONTRIBUTION-GATEWAY.md` after the user explicitly authorizes that
implementation.

Unless separately approved, keep new implementation internal and demonstrate it through direct
source imports/tests. Before any public export, present the exact inferred declaration diff and ask
for an explicit API decision.

Architecture
------------
Build closure factories with one deps object and derived ReturnType aliases.

1. Manifest/descriptor gate
   - Parse bounded inert data.
   - Validate protocol, ids, entrypoint, compatibility, dependency ranges, capabilities,
     permissions, integrity/signature metadata, migration hooks, health, and budgets.
   - Do not invoke import(), a hook, migration, or user callback before manifest validation,
     byte-hash verification, publisher-key verification, and policy acceptance.
   - Use Artifact.sha256Hex. If adapting createArtifactByteCache, wrap it; do not silently overload
     ArtifactHost's browser-artifact meaning. Propose a generic extraction separately if needed.

2. In-memory verified registry and stable handle
   - Adapt each verified isolated module session to ContractOffer.
   - Reuse Contract.createContractOffers and Contract.createContractRuntime for resolution,
     prepare-before-switch, active pointer, leases, drain, revoke/restore, rollback, status,
     history, and explain.
   - A handle acquires exactly one binding generation for a call/stream and releases exactly once.
   - Optional dependencies return a typed unavailable/degraded result.

3. Candidate scope
   - Own fetched bytes, verification evidence, worker/session, warmup and health probes, shadow
     sinks, staged migration, timers, abort controllers, and subscription cleanup.
   - Dispose in reverse order on every failure.
   - Activation transfers only explicitly generation-owned session resources.
   - Only the active generation may publish to the authoritative event/Store Replay sink.

4. Isolation [when Stage 2 is approved]
   - First release: Node worker_threads for signed allowlisted first-party code.
   - Use a versioned message facade, handshake, heartbeat, AbortSignal/deadlines, payload and
     concurrency budgets, and a deterministic terminate path.
   - Never depend on dynamic-import cache busting as unload. No arbitrary module is considered
     unloaded until its worker/process is terminated.

5. State/migration [when Stage 3 is approved]
   - Durable business state is external/versioned.
   - Implement prepare/commit/abort with explicit reversibility and checkpoints.
   - Preserve a verified last-known-good coordinate.
   - Post-activation threshold failure quarantines the version and activates LKG as a new binding
     generation.

6. Facade sketch
   - control: stage, verify, activate, rollback, revoke
   - resource: resolve, fetch
   - events/on: lifecycle changes and failures
   - view: synchronous snapshot and explain
   - health: synchronous health snapshot
   Inputs go down through deps; facts go up through events. Do not name a generic api facet.

7. Git source adapter [when Stage 4 is approved]
   - Keep it in the external host.
   - It may scan/watch a local worktree, read a manifest/build input, and report revision facts.
   - It may not activate directly. Build/sign/publish returns through the artifact candidate gates.
   - Runtime rollback selects a previous verified artifact, never mutates the worktree with
     git checkout.

8. HTTP adapter [when approved]
   - Build one principal-specific safe domain control/view object.
   - Reuse createHttpFacadeServer from wenay-common2/server.
   - POST exposes mutation commands; a separate GET object exposes only view/health.
   - Apply authentication, per-method authorization, limits, rate limiting, network/CSRF policy,
     and correlation/audit context in Express middleware/application policy.
   - The helper is static request/response. Do not pass callbacks/Listens/binary downloads through
     it and do not pretend it provides SSE.
   - It may expose fixed read-only resource.guide() and resource.implementationPrompt() methods for
     agents that should not connect MCP. Never expose arbitrary filesystem reads.
   - Browser live confirmation remains RPC plus Store Replay.

9. MCP [the temporary experiment exists; production promotion still requires approval]
   - Do not implement the MCP protocol.
   - Reuse the official-SDK adapter under experiments/dynamic-runtime; do not rewrite the protocol.
   - Keep Authoring MCP separate from Runtime Control MCP.
   - Preserve an HTTP option for ChatGPT/scripts/operators where MCP setup or context cost is
     undesirable.
   - Do not change wenay-common2's Node >=20 engine floor without an explicit decision.

10. Dynamic MCP contributions [when explicitly approved]
   - A host/module/companion may return `mcp.create`; a candidate may also return
     `verification.create`. They return deliberate `control`, `resource`, `events`, `view`,
     optional `files`, `health`, and `close` facets; they never start or globally register an MCP
     server.
   - Build one host-owned gateway that composes `host`, `generation`, and `session` catalog leases,
     with attach/replace/detach/close commands, bounded invoke/read, outward catalog/session/failure
     events, synchronous view/health snapshots, desired host coordinates, TTL, namespaces, and
     deterministic cleanup.
   - Keep the gateway logically shared per host but create and inject it through `deps`; do not use
     a module-level singleton.
   - Keep handlers inside the worker. Cross the isolation seam with only inert signed descriptors
     and versioned invoke/cancel/close messages.
   - Project the gateway through the existing official-SDK experiment and preserve HTTP/in-process
     alternatives. MCP is a transport over the gateway, not a child of `resource` and not the data
     plane.
   - Keep mandatory probes in deterministic rollout policy. Prompt-based agent discovery and MCP
     exploration add evidence but cannot decide acceptance alone.
   - Use `doc/prompts/MCP-ARCHITECT.md` to make reuse/lifetime/catalog decisions explicit and inject
     a fresh scoped inventory into implementation subagents.

Correctness invariants
----------------------
- No unverified code execution.
- Failed candidate leaves active binding and authoritative output untouched.
- New calls observe exactly one old/new generation around activation.
- Old in-flight calls/streams finish or abort according to an explicit policy.
- One commandId produces at most one durable effect and one authoritative confirmation.
- Transport cursors use (lineId, epoch, seq), with missing-range tracking and durable checkpoint
  before compaction; do not use a bare wrapping 0..9999 counter as identity.
- packetId, commandId, correlationId, candidateId, module version/hash, and bindingGeneration remain
  distinct.
- State and subscriptions have explicit owners and cleanup.
- Rollback activates a verified immutable version; it does not mutate an artifact in place.
- Git is source/audit. Production consumes signed immutable registry artifacts.
- An MCP contribution is not callable before descriptor/integrity/policy validation and cannot
  outlive its declared host, generation, or session owner.
- Required probes run even when an agent ignores or fails to refresh the MCP catalog.

Minimum tests
-------------
Keep primitive/resource tests independent from layer tests.

- Manifest fuzz/table tests: malformed fields, oversized data, traversal entrypoint, undeclared
  capabilities, incompatible API/schema/state/runtime, invalid budgets.
- Prove loader callback count is zero for every pre-verification failure.
- Integrity/signature: corruption, wrong hash, wrong key, revoked key, canonicalization mismatch,
  concurrent same-hash fetch.
- Registry/handle: deterministic selection, concurrent activation/acquire, double release, failed
  open, revoke/restore, rollback, close races, forced drain.
- Candidate disposal: failure injection after every lifecycle step; every timer/listener/worker
  closes exactly once.
- Generation output gate: candidate/shadow facts never reach the authoritative sink; retired output
  is rejected; one command has one confirmation.
- Stream test: old stream stays on v1 while new stream uses v2.
- State test: migration prepare/abort/commit and crash at each boundary.
- Optional D: typed unavailable/degraded result, timeout, circuit open, recovery.
- Worker [Stage 2]: startup hang, runtime hang, crash, heartbeat loss, oversized message, memory/
  concurrency budget, terminate while calls are in flight.
- Persistence [Stage 3]: offline boot from verified LKG, corrupt LKG rejection, post-activation
  automatic rollback.
- HTTP: route allowlist, POST mutations only, GET reads only, auth before parsing, limits, error
  serialization, no callback/Listen route, principal-specific facade.
- MCP contributions: descriptor mismatch, cross-lifetime namespace collision, host restart from
  desired coordinates, generation alias swap with old-call drain, two candidate versions,
  attach/replace/detach/list/invoke races, worker crash, stale invocation rejection, catalog
  list-change, session TTL cleanup, and exact-once disposal.
- Race/failure matrix: activate vs revoke, activate vs rollback, two candidates, host close during
  fetch/open/health, late worker reply after abort.

Existing demonstrators to preserve
----------------------------------
- The compression B path proves stable handles, B -> C, optional B -> D degradation/recovery,
  worker isolation, atomic replacement, in-flight v1 completion, and rollback.
- `fleet-self-client.ts` proves immutable publication, restart recovery, three-host v1 -> v2 prefix
  convergence, command/fence idempotency, post-activation failure, quarantine, and automatic
  rollback to v2.
- Extend these scenarios for the approved next boundary; do not replace them with a second runtime.

Verification and handoff
------------------------
1. Run each new primitive test independently, then wrapper/facade tests, then the composition test.
2. Run existing contract tests and relevant RPC/oracle suites.
3. If an exported type is explicitly approved, run npm run types:generate and inspect declaration
   changes for accidental exports or narrowing; run npm run build before any publish discussion.
4. Run git diff --check and inspect git status. Do not commit/push/publish.
5. Delete the progress file only after the work is complete.
6. Report changed files, exact commands/results, remaining risks, public API decisions still
   required, and any RPC-AUTH.md synchronization requirement.
```
