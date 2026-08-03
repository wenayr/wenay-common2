# Recommendations — current seams only

Completed migrations and released work are recorded in `doc/changes/`, not repeated here.

## Current Store/RPC default

Use Store Replay V2 over the ordinary JSON-array RPC lane. `api.replay` is the only Store replay
facade; it has no legacy fallback or numbered generation members.

RPC application traffic uses JSON arrays only. `RpcOpt` now carries six negotiated bits: the four
measured JSON-wire optimizations (`compact`, `callbackBatch`, `compactRows` — all default on — and
`requestBatch`, opt-in) and the two authorization-protocol bits (`authState`, `helloId`). Keep it to
those two families — a wire feature or an authorization correlation — rather than adding another
application serializer.

## RPC authorization seams

The dynamic-token lifecycle is shipped (`doc/RPC-AUTH.md` is canonical). These are the seams it
leaves open; none is a behavior gap, and each is cheap to break by accident.

- **The harness is type-checked by the gate — keep it that way.** Closed: `tsconfig.spec.json`
  (`npm run test:spec-types`, third step of `npm run test` and `npm run test:all`) checks every
  `src/**/*.spec.ts` under the library's own compiler options — nothing relaxed, only `noEmit` added
  so `npm run build` still emits no spec into `lib/`. The include is a glob, so a new spec file under
  `src/` is checked the moment it is created; a new harness stage needs no config change. Two rules
  keep it green in a file whose clients are often `createRpcClient<any>`: reach an index-signature
  member with brackets (`c.func['neverSettles']()`, `store.state['BTC'] = 2`), and give a callback
  parameter an explicit type when its callee is `any` (`.then(…, function on(error: any) {…})`).
  Where a precise client type is available, prefer it over `RpcClientReturn<any>` — `c.strict.x.y()`
  only resolves when `T` is real.
- **The suites outside `src/` are still unchecked.** `oracle/**/*.spec.ts`, `replay/**/*.test.ts` and
  `observe/**/*.test.ts` are in no tsconfig project; `scripts/run-oracles.mjs` runs them through
  `tsx`. Measured against the library options they carry 33 / 180 / 23 errors of the same two
  families. Closing that is a separate pass — clean the errors first, then extend
  `tsconfig.spec.json`'s include (it is already `rootDir: "."`), or the gate turns red for reasons
  unrelated to the change under test.
- **Every `Pkt.MAP` must be preceded by `sendCapsChallenge()`.** The client decides whether an id-less
  MAP is unsolicited by reading `peerServerCaps` at MAP-handling time, which is only current because
  `sendMap` and both raw HELLO reply branches send CAPS first. A future MAP emitted without that
  prefix reopens the window where an unsolicited MAP is mistaken for the answer to a `reauth()`.
- **`'$rpc'` is a wire contract with one home.** It lives in `rpc-protocol.ts` as `GRANT_FACTS_KEY`
  and is imported by `rpc-server.ts` (`withGrantDeadline`) and `rpc-client.ts` (`grantDeadline`).
  Server-attached grant facts go inside that sub-object; do not add sibling top-level ack keys.
- **Three known client edges, deliberately not closed:** concurrent `init()` calls still send two
  HELLOs (the documented pattern is sequential, and the provider is single-flighted anyway); a
  `resolveAuth` that never settles on a live socket wedges that connection's renewals; and
  `helloWaits` grows by one per `requestSchema()` against a server that ignores `Pkt.HELLO`
  entirely, bounded by reconnect count and cleared on teardown. All three predate or are unchanged
  by the token lifecycle and none has a consumer asking for a fix.

## RPC codec seams

- **The reserved key space is a contract, not a bug to be fixed later.** `$_d` `$_m` `$_s` `$_r`
  `$_b` `$_f` `$_t` belong to the codec as the SINGLE key of a plain object; the contract, the
  accepted payload per key and the escape hatch are stated once in `doc/wenay-common2-rare.md`
  under "RPC application wire". Recognition is now exactly as narrow as what each serializer
  emits, so what remains is irreducible without changing the wire. Escaping the collision is the
  obvious next idea and it was measured against its own cost: it moves the bytes, so it needs a
  `Caps` bit, and against a peer without the bit it exchanges one silent corruption for another.
  Do not add it without a consumer who actually produces a colliding value — the report already
  tells them, and a second key already fixes it.
