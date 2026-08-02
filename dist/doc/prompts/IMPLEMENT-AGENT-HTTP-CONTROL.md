# Agent HTTP control surface ("MCP-lite")

You are implementing an agent-facing control surface for a running application. The goal: an AI
agent (or a script, or an operator) can read live status, call domain operations, and drive
development hot-reload of module code over plain HTTP — without restarting the process and without
any MCP SDK. MCP stays what `doc/DYNAMIC-RUNTIME.md` says it is: an optional adapter over the same
domain facade, never a second implementation. If a standardized MCP catalog is later needed, project
the same object; nothing below changes.

A runnable, self-verifying reference of everything in this instruction:
`experiments/dynamic-runtime/agent-control-self-client.ts` (`npm run experiment:agent-control`).

## When to use this

- A development loop where an agent edits module source and needs the running host to pick it up.
- Agent- or operator-driven status reads, diagnostics, and bounded control commands.
- Any consumer that understands "HTTP + JSON + an instruction document" — which every agent does.

Not for: high-rate event streams (use RPC + Store Replay), file transfer, or a public production
API. This is a control plane; keep it off the hot data path.

## Pick the surface before you build it

Two different things get called "agent tools" and they have opposite requirements. Decide which one
you need first; building the wrong one is the common mistake.

| | Dev method bridge | Published surface |
|---|---|---|
| Question it answers | "I'm editing this code right now, let me poke it" | "Other people's agents will call this for months" |
| What defines it | the module's own methods | an explicit, reviewed declaration |
| Cost to add a method | save the file | write a descriptor, get it approved, publish it |
| Lifetime | this dev session | versioned, long-lived |
| Section below | 1 (dev bridge) | 2-6 plus the runtime-registrar section |

Default to the dev bridge. Reach for a declared surface only when the surface is genuinely
published — when someone other than the person editing the code depends on its shape.

## 1. The dev method bridge — the fast path

The module's methods **are** the surface. Nothing declares them, nothing describes them, nothing
publishes them. Two dynamic routes are the whole mechanism:

```ts
// what the running module has right now, straight from the isolated session
app.get(base + '/methods', authorize, (_req, res) =>
    res.json({ok: true, value: liveMethods()}))

// call one by name; the body is the method's single input
app.post(base + '/call/:method', authorize, express.json({strict: false}),
    async (req, res) => {
        if (!liveMethods().includes(req.params.method)) return res.status(404).json(...)
        res.json({ok: true, value: await handle.call(req.params.method, req.body ?? null)})
    })
```

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/agent/methods"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"probe":1}' "http://127.0.0.1:$PORT/agent/call/stats"
```

Notes that matter:

- `liveMethods()` asks the running worker; the isolated session already reports its own method
  names, so a method added in the editor appears the moment the file is saved and the swap lands.
- These are **dynamic** routes, deliberately outside `createHttpFacadeServer` — that helper walks
  an object once at registration and cannot follow a module that changes shape.
- `strict: false` on the body parser, because a method's input may be a bare string or number.
- Still check the name against the live list before dispatching, so a caller cannot probe for
  arbitrary properties.
- This is a development surface. It exposes whatever the module happens to have, which is exactly
  why it is fast and exactly why it stays behind auth and localhost.

The sections below describe the **published** surface: an explicit facade for things you intend to
keep. Skip them while you are just iterating on code.

## Contract for a published surface

### 1. One transport-neutral facade object

Build a single facade object following the project facade rules (facets named by audience, closure
factories, `deps` down / facts up):

```ts
const agentSurface = {
    control: {reload, rollback},          // commands inward; every method may mutate
    module: {greet /* domain operations of the active module */},
    view: {snapshot},                     // synchronous reads, never mutate
    health: {snapshot: healthSnapshot},
    resource: {guide},                    // self-description text for agent bootstrap
}
```

The facade must not expose: loader internals, filesystem paths, signing/verification objects,
process control, or anything that lets a caller bypass the staged lifecycle. A facet the agent does
not need is a facet you do not register.

### 2. Two registrations, one object rule

Register through `createHttpFacadeServer` (from `wenay-common2/server`) twice:

- `method: 'get'` with **only** `view`, `health`, `resource` — reads. GET never mutates.
- `method: 'post'` with `control` and the domain facet — commands and calls.

Routes mirror the object tree: `basePath + '/view/snapshot'`, `basePath + '/control/reload'`, …
The object is walked once at registration; build the safe facade before registering it.

### 3. Authorization is not optional, even in development

A bearer-token middleware runs before anything else; the POST registration adds the body parser
after it (`middleware: [authorize, express.json({limit: '64kb'})]`) so unauthorized calls cost no
parsing. Bind `127.0.0.1` by default. Before any exposure beyond localhost, read `doc/RPC-AUTH.md`
and treat this surface as one more principal-specific facade.

### 4. Wire format (what the agent sends and receives)

- Arguments are always a JSON array of the method's positional args.
  - GET: `?args=<urlencoded JSON array>`; omitted means `[]`.
  - POST: the JSON body is the array itself (or `{"args": [...]}`).
- Response: `{"ok": true, "value": <result>}` or `{"ok": false, "error": {...}}` with status
  400/401/413/500. Pass `limits` sized to the facade — small numbers; this is a control plane.

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/agent/view/snapshot"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '["world"]' "http://127.0.0.1:$PORT/agent/module/greet"
```

