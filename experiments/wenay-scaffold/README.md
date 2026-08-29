# wenay-scaffold — project template (incubating skeleton)

Future separate npm package (working name `wenay-scaffold`), stage 6 / step 7a of
[`doc/target/SCALE-DEPLOY-PLAN.md`](../../doc/target/SCALE-DEPLOY-PLAN.md), incubated here the same
way `experiments/wenay-k8s` incubates its host package: dev-only, unexported, no new dependencies,
proven by its own self-check.

The promise: **a new service = the author edits ONE domain module.** Everything below the domain —
replication, node directory, command receipts, the end-to-end token corridor, revocation, drain —
arrives already wired from the library.

## The seam: what the author owns vs what the template owns

| File | Owner | Contents |
| --- | --- | --- |
| `template/service.ts` | **the author — the ONLY file to edit** | `serviceDefinition`: wire `name`, `storeId`/`originId`, typed `initial` store state, `commands` (`validate(input)` throwing on bad input, `apply(ctx, input)` mutating `ctx.state` and returning the receipt), `readerFacet(state)` read projection |
| `template/leader.ts` | template | `createServiceLeader(deps)` — a thin mapping of the definition onto the public `Scale.createAuthority` (plan step 8c); also exports the definition contract (`tServiceDefinition`, validated by `satisfies`) |
| `template/node.ts` | template | `createServiceNode(deps)` around the public `Observe.createStoreNode`, plus the node PROCESS entrypoint (env → transports → factory → signals) |
| `template/config.ts` | template | env parsing helpers (`SERVICE_NODE_ID`, `SERVICE_UPSTREAM`, `SERVICE_NODE_TOKEN`, `SERVICE_TOKEN_SECRET`, `SERVICE_PORT`) |
| `template/package.json`, `template/tsconfig.json` | template | minimal project files, dependency on `wenay-common2` |

`service.ts` sees no sockets, no env, no crypto, no process: a command receives
`ctx = {account, requestId, command, state}` — the verified account, the idempotency identity, and
the authoritative store — and nothing else.

## Layer map

```text
domain module   template/service.ts       the definition: state shape, commands, read policy
leader host     template/leader.ts        Scale.createAuthority driven by the definition (replica
                                          line, directory, command receipts, end-to-end token
                                          verification, replicated deny list, node link, gated
                                          connections) + createTokenCodec as the identity adapter
                                          (crypto stays host-side) + the readerFacet projection
node host       template/node.ts          Observe.createStoreNode parameterized by the definition
                                          (replica line, local token gate, forward-by-token, own-row leave)
transports      entrypoints only          express + Socket.IO servers, the upstream hub, env, exit
```

The step-8c payoff, measured: `leader.ts` dropped from 359 hand-wired lines to 191, and what
remains is the definition contract plus a thin mapping — serviceDefinition + secrets →
`Scale.createAuthority` deps. The authority facets are retransmitted whole (`line`, `directory`,
`identity`, `corridor`), so consumers address the write corridor honestly through
`leader.corridor.byToken()` instead of reaching through `nodeLinkFragment().commandsByToken`.

Trust layers are the proven mini-scale ones: identity mints real codec tokens (ungated), every node
verifies client tokens LOCALLY (shared secret), the leader re-verifies EVERY forwarded command
(end-to-end mode — a relay asserts nothing), and revocation is a replicated deny-list fact each node
cuts its own sessions on.

## Ownership rule (doc/DYNAMIC-RUNTIME.md)

**Env, transports, token cryptography, and process exit live in entrypoints — never in the domain
module.** Concretely:

- `node.ts`'s `main()` parses env, owns the http/Socket.IO servers and the upstream hub, builds the
  token codec from the env secret (the factories receive a *verifier*, never a secret format), and
  owns `process.exit` after the drain grace.
- `createServiceLeader` performs no env reads and no process control; corridor secrets arrive (or
  default per-run) as plain strings and are returned via `secrets` so the leader ENTRYPOINT can hand
  them to node processes through env.
- Spawning/supervising node processes is entrypoint/orchestrator work (Kubernetes per
  `experiments/wenay-k8s`), not factory work — the leader factory only exposes `control.drain`,
  and drain stays DATA: the node leaves on its own directory row.

## Wire shape

Every surface is served wrapped under `{[definition.name]: fragment}` so a client cannot tell the
leader from a node. The node factory wraps by itself (it owns serving through `deps.serve`); the
leader's `serve.*` fragments are bodies, and the entrypoint that binds them to socket keys applies
the same wrap. Socket keys mirror the stand: ungated read (`app`), gated write (`scale`), and the
node link (`node-link`, served only to connections that presented the node token).