- **Two places do NOT apply marker recognition, on purpose.** The compact tick path
  (`Pkt.SHAPE`/`Pkt.CBV`) rebuilds the tick object from its declared keys and decodes only the
  VALUES, so a top-level single-key `{"$_d": n}` tick arrives as a Date on the plain `Pkt.CB` path
  and as the raw object once the shape is standardized. Making them agree would mean making the
  compact path collide too. Likewise `unpack` is never handed a row codec, so `$_t` is a table in
  results and callbacks and never in arguments.
- **`listenKeyArg` in `rpc-client.ts` builds subscription keys with the same markers and is
  currently unreferenced.** If it is ever wired up, a `{"$_d": 5}` argument and a real `Date(5)`
  argument would produce the same subscription key and share one physical subscription.

## Scheduler extraction

`schedule` / `createDrained` in `store.ts` still resemble scheduler logic in `reactive.ts`. This is
not a behavior gap. Extract a shared utility only if another scheduler appears or a real bug shows
that the implementations have diverged.

## Conditional features

- Shared documents: integrate a proven CRDT through the engine-neutral provider boundary in
  `doc/ROADMAP.md`; do not make Store itself multi-writer.
- Predicted Store: wait for a consumer that defines command receipt/reject/rebase semantics.
- Media optimization: use the stand's max-video measurements to choose exactly one bottleneck.

## Generated declaration overview for consuming projects

For a TypeScript library or modular application, keep a generated declaration tree inside the
consumer's own workspace. It gives people and code agents a compact overview of exported module
boundaries without making generated files a second source of truth. The consumer owns the watcher:
an installed dependency must not start a persistent process from `postinstall`.

Apply the declaration tree as an index:

1. Choose the entrypoint that matches the package export or application boundary being used.
2. Read that entrypoint's `.d.ts` and follow its re-exports/namespaces until the owning declaration
   is clear.
3. Use the declaration to understand the public shape and type relationships, then open the source,
   tests, or public docs for runtime behavior and implementation details.
4. Change source files only. Regenerate declarations and inspect their diff to catch accidental
   exports, widening, narrowing, or stale entrypoints.

This stays safe because declarations are never treated as executable behavior or as a second source
of truth. They shorten navigation; they do not replace source review, tests, or documentation.

Add `tsconfig.types.json` at the consuming project root:

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "noEmit": false,
        "allowJs": false,
        "declaration": true,
        "emitDeclarationOnly": true,
        "declarationMap": false,
        "outDir": "./.types",
        "incremental": true,
        "tsBuildInfoFile": "./.types/.tsbuildinfo"
    },
    "include": [
        "./src/**/*"
    ],
    "exclude": [
        "./src/**/*.spec.ts",
        "./src/**/*.spec.tsx",
        "./src/**/*.test.ts",
        "./src/**/*.test.tsx"
    ]
}
```

`noEmit: false` deliberately overrides the common React/Next application default; `allowJs: false`
keeps this overview limited to `.ts`, `.tsx`, and existing declaration inputs rather than adding
JavaScript/JSX output.

Add the project-local commands:

```json
{
    "scripts": {
        "types:generate": "tsc -p tsconfig.types.json",
        "types:watch": "tsc -p tsconfig.types.json --watch"
    }
}
```

Run `npm run types:watch` in a long-lived development terminal. The watcher observes filesystem
changes regardless of whether they come from an IDE, a code agent, Git, or another process. It does
nothing until the consumer explicitly starts it, so a one-shot `npm run types:generate` plus a clean
CI/build check remains the correctness gate.

Copy this block into the consuming project's agent instructions, adjusting `.types` if declarations
are emitted into another build directory:

```md
## Generated declarations

- `.types/**/*.d.ts` files are generated artifacts. Never edit them manually.
- Start at the relevant generated declaration entrypoint and follow re-exports for a compact
  overview of the exported project surface.
- Use declarations for public shapes and type relationships only; verify runtime behavior in source,
  tests, and documentation.
