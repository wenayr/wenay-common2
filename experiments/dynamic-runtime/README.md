# Dynamic runtime MCP experiment

This dev-only experiment proves a thin official-SDK MCP adapter over an injected
`ModuleControlPort`. It does not implement the MCP protocol, change package exports, or replace
Contract runtime. Four self-clients exist: one uses a deterministic fake control service; one
drives the real verifier, dynamic host, Contract runtime, and worker isolation through MCP; one
proves scoped dynamic worker contributions through the official client; and one drives an external
registry/journal/canary control plane across three real worker hosts.

The adapter always exposes five fixed runtime-control tools and can additionally project the
current snapshot from `createMcpContributionGateway`. A module registers through its injected
`context.mcp`; it does not return an MCP facade and no static global registry is used. The first
slice supports exact host policy, receipts/statistics, runtime add/remove, isolated invocation, and
lease-safe detach. It does not yet implement signed contribution manifest fields, durable host
desired state, session TTL, activation-coupled generation alias swap, or principal-specific
catalogs. Those extensions remain designed in `doc/DYNAMIC-RUNTIME.md` and
`doc/prompts/IMPLEMENT-MCP-CONTRIBUTION-GATEWAY.md`.

It uses the stable official SDK:

```powershell
npm install --save-dev --save-exact @modelcontextprotocol/sdk@1.30.0 zod@4.4.3
```

Run this experiment on Node 20 or newer. Although the SDK root declares Node `>=18`, its currently
resolved secure `@hono/node-server@2.0.12` dependency declares Node `>=20`. This matches the
library package engine `>=20`; the experiment remains dev-only and unexported.

Run the type check and the self-client from the repository root:

```powershell
npx tsc -p experiments/dynamic-runtime/tsconfig.json
npx tsx experiments/dynamic-runtime/self-client.ts
npx tsx experiments/dynamic-runtime/runtime-self-client.ts
npx tsx experiments/dynamic-runtime/contribution-self-client.ts
npx tsx experiments/dynamic-runtime/fleet-self-client.ts
```

The contribution self-client starts a worker whose runtime factory calls
`context.mcp.contribution(...).tool(...)`, attaches the source to the gateway, and uses the official
MCP client to list and invoke it. It then registers a second tool after readiness, removes the
first, and detaches the source; successive `tools/list` calls observe counts `6 -> 7 -> 6 -> 5`.
The HTTP harness constructs a stateless server per request, so this proves explicit relist behavior,
not an unsolicited `notifications/tools/list_changed` notification.

The first self-client starts a server on an ephemeral `127.0.0.1` port, proves missing Bearer
credentials return `401`, proves a foreign browser Origin returns `403`, connects through the
official Streamable HTTP client, lists and calls all tools, lists and reads both fixed resources,
activates compression v2, and rolls back to v1.

The real-host self-client uses distinct `slotId='compression.primary'` and
`moduleId='compression.impl'`, shares concurrent stage retries by command id, rejects a conflicting
reuse of that id, activates a real worker, calls it through a stable leased handle, and rolls back
to a fresh worker generation.

Accepted control commands outlive one HTTP response; a disconnect does not cancel or compensate an
activation. `rollout-journal.ts` demonstrates persistence with the existing ReplayStorage port and
`openFsReplayStorage`; a production deployment should replace the file reference adapter with its
database/consensus boundary.

The fleet self-client publishes v1/v2/v3 from immutable Git provenance, folds concurrent artifact
fetches through the existing verified cache, installs v1 on three nodes, persists a v2 command,
reopens the journal, reconciles v2 everywhere, and proves an old in-flight v1 call still completes.
It then injects a post-activation v3 failure on the second node and proves the switched nodes roll
back to v2 while the artifact is quarantined. Run it directly or with:

```powershell
npm run experiment:dynamic-runtime:fleet
```

Set `MCP_URL` to exercise an already running compatible endpoint and set `MCP_BEARER_TOKEN` to
override the development token. The shared token and lack of OAuth discovery make this harness
unsuitable for production or a non-loopback bind.
