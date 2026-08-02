# Prompt: complete lifetime-owned dynamic MCP contributions

Use this prompt only after the user explicitly authorizes implementation. It remains intentionally
internal-first and does not authorize a public export, publish, commit, push, production bind, or
RPC authorization change.

```text
Repository: wenay-common2

Goal
----
Extend the existing internal `context.mcp` + `McpContributionGateway` vertical slice described by
doc/DYNAMIC-RUNTIME.md. Complete verified host, active-module, and verification-session ownership;
signed declaration matching; activation-coupled alias replacement; session TTL; desired-state
recovery; and stateful official-SDK catalog-change delivery.

Do not reimplement the working primitive. It already proves exact host policy, registration
receipts/statistics, isolated invocation, runtime add/remove, catalog relist, and lease-safe detach.

Prove both a long-lived D MCP contribution and a temporary D verification contribution while A
continues calling B through its stable handle. Do not route normal module calls through MCP and do
not change package exports.

Non-goals
---------
- No production MCP/OAuth deployment, remote bind, public TypeScript API, package-engine change, or
  generic reimplementation of the MCP protocol.
- No reflection that automatically exports every module method, nested closure, or class.
- No candidate tool may publish authoritative application output or mutate production state by
  default.
- No Git checkout/pull on the runtime path. Use verified immutable artifact bytes.
- No claim that worker_threads contains hostile code. Keep the signed allowlisted first-party rule.
- No MCP server per module. One gateway composes host, active-generation, and session catalog
  leases.

Before editing
--------------
1. Read AGENTS.md completely.
2. Read completely:
   - doc/DYNAMIC-RUNTIME.md
   - doc/DYNAMIC-RUNTIME-IMPLEMENTATION.md
   - doc/prompts/MCP-ARCHITECT.md
   - doc/CONTRACT-RUNTIME.md
   - doc/ARTIFACT-RUNTIME.md
   - doc/RPC-AUTH.md only if RPC authorization becomes part of the chosen implementation
   - experiments/dynamic-runtime/README.md
3. Start from generated declarations:
   - lib/index.d.ts
   - lib/server.d.ts
   - lib/Common/contract/contract-runtime.d.ts
   - lib/Common/artifact/artifact-hash.d.ts
   Confirm that no dynamic runtime symbol is publicly exported.
4. Confirm actual behavior in:
   - src/Common/dynamic/module-manifest.ts
   - src/Common/dynamic/module-verifier.ts
   - src/server/dynamic/module-isolation.ts
   - src/server/dynamic/module-worker.ts
   - src/server/dynamic/module-worker-bootstrap.ts
   - src/server/dynamic/module-worker-isolation.ts
   - src/server/dynamic/module-host.ts
   - experiments/dynamic-runtime/module-control.ts
   - experiments/dynamic-runtime/mcp-adapter.ts
   - experiments/dynamic-runtime/mcp-contribution-gateway.ts
   - experiments/dynamic-runtime/contribution-self-client.ts
   - experiments/dynamic-runtime/runtime-self-client.ts
   - observe/dynamic-module-manifest.test.ts
   - observe/dynamic-module-worker.test.ts
   - observe/dynamic-module-mcp-registrar.test.ts
   - observe/dynamic-module-runtime.test.ts
   - observe/dynamic-module-host-races.test.ts
5. Inspect git status and preserve every unrelated/user change. Create
   doc/progress/transient-verification-mcp-implementation.md before broad edits and delete it only
   after completion.

Architecture decision to implement
----------------------------------
There are three boundaries, not one global object:

1. Scoped contribution authoring layer
   - The isolation owner injects `context.mcp` into the root module/pack factory.
   - A producer imperatively registers descriptors and local handlers, but registration is scoped,
     policy-checked, receipted, observable, and disposable. Nested factories capture the registrar.
   - The runtime factory does not have to return MCP. Never replace this with a static/process-global
     registry, and never start an MCP server inside a module.

2. McpContributionGateway
   - One instance is created by the host and passed through deps.
   - It composes host, active-generation, and session catalog layers. It owns immutable
     contribution coordinates, logical aliases, catalog generations/leases, principal scope,
     desired host state, attach/replace/detach, invoke/read routing, session TTL, events,
     view/health snapshots, and exact-once cleanup.
   - It is transport-neutral. MCP, HTTP, and in-process tests are adapters over it.

3. Official-SDK MCP adapter
   - Extend/wrap experiments/dynamic-runtime/mcp-adapter.ts. Do not implement protocol framing.
   - Keep fixed authoring/runtime-control tools separate from transient candidate tools.
   - Map gateway catalog changes to official tool/resource list-change notifications where the
     pinned SDK/client supports them. If it does not, document and test explicit relist behavior.

Required facades
----------------
Use closure factories with one deps object and derive exported/internal implementation types with
ReturnType<typeof createX>. Do not use classes as service containers and do not create handwritten
parallel interfaces for concrete factories.

Specialized verification/session layers may return deliberate facades when those boundaries exist:

- control: runRequiredProbes, abort
- resource: invokeProbe and bounded fixture/raw IO operations
- events: outward progress/failure facts
- view: synchronous catalog/report snapshots
- files: bounded snapshot/capture reads only when that boundary really exists
- health: synchronous health snapshot
- close: idempotent, awaitable cleanup

The gateway should conceptually return:

- control: attachHost, replaceGeneration, openSession, attach, detach, closeSession
- resource: bounded invoke/read using session + contribution + method coordinates
- events: catalogChanged, sessionChanged, failed
- view: synchronous catalog(session/principal) and session snapshots
- health: synchronous health snapshot
- close: closes all sessions and transport-independent resources

Do not place MCP at resource.mcp. resource is raw domain IO; MCP projects several facets and is an
external adapter boundary.

The module authoring primitive remains `context.mcp.contribution(...).tool(...)`. Its registration
receipt keeps `control.remove` and `view.snapshot`; contribution/root registrar facts remain on
`events.on` and `view.snapshot`. Extend this surface only when a real boundary requires it.

Manifest and trust gate
-----------------------
Do not silently add optional fields to ModuleManifest protocol 1. First implement a separate,
versioned, bounded inert VerificationPackManifest or present an explicit protocol-version decision.
The internal-first preferred manifest binds:

- contributionId and immutable contribution version/content hash;
- lifetime owner: host, generation, or session;
- target moduleId plus allowed target runtime content hash/API range when applicable;
- entrypoint and integrity/signature metadata;
- exact tool/resource/prompt ids and input/output schema hashes;
- declared capabilities/permissions and side-effect class for every operation;
- call/input/output/concurrency budgets, replacement policy, and session TTL/end condition;
- required probe ids and evidence report schema version.

Reuse Artifact.sha256Hex and the existing signature-verifier dependency shape. Parse and validate
the manifest, verify owned bytes, publisher, signature, capabilities, target binding, and budgets
before creating a worker or invoking a pack factory. Compare the worker's actual cloneable
descriptors to the signed declaration before gateway attach. A mismatch rejects the session and
publishes no catalog entry.

Worker seam
-----------
The current private `wenay-common2/module-worker@2` protocol already carries flat runtime methods,
MCP registration facts, publication acknowledgements, and contributed calls. Extend it deliberately
or create a separate verification-pack worker adapter; do not smuggle functions in messages.

- The factory and handlers stay inside the worker.
- The ready/describe message contains only structured-cloneable descriptors and immutable identity.
- Version any further private wire change; do not reinterpret `module-worker@2` messages
  ambiguously.
- Parent invocation uses sessionId, contributionId, methodId, correlationId, candidate identity,
  generation/target hash, deadline, and input.
- Support invoke, cancel, close, fatal, heartbeat, and bounded result/error messages.
- A timeout or abort follows the declared policy. If arbitrary code may remain unsafe, terminate the
  whole verification worker instead of pretending one handler was cleanly unloaded.
- Late replies after detach/abort are ignored and cannot recreate catalog state.

Lifetime lifecycle and cleanup
------------------------------
Implement all three owner paths:

- host: desired coordinate -> verified/opened -> attached -> audited replacement/revoke -> closed;
- generation: candidate private -> verified/described -> activation alias swap -> lease drain ->
  retired/closed;
- session: private -> verified/described -> attached -> probes/evidence -> verdict/TTL -> detached/
  closed.

Every failure path must close in reverse ownership order. Close/detach is idempotent and awaitable.
Candidate rejection, TTL, generation retirement, host desired-state replacement, worker failure,
host close, explicit cancellation, or end of a bounded canary window must remove/replace catalog
entries atomically, abort/settle calls once, and close mocks, fixtures, file handles, events, timers,
and worker resources exactly once after their leases drain or abort.

Persist host contributions only as verified immutable desired coordinates and configuration
versions. Re-verify/re-instantiate them after restart. Never serialize closures, workers, listeners,
or live tool instances.

A normal MCP client disconnect does not itself decide whether a rollout command is cancelled. The
VerificationSession policy owns that decision. Make it explicit and test it.

Agent and rollout integration
-----------------------------
- Use doc/prompts/MCP-ARCHITECT.md to produce a reviewable McpContributionPlan before implementing
  selected module changes.
- Add a host-owned read-mostly architecture contribution that exposes the scoped catalog
  snapshot/diff, canonical guide, architect prompt, and pure explain/validate-plan operations. It
  must not expose signing, loading, activation, arbitrary filesystem access, or catalog mutation.
- Expose a scoped catalog snapshot for agent/subagent context injection.
- Keep inventory by immutable contribution identity/version/session, not remembered tool names.
- Emit catalogChanged on attach/detach and prove the official client can observe or explicitly
  refresh it.
- Prompts may remind an architect agent to inspect and recommend relevant tools, but mandatory
  probes are called by deterministic rollout policy. An agent ignoring MCP must not allow a broken
  candidate to activate.
- Persist structured evidence/report/audit facts; do not persist live handlers or catalog leases.

A -> B -> C and D demonstrator
------------------------------
Add an internal end-to-end demonstrator without replacing the existing ones:

1. Keep A on a stable handle to B v1.
2. Stage D and B v2; B v2 keeps B's input contract and uses C plus optional D.
3. Open one private verification session, attach namespaced B/D contributions, and run mandatory
   probes with candidate deps/mocks. Prove no candidate fact reaches the authoritative sink.
4. Activate in dependency-safe order after the verdict. Prove an old B v1 call completes while new
   calls observe only the new generation.
5. Inject a probe/health failure and prove no activation or a rollback to verified LKG according to
   the chosen point of failure.
6. Publish a new D.verify companion bound to the active D runtime hash. Attach and remove its
   temporary tools without rebuilding or replacing A, B, or D runtime code.
7. After detach, discovery omits the tools and a stale direct coordinate returns typed unavailable;
   it never invokes the old worker.
8. Publish `D.mcp` as a generation contribution and prove its stable logical alias swaps atomically
   with D while an old MCP call drains on the prior lease.
9. Add one host contribution, persist only its desired immutable coordinate, restart the gateway,
   and prove it is re-verified/re-instantiated without restoring a live object.

Suggested internal files
------------------------
Prefer these corridors unless repository inspection finds a closer existing primitive:

- src/Common/dynamic/verification-pack-manifest.ts
  Pure bounded inert parsing/canonicalization and descriptor comparison.
- src/server/dynamic/verification-isolation.ts
  Host-neutral verified pack/session port.
- src/server/dynamic/verification-worker*.ts
  Separate worker adapter/bootstrap, or a clearly versioned extension of the existing module worker.
- experiments/dynamic-runtime/mcp-contribution-gateway.ts
  Extend the existing host-owned source catalog/lease gateway with lifetime layers and aliases.
- experiments/dynamic-runtime/mcp-adapter.ts
  Thin dynamic catalog projection through the official SDK.
- experiments/dynamic-runtime/contribution-self-client.ts
  Preserve the existing official-client add/call/remove/relist proof.
- experiments/dynamic-runtime/verification-self-client.ts
  Add the lifetime/verification end-to-end proof.
- observe/dynamic-module-verification*.test.ts
  Primitive, gateway, race, and integration tests.

Keep source files unexported. If a nearly matching primitive already exists, wrap it and adjust the
file plan instead of duplicating it.

Independent verification
------------------------
Run the narrowest primitive/resource tests first, then wrapper/facade tests, then composition:

- Manifest tables/fuzz: malformed/oversized/unknown fields, traversal, wrong target hash, schema
  mismatch, undeclared capability, invalid TTL/budget, corrupt bytes/signature, loader count zero.
- Descriptor match: missing/extra tool, changed schema hash, side-effect mismatch, duplicate ids.
- Gateway: host/generation/session namespace composition, two candidate versions, attach/replace/
  detach/list/invoke races, stale coordinate, TTL, close during attach, exact-once disposal,
  catalog snapshot immutability, restart from desired coordinates, and old-call lease drain.
- Worker: startup hang, invocation hang/crash, heartbeat loss, payload limits, abort, late reply,
  termination with calls in flight, no serialized functions.
- MCP: auth before parse, foreign Origin, dynamic list/relist, invoke/read, detach removal, official
  client behavior, fixed control tools still working.
- Rollout: mandatory probes run without agent cooperation, failed probe blocks activation, candidate
  output is non-authoritative, old/new generation lease behavior, D.verify without runtime swap.
- Full relevant existing dynamic runtime, Contract runtime, TypeScript, and MCP self-client suites.

Then run git diff --check and inspect git status. Run types:generate only if the user separately
approved an exported type; otherwise generated declarations must remain unchanged. Do not commit,
push, publish, or change the Node engine. Update doc/DYNAMIC-RUNTIME.md and
doc/DYNAMIC-RUNTIME-IMPLEMENTATION.md to match actual behavior, note whether RPC-AUTH.md required
synchronization, remove the progress file, and report exact results and remaining production risks.
```
