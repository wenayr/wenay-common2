# AI Run Protocol

This is the product-level AI contract for `wenay-common2`. It is built on existing RPC, Store and
Replay primitives; it does not introduce a model-specific socket or a second transport.

## Purpose

An AI interaction is not merely a long RPC response. It can stream text, generate artifacts, wait for
human consent, request further input, be cancelled, survive a client reconnection, and must not repeat
provider-side effects accidentally. `Ai.createAiRunHost` supplies those lifecycle guarantees while an
application supplies the model provider, tools, storage and product policy.

```
browser ── RPC command ──> AiRunHost ── injected port ──> model / tools / queue
   │                             │
   │<── Store replay (state) ────┤
   └<── Replay (semantic events) ┘
                │
                └── Resource ids refer to application-owned byte storage
```

## Transport surfaces

The server creates one account-scoped fragment and spreads it beside legacy RPC keys:

```ts
const host = Ai.createAiRunHost({runner, capabilities})
io.on('connection', socket => {
    const ai = host.connection(accountOf(socket))
    createRpcServerAuto({object: {...legacyObject, ai: ai.fragment}, ...})
    disconnectListen.on(ai.close)
})
```

| Surface | Purpose |
| --- | --- |
| `capabilities()` | Static product-facing kinds/input hints, such as `assistant` or `transcribe`. |
| `state` | Account-filtered Store patch replay with `runs`, `approvals`, `inputs`. |
| `events` | Account-filtered semantic Replay: deltas, tool notices, lifecycle edges and a sync keyframe. |
| `createRun(request)` | Starts or returns an idempotent run. |
| `cancelRun(runId, reason?)` | Makes state terminal, cancels waits and asks the provider adapter to abort. |
| `resolveApproval(approvalId, decision)` | Supplies an authorized human decision. |
| `provideInput(inputId, value)` | Supplies a requested value without persisting that value in shared state. |

The client mirrors both replay surfaces:

```ts
const ai = Ai.createAiRunClient({remote: clients.app.func.ai})
ai.events.on(event => renderEvent(event))
await ai.ready

const run = await ai.createRun({
    requestId: crypto.randomUUID(),
    kind: 'assistant',
    input: {prompt},
    resourceIds: [fileId],
})
```

Attach an `events` listener before `ready` when the initial `sync` event itself matters. `store.state`
is the durable read model and is correct after `ready` regardless of whether a caller renders events.

## Run semantics

`requestId` is required and scoped to the owner. Repeating `createRun` with the same key returns the
original run, even after a new socket connection. Normal RPC calls reject on a disconnect and are never
blindly reissued, because a retry could charge a model or run a tool twice. The product decides to retry;
the host makes that retry safe.

State transitions are:

```
queued → running → completed
                 ↘ failed
                 ↘ cancelled
running ↔ waiting_approval
running ↔ waiting_input
```

`completed`, `failed` and `cancelled` are terminal. Cancellation wins over late provider activity:
after `cancelRun`, the host drops every later `report`, semantic event and final output, even if a
provider cannot stop immediately.

The final result and artifact descriptors belong in `AiRun` so an initial state replay can rebuild the
finished UI. `text.delta` is a live enhancement, not the only copy of a user-visible answer. Keep
large output in storage and return a `resourceId`/small descriptor instead.

## Runner port

The runner is an injected server-side adapter. It receives an immutable run descriptor, opaque input,
opaque resource ids and these controls:

- `report({progress?, message?, usage?})` updates durable state and emits a progress event.
- `emit(...)` sends `text.delta`, `notice`, `tool.call` or `tool.result` to authorized viewers.
- `artifact(...)` records a small descriptor and emits it.
- `requestApproval(...)` changes the run to `waiting_approval` and resolves only when the authorized
  RPC caller chooses `approved` or `rejected`.
- `waitForInput(...)` changes the run to `waiting_input` and resolves with a later supplied value.
- `cancelled()` is a cheap cooperative check. `runner.cancel?` is the optional actual provider abort.

The adapter owns model APIs, prompt construction, tool implementations, provider retries, billing,
durable queue/persistence and retrieval of bytes behind a `resourceId`. A crash-safe distributed queue
can sit behind exactly the same runner port; that operational choice is intentionally not imposed by
the common library.

## Security and privacy rules

- The authoritative host Store is never exposed. Each `connection(account)` has its own policy-filtered
  Store and event lines. Defaults are owner-only; `AiRunPolicy` extends create/read/write checks.
- Raw `input` and the raw value passed to `provideInput` are never placed in Store. Only input-request
  metadata is shared with authorized viewers.
- File bytes, storage keys, presigned URLs, model credentials, traces and raw chain-of-thought do not
  enter RPC/Store/events. A tool resolves a resource id on the server through its own policy-bound
  storage adapter.
- Tools execute server-side. Browser code never supplies an arbitrary callback for the runner to invoke.
  A tool needing human consent pauses with `requestApproval`; the server validates `resolveApproval`.
- `capabilities` describe product-supported operations, not provider credentials or unconstrained model
  access. Apply quotas/concurrency/tenant policy in `canCreate` or the runner's queue.

## Media and long-running work

For a file task, pass a confirmed `Resource` id into `createRun`. For audio/video, the existing `Media`
binary Listen remains the ingress: an application backend segments or transcribes it, then writes AI
state/events through this run protocol. Native WebRTC tracks/SFU are optional latency optimizations for
human duplex communication, not a prerequisite for AI work over the socket layer.

## Verification

`replay/ai-run.test.ts` is the real Socket.IO/RPC oracle. It covers capability discovery, unchanged
legacy RPC, owner ACL, idempotent retry after a new connection, approval/input waits, semantic events,
provider cancellation and rejection of late output. `demo/` exposes the same run client and a
deterministic provider adapter; run it with `npm run demo`.