### 5. Self-description

`resource.guide()` returns the instruction text for this surface (this file, or a project addendum
naming the routes and the domain facet). An agent bootstraps from one URL instead of a remembered
prompt. `createHttpFacadeServer(...).routes()` lists every registered route; expose it in the guide
or in `view` if discovery matters.

### 6. Development hot-reload

The reload pipeline reuses the dynamic runtime slice — do not invent a second lifecycle
(`doc/DYNAMIC-RUNTIME.md` is canonical, read it first):

```text
module source file saved
  -> file source notices content-hash change, waits one poll for a stable hash
  -> build: bytes + manifest (unique dev version, content hash, size)
  -> host.control.stage(...)   // verify manifest+hash+signature, isolate, warm, health
  -> host.control.activate(candidateId)   // atomic binding swap
```

Rules the pipeline must keep:

- A broken edit rejects the candidate and **never** touches the active generation; the file source
  records the error and the agent reads it from `view.snapshot`.
- Every dev build gets a unique version and content hash; identical content is not rebuilt by the
  watcher. An explicit `control.reload()` means "make disk content the active binding", not
  "rebuild the same bytes": unchanged-and-active content is a no-op, and content the host already
  staged (for example before a rollback) is discarded and staged fresh, because the host
  deduplicates artifacts by content hash.
- `control.rollback()` returns the slot to the previous verified binding as a new generation.
- Signature verification in development may be a dev-key allowlist, but the verify step itself is
  never skipped — the dev path exercises the same gates production uses.

### 7. How the agent drives it

The loop an agent should follow (and the reference self-client executes literally):

1. `GET resource/guide` — learn the surface.
2. `GET view/snapshot` — active version, binding generation, last build state.
3. `POST module/<op>` — verify current behavior.
4. Edit the module source file; poll `view/snapshot` until the active version changes.
5. `POST module/<op>` — verify the new behavior.
6. If the edit was bad: snapshot shows the rejected build and the unchanged active version; fix the
   file or `POST control/rollback`.

## When a runtime module publishes its own declared tools

This is the heaviest option and the rarest. It is **not** for iterating on code — the dev bridge
above already does that with zero ceremony. Use it only when a module that arrives at runtime must
contribute a *published* surface: named, described, authorized, visible to agents that never saw
the source. Do not build a global registry that all code writes into: it outlives the modules,
makes cleanup ambiguous, and lets one module observe or replace another's registrations.
`doc/DYNAMIC-RUNTIME.md` forbids it.

Three layers, each owned by exactly one place:

1. **Inside the module — a scoped registrar.** The isolation owner injects `context.mcp` into the
   module factory. The module registers inert descriptors plus local handlers and gets receipts
   back. It is not a process global: each module gets its own, and it dies with the module.
2. **In the host — one gateway.** It owns the layered catalog, namespaces, authorization, and
   cleanup. Logically one per application, but created by a closure factory and passed through
   `deps` — never a module-level singleton.
3. **Outside — the adapter.** The same HTTP facade as above (`tools.invoke`, `view.catalog`), or an
   MCP SDK server. Both project the same gateway; module code does not change between them.

Wiring rules that make it correct rather than merely working:

- **The session owner feeds the gateway.** The layer that opens isolated sessions publishes them;
  the gateway never reaches inside the host to find one.
- **Activation drives the catalog.** First activation attaches the source, every later activation
  and rollback replaces it. A tool name keeps resolving to one immutable backing version, and a
  call in flight cannot jump versions.
- **A staged candidate stays private.** Its tools are registered inside its own worker and must not
  appear in the catalog until that candidate is activated.
- **Declarations are compared exactly.** The host declares which tools an artifact may register —
  id, title, description, annotations — and the worker rejects anything else, so a module cannot
  present itself to an agent as something the host never approved. The signed manifest extension
  carrying these declarations is still deferred; until it lands, a host-side table keyed by version
  or content hash is the honest stand-in, and it must be labelled as such.
- **A removed tool fails typed.** After a rollback or detach, invoking a gone tool returns an
  unavailable error; it never falls through to a stale handler.

Reference: `experiments/dynamic-runtime/dynamic-tools-self-client.ts`
(`npm run experiment:dynamic-tools`) proves every rule in this section over plain HTTP.

## Verification

The implementation is done when a self-client proves, over HTTP only: unauthorized calls get 401;
a saved edit hot-swaps and the method answers with the new behavior; **a method added in the editor
is listed and callable with no registration anywhere**; a broken edit leaves the active version
answering while the snapshot reports the rejected build; rollback restores the previous version at
a new binding generation and its extra method stops resolving; an explicit reload command returns
the slot to the on-disk content after a rollback, without a file change.
`experiments/dynamic-runtime/agent-control-self-client.ts` is that proof for this repository —
keep it green.
