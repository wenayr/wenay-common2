# AI support: first product slice

The copyable `examples/ai-support` starts a browser support desk: pasted ticket → summary,
category and reply draft, with progress and cancellation. It never sends a reply. Default execution
is explicitly deterministic templates, not a connected model. No provider key or cost is required.

## Existing corridors

The runner owns provider work and abort; AiRunHost owns lifecycle, account policy and scoped retry
identity; AiRunClient owns replay into a stable Store. The product adds input validation, a local
identity adapter, gated RPC/HTTP and a small polling page. No new library facade was needed.

## Confirmed library defects fixed

- A synchronous exception from `runner.cancel` escaped `host.close`, interrupting shutdown.
  Isolate it without delaying the immediate provider abort attempt. Pending approval/input waits
  reject and event lines close even if every provider cancellation throws.
- `account + NUL + requestId` could collide for distinct accounts and return another account's run.
  Reuse `Command.commandReceiptKey` tuple encoding. Normal same-account retries retain their run.

Both regressions failed before the fix and pass afterward in `replay/ai-run-lifecycle.test.ts`.
Generated AI host declaration hash stayed unchanged: public signatures were preserved.

## Evidence

- Source and installed consumer: real Socket.IO/RPC progress, cancellation with no late result,
  provider failure visible in state, fresh task succeeding afterward, two-account isolation,
  repeated request IDs, anonymous rejection and wrong-account HTTP rejection.
- Original client Store catches up after disconnect/reconnect while the host remains alive.
- Browser smoke: page loads, task progresses and renders a completed summary/category/draft.
- Full build, `npm test`, 169/169 oracles and all seven installed examples pass strict typecheck/check.

## Boundaries exposed

This is a single in-memory host. Restart recovery and distributed task ownership are not provided
by the existing AI host dependency ports. Adding workers independently would split task state and
retry history. A durable scheduling/ownership seam needs a separate public API discussion.

The account selector is local demonstration identity. A real model adapter, credential loading,
production authentication, quotas and retention are still application/deployment work. The runner
port already accepts a real provider, so an SDK-specific public library API is not justified here.
No throughput or model-answer quality claim follows from these tests.

Next product wave: apartment lock disconnects, expiry and ambiguous acknowledgements.
