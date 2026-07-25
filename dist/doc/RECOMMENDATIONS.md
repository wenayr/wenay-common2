# Recommendations — current seams only

Completed migrations and released work are recorded in `doc/changes/`, not repeated here.

## Current Store/RPC default

Use Store Replay V2 over the ordinary JSON-array RPC lane. `api.replay` is the only Store replay
facade; it has no legacy fallback or numbered generation members.

RPC application traffic uses JSON arrays only. Keep `RpcOpt` limited to measured JSON-wire
optimizations (`compact` and `callbackBatch`) rather than adding another application serializer.

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
  apply before changing the wire path.
- Add a byte budget beside the batch-history entry count. A legal history window can retain many
  large patches even when the number of envelopes is bounded.
- Add a maximum wait to offline debounce only after defining the write-amplification trade-off; the
  current quiet-period debounce can postpone persistence under a permanently busy feed.

### Remaining local-resource routes

The current LAN profiles are CPU/allocation-bound; wire compression is a separate bandwidth
trade-off. Do not combine these routes without measuring the target deployment:

| Route | Likely benefit | Complexity / risk | Gate before implementation |
|---|---:|---|---|
| Transfer decoded Store patch ownership into the mirror instead of cloning it again | Largest remaining 15k Store CPU/live-tree reduction | High: `onBatch`, retained journal and Store must not share mutable values | Define an internal ownership token and mutation tests before removing any clone |
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
messages after Upgrade. Socket-level `perMessageDeflate` is the first candidate for
bandwidth-constrained RPC, but it needs a production CPU/latency measurement and should avoid
already-compressed media. Application-frame compression would require a separate capability,
uncompressed-size limits and decompression-bomb protection; there is no current evidence that its
complexity is justified.