- Change the original `.ts` files, not generated declarations.
- During extended TypeScript editing, start `npm run types:watch`; do not assume it is already running.
- Before finishing changes to exported types, run `npm run types:generate` and inspect the declaration
  diff for unintended public-surface changes.
```

This repository applies the same pattern with checked-in `lib/**/*.d.ts`, `types:generate`, and
`types:watch`. Declarations describe exported contracts, not complete internal behavior; modules
without meaningful exports may produce an almost empty declaration. Keep `.tsx` in the input:
exported React components and their props need declarations just as ordinary `.ts` modules do; the
generated `.d.ts` contains their type surface, not JSX implementation.

## Replay scaling follow-ups

The compatibility-safe CPU and allocation hot paths are optimized. The remaining large gains need
an explicitly negotiated retention or persistence change:

- Chunk large keyframes before encoding. A single Store keyframe is still monolithic and measured
  about 3.3 MiB at 100,000 representative keys. Define chunk identity, total revision and atomic
  apply before changing the wire path. `experiments/slow-network-2026-08` raised the stakes: a
  monolithic frame that occupies a slow link longer than the heartbeat budget starves the ping and
  kills the connection mid catch-up, so chunking is also the structural fix for reconnect storms.
  A design sketch for those three gates, plus the five decisions that must be answered before any
  code, is `doc/target/KEYFRAME-CHUNKING.md`. It is explicitly not an approved protocol.
- Add a byte budget beside the batch-history entry count. A legal history window can retain many
  large patches even when the number of envelopes is bounded. This became more relevant, not less,
  once `keepMs` shipped: a time-only window deliberately leaves the count unbounded, so memory is
  rate x keepMs and only a byte bound can cap it directly. `journalWindow()` currently reports
  entries and age, not bytes.
- Add a maximum wait to offline debounce only after defining the write-amplification trade-off; the
  current quiet-period debounce can postpone persistence under a permanently busy feed.

### Remaining local-resource routes

The current LAN profiles are CPU/allocation-bound; wire compression is a separate bandwidth
trade-off. Do not combine these routes without measuring the target deployment:

| Route | Likely benefit | Complexity / risk | Gate before implementation |
|---|---:|---|---|
| Transfer decoded Store patch ownership into the mirror instead of cloning it again | Reduces residual clone cost for indivisible large branches and keyframes | High: `onBatch`, retained journal and Store must not share mutable values | Define an internal ownership token and mutation tests before removing any clone |
| Declare custom policy locality (`record-local` versus `global`) | Avoids a full projection rescan for record-local rules | High: silently assuming locality can expose revoked records | Add an explicit locality contract plus `invalidateAll`/policy revision |
| Keyed/chunked offline persistence | Avoids snapshotting the complete Store for a small update | High: changes durable format, migration and crash recovery | Specify chunk revision, atomic manifest and old-snapshot migration |
| Parallel StoreManager startup | Reduces latency for independent reads | Medium: current failure and side-effect order is observable | Discuss an explicit concurrency option before changing startup behavior |
| Sacred Peer publish backpressure | Bounds producer memory when lossless transport is stalled | High: lossless data cannot be silently conflated or dropped | Add public `pending`/`drain`, byte high-water and a defined overflow failure |
| Media frame-version capability | Allows a future media header version without guessing from payload bytes | Medium: control negotiation must precede frame emission and preserve existing peers | Add explicit media capability exchange and a mixed-version matrix |
| Dynamic media fan-out plus transport-aware latest-frame backpressure | Can avoid repeated work when many viewers follow one source | High: changes delivery/retention semantics | Choose queue vs latest per media kind and expose the choice explicitly |
| Real JPEG/WebP/GPU profiling | Finds browser decode/paint bottlenecks absent from synthetic Node stress | Measurement work, no protocol risk | Run the stand on representative devices before changing codecs or frame policy |

### Compression routes

Application traffic and CAPS/MAP/HELLO bootstrap use JSON arrays. Binary business-data leaves remain
native transport attachments rather than being expanded into JSON number arrays.

Reverse-proxy compression applies to HTTP assets, facade responses and polling, not WebSocket
messages after Upgrade. Socket-level `perMessageDeflate` is now measured
(`experiments/slow-network-2026-08`): on replay/rows-shaped JSON it removes 90 %+ of wire bytes for
about 2× CPU on large messages, which converts to 4.8–8.2× faster delivery on a ≈1 Mbit/s link and
by itself prevented the measured ping-starvation disconnect. On loopback/LAN it is a pure CPU and
latency loss, matching the July stands. So the rule is deployment-shaped: enable it where bandwidth
is the ceiling, keep it off where CPU is. Deflate also compresses binary frames, so keep
already-compressed media off deflated connections. Application-frame compression still would require
a separate capability, uncompressed-size limits and decompression-bomb protection; deflate at the
socket removes the evidence that its complexity could be justified.

### Slow-network Socket.IO profile (measured 2026-08)

The library never creates sockets, so this is application guidance. The failure mode on slow links,
reproduced in `experiments/slow-network-2026-08`: one frame occupying the link longer than the
heartbeat budget starves the queued ping, the client declares `ping timeout`, reconnects, catch-up
resends a large frame, and the cycle repeats. With default `pingInterval` 25 s / `pingTimeout` 20 s,
any frame above ~2.5 MiB at 1 Mbit/s is in the kill zone — a measured 100k-key Store keyframe
(~3.3 MiB) qualifies.

Recommended server options for bandwidth-constrained deployments:

```ts
new Server(httpServer, {
    pingTimeout: 60_000,                      // survive one large frame on a slow link
    perMessageDeflate: {threshold: 1024},     // measured: 90 %+ bytes off replay-shaped JSON
    maxHttpBufferSize: /* largest legal client frame */
})
```

Node clients add `perMessageDeflate: true` (browsers offer the extension automatically; the server
side is the deciding switch). Client reconnection defaults (1 s → 5 s backoff, infinite attempts)
are already reasonable; raise the client `timeout` only if the connect handshake itself times out on
the target route.

What this profile does not solve, with the honest route for each:

- Reconnect cost: already handled above the socket — the replay catch-up ladder (`frame`/`since`)
  and declared-Listen recovery survive reconnects; keep journal retention long enough that a flap
  costs a tail, not a keyframe.
- In-flight RPC calls still reject on disconnect by design; an opt-in idempotent-retry/outbox layer
  is a public-contract discussion, not a config knob.
- Socket.IO `connectionStateRecovery` could make short flaps invisible below the RPC layer, but the
  hub re-handshakes on every connect regardless, so its value here is unproven. Gate: run
  `oracle/realsocket/replay-reconnect.spec.ts` and the stale-packet paths against a recovery-enabled
  server before recommending it.
- Real packet loss and per-connection deflate memory under fan-out are unmeasured; repeat the stand
  over the actual deployment route before freezing production values.

## Lazy line scaling follow-ups (deferred 2026-08)

`exposeStoreLazyLine` gained static selections (`keys`) in 2.7.0, which covers per-partition
publishing (one Store per `(category, quoteAsset)` or several selected lines over one Store).
Three follow-ups were considered and deliberately deferred:

- **Changed-key index.** `read()` catch-up is a linear walk of the sorted key array; at 350 keys
  it is negligible, at 20 000 keys x N live subscribers x 250 ms polling it trades RAM for CPU.
  Before building an index (revision-ordered skip structure or bucketed dirty sets), measure with
  the stand: `experiments/store-lazy-2026-08` already models the live phase — add a multi-client
  scenario and profile the host. Build only if the walk shows up.
- **Shared patch watcher.** Every lazy line on one Store registers its own `listenStorePatches`
  subscriber; V lines see every batch V times. Values are never cloned, so the cost is iteration
  only. If many selected lines share one Store in practice, dispatch top-level keys once through a
  shared registrar (the selective replay-view watcher in `store.ts` is the model to follow).
- **Full `createStoreLazyView` facade.** A dedicated `{resource, view, close}` wrapper with
  descriptor-carried `selectionId` (like `StoreReplayViewDescriptorV1`) is only worth adding when a
  consumer needs remote selection discovery; today the selection rides the cursor and `view` on the
  host side, and syncStoreLazyLine needs nothing more.