## How to instantiate

```powershell
node experiments/wenay-scaffold/create.mjs my-service C:\path\to\my-service
```

Plain node, no dependencies: copies `template/*` substituting `{{name}}`. Then edit `service.ts` —
and only it.

Incubator note: while the template lives inside this repo, its `.ts` files import from
`'../../../src/...'`; each import block carries a `TODO(graduation)` marker. The graduated package
imports from `'wenay-common2'` / `'wenay-common2/server/auth'` instead (already declared in the
template `package.json`).

## Self-check (the boot proof)

```powershell
node node_modules/tsx/dist/cli.mjs experiments/wenay-scaffold/self-check.ts
```

Imports the template modules directly (no child processes) and wires them with the in-process
loopback pattern of `observe/store-node.test.ts` — client legs over REAL RPC. 19 numbered checks,
ALL GREEN: node registration, token mint/verify, the full command corridor (client → node gate →
forward-by-token → leader verification → store), duplicate receipts shared across hops, validation
committing nothing, replication through the node to a follower with a deep-equal snapshot, the
readerFacet projection, revocation by replicated fact, clean drain departure, and `create.mjs`
substitution.

## examples/rental — the step 7c example stand

A whole service assembled FROM this scaffold: `examples/rental/service.ts` is the one authored
domain module (items + bookings, an overlap rule over half-open ISO-day spans, owner-only cancel,
a public board that hides WHO booked); everything a leader or node DOES still comes from
`template/` unchanged. The REST surface (`examples/rental/rest.ts`) mounts the step 7b pieces
(`createHttpFacadeServer` + the demo OpenAPI generator) over the RUNNING service: the write routes
are the authority corridor's `byToken()` fragment served verbatim (`leader.corridor.byToken()` —
the same fragment the node link forwards into), and a middleware turns
`Authorization: Bearer <token>` into the corridor's leading token argument — so the account always
comes from the verified token, never from a REST parameter, and REST is just one more relay of the
same end-to-end corridor the socket nodes forward into.

Run the live stand — one leader plus 2 real node processes, Ctrl+C stops everything:

```powershell
node experiments/wenay-scaffold/examples/rental/run.mjs
```

It prints the URLs and a 12-hour demo bearer (port via `RENTAL_PORT`, default 3400):

- `http://localhost:3400/board` — a self-refreshing page that polls the SAME documented REST route
  (`GET /api/rental/board`) every second: zero new wire;
- `http://localhost:3400/docs` — Swagger UI (paste the printed bearer into Authorize);
- `http://localhost:3400/openapi.json` — the merged spec: public board, bearer-gated writes.

Book with the printed bearer (the leader also prints this exact line ready to paste):

```bash
curl -X POST http://localhost:3400/api/rental/book -H "Authorization: Bearer <printed bearer>" -H "Content-Type: application/json" -d "{\"args\":[\"r-demo-1\",{\"itemId\":\"kayak\",\"from\":\"2026-09-01\",\"to\":\"2026-09-03\"}]}"
```

`args` is `[requestId, input]`. Repeating the same requestId answers the same receipt (safe retry —
even when the first attempt went through a node that has since drained), an overlapping booking is
refused with nothing committed, and every booking shows up on the board through the replica line.
The example's own oracle proves that whole list over REAL HTTP plus an in-process node — 16 numbered
checks, ALL GREEN:

```powershell
node node_modules/tsx/dist/cli.mjs experiments/wenay-scaffold/examples/rental/self-check.ts
```

## Deferred (deliberately not in the skeleton)

- A template-owned leader PROCESS entrypoint and the browser stand — `examples/rental` ships
  example-owned ones (`leader-rental.ts`, the `/board` page); lifting them into `template/` is a
  graduation-time decision.
- REST/OpenAPI over `createHttpFacadeServer` as a template option — `examples/rental/rest.ts`
  shows the assembly (the step 7b pieces over the corridor).
- Durable journal + keyframe backups wiring (`createDurableStoreReplay` + fs adapters) as a template
  option.
- Read-policy enforcement on the replicated line itself: `readerFacet` is currently a projection
  served on the read surfaces, while the line replicates full state; wire-level visibility filtering
  is a library discussion, not template glue.
- K8s charts/probes/lifecycle — composed from `experiments/wenay-k8s` when both graduate.

## Graduation plan

When the stage-3/4 surface settles, this directory lifts into its own package `wenay-scaffold` with
`wenay-common2` as a normal dependency: imports flip to the package entrypoints, `create.mjs`
becomes the package bin, and the self-check becomes the package oracle. The 7c rental example is
assembled FROM the scaffold inside this incubator first (done: `examples/rental`).
