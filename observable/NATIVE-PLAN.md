# NATIVE-PLAN — `createReactive`: native deep reactive object over the transport store

Status: DONE. `native.ts` implemented + wired into the barrel; oracle + engine
oracles + usage.ts all green; native.ts/index.ts type-check clean (es2021).
Naming used: `createReactive` (owner: "name doesn't matter").

Follow-up (owner: "rewrite the overview to show convenient usage"):
- RPC listen helpers split for consistency with the store facade:
  `listen` = collection (entries) stream, `listenValue` = field (value) stream,
  `listenDeep` = everything-below. README/usage updated to match.
- COOKBOOK in `src/Common/rcp/rpc.harness.spec.ts` (the overview) rewritten to the
  native style: pattern #2 `md.price = 101` (was `createCell`/`price.set`), pattern #3
  `book.positions.BTC = 2` / `delete book.positions.BTC` (was `createRMap`/`.set`/`.delete`).
  Full harness: 138 PASS, 0 FAIL, ALL GREEN.

## Goal

Let the user work with a reactive value as a **plain object**, at any depth,
including replacing a whole sub-tree:

```ts
const p = createReactive({price: 0, balances: {BTC: 1, ETH: 10}})

p.price = 100               // plain set  -> emits
p.balances.BTC = 2          // nested set -> emits (sub-catalog mutation)
p.balances = {a: {c: 5}}    // whole sub-tree replace -> DIFFS, only changed leaves fire
delete p.balances.ETH       // plain delete -> emits
console.log(p.balances.BTC) // plain read
Object.keys(p.balances)     // native enumeration

onValue(p, ['balances','BTC'], v => ...)   // subscribe to one (deep) leaf
onChange(p, (k, v) => ...)                 // direct children of root
onDeep(p, (path, v) => ...)                // anything below
listen(p, 'price')                         // funcListenCallbackBase -> RPC, unchanged
```

No `.set('k', v)`, no `.get('k')`, no `{current:true}` ceremony, no identity-change
caveat. The object **is** the reactive object.

### Headline scenario (must pass)

`p.p = {a: {c: 5}}` while subscribed to the deep leaf `p.p.a.c` must fire the leaf
subscriber with `5`. Already supported by the engine: `store.set` -> `applyContainer`
recurses, `setValue(5)` on node `['p','a','c']` emits its `valueEv`. The skin only has
to (a) route `p.p = {...}` to `store.set('p', {...})`, and (b) expose a path-based
`onValue(root, ['p','a','c'], cb)` (a leaf read returns the primitive, not a node, so
deep-leaf subscription is path-addressed from the root).

## Key design decisions

1. **Proxy, not accessors.** Accessors (`defineProperty` get/set) cannot trap a brand
   new key (`p.balances.NEWCOIN = 5`) or `delete`. Dynamic keys + whole-subtree replace
   require a `Proxy`. Accepted.
2. **Stable Proxy, no upgrade/downgrade.** Unlike `auto.ts` (`createAuto`), we do NOT
   drop the Proxy at 0 listeners. That dance is the source of the "read `.store` fresh
   after subscribe" caveat (identity changes). Reads/writes through the store are already
   cheap and events are already lazy, so a stable Proxy costs nothing extra and removes
   the caveat entirely. The object identity never changes.
3. **Lazy twice.** (a) Events stay lazy via the store's `createLazyListen` — no listeners
   => no Listen Maps, `emit` is an empty `if`. (b) Navigation-lazy: a child Proxy for a
   sub-catalog is created only on first access to that branch and cached; untouched
   branches allocate no Proxy.
4. **Container read = live child Proxy.** Reading `p.balances` returns a live navigable
   Proxy (so you can keep mutating into it), NOT a plain snapshot. `JSON.stringify`,
   spread, `Object.keys`, `in` all work via traps; but `p.balances instanceof Map` is
   `false`. For a plain detached copy use `snapshot(p, 'balances')`.
5. **Subscription via free functions** (chosen by owner). The object stays 100% pure
   data; the node is reached via a hidden non-enumerable Symbol on each Proxy. Free fns:
   `onValue / onChange / onKey / onDeep / listen / listenDeep / snapshot`.
6. **Additive.** `createAuto` / `createAutoNode` (auto.ts) stay (library is additive-only).
   `createReactive` becomes the headline native API; docs lead with it and demote
   `.set/.get` + `createAuto` to a "low-level / specialized" section.

## Proxy cost (the "how slow is it" question)

Plain `obj.x=5` ~ inlined (billions/s). A Proxy trap is ~10-50x slower but still tens of
millions ops/s in absolute terms — irrelevant for a market-data feed. Hot read loops can
hoist `const price = p.price` or read via the store directly. Not a concern at this
workload; navigation-laziness means you only pay for paths you touch.

## The only new code: `observable/native.ts`

A thin skin over `store.ts`. No new reactivity logic.

- `createReactive(initial, opts?)` — builds a `createTransportStore`, returns a recursive
  Proxy over its root node.
  - `get(t,k)`: leaf -> `node.get(k)`; container child -> cached child Proxy (lazy);
    Symbol key -> the node (for the free fns).
  - `set(t,k,v)`: `node.set(k, v)` (store diffs + emits; handles new keys + replace).
  - `deleteProperty`: `node.delete(k)`.
  - `has` / `ownKeys` / `getOwnPropertyDescriptor`: from the node (native enumeration/spread).
  - register the Proxy via `registerReactiveNode` so `isReactiveNode` recognizes it.
- Free functions resolving the node by the hidden Symbol, then delegating to the node
  facade that store.ts already exposes:
  - `onValue(p, pathOrKey, cb, opts?)` -> `store.at(path).value(cb, opts)`
  - `onChange(p, cb, opts?)`           -> `node.entries(cb, opts)`
  - `onKey(p, key, cb, opts?)`         -> sugar over `onValue` for a direct child
  - `onDeep(p, cb, opts?)`             -> `node.deep(cb, opts)`
  - `listen(p, pathOrKey?)` / `listenDeep(p)` -> `node.listen()/listenValue()/listenDeep()`
  - `snapshot(p, pathOrKey?)`          -> `node.snapshot()` (plain detached copy)
- Inline runnable oracle (`require.main`) covering: nested set, whole-subtree replace =>
  only-deltas (the headline scenario), delete, native enumeration, deep-leaf subscribe,
  `listen()` passes `isListenCallback`.

Estimated ~140-200 LOC including the oracle.

## Module-by-module impact (all of observable/)

### Core engine — REUSED, ZERO changes
- **store.ts** — the deep diffing/snapshot/RPC engine. The node facade already exposes
  everything the skin needs (`get/snapshot/has/keys/set/replace/setIn/delete/key/at/
  value/entries/deep/rev/onRev/listen/listenValue/listenDeep`). **No change.**
- **reactive.ts** — `createLazyListen` + `registerReactiveNode`/`isReactiveNode`. The skin
  only *calls* `registerReactiveNode` (existing API). **No change.**

### New
- **native.ts** — the whole feature. NEW file (see above).

### Small additive edits
- **index.ts** — add `createReactive` + free fns + `Reactive` type to the barrel (~10 LOC).
- **README.md** — lead with `createReactive`; move `.set/.get` + `createAuto` into a
  "low-level / when you need it" section (~40 LOC doc).
- **example.ts** / **usage.ts** — add a native-first section (this is the exact code that
  triggered the complaint: it currently leads with `.set/.get`). ~40 LOC.

### Optional (nice-to-have, can defer)
- **bench.ts** — add a plain-vs-proxy-vs-store microbench to make the cost concrete (~30 LOC).
- **test.ts** — one native round-trip over the loopback RPC (`listen(p,'price')`) (~30 LOC).

### NOT touched — and why (they sit on top of the same store/Source, the skin is orthogonal)
- **auto.ts** (`createAuto`/`createAutoNode`) — older flat lazy-Proxy. Kept (additive);
  superseded as the headline only in docs. No code change.
- **autotrack.ts** (`computedAuto`) — derived over `Source`. Orthogonal.
- **transit.ts** (`filter/route/switchOn/merge`) — operator nodes over `Source`. Orthogonal.
- **schedule.ts** (`createEffect/createRoot`) — effects over `Source`. Orthogonal.
- **batch.ts** — batching core. `batch(() => { p.x=1; p.y=2 })` already coalesces because
  writes go through store nodes that integrate batch. Works automatically. No change.
- **rate.ts** (`throttle`) — wraps a `Source`/`listen()`. Throttle `listen(p,'price')`
  with no change.
- **typed.ts** — typed projection over the store (sibling wrapper concept). No change now;
  could later share the type machinery. Left as-is.
- **meter.ts** (`createAdaptiveWatch` etc.) — rides the store's `rev()/onRev()`. Same nodes,
  no change.
- **wire.ts / codec.ts / shapewire.ts / sync.ts** — wire/sync layers over the store's
  `deep()/snapshot()/listen()`. The Proxy is in-process only; over the wire it is still the
  store's frames. No change.
- **bulk-rpc.test.ts** — RPC oracle. No change (optional native case could be added).

## Volume summary

- 1 NEW file (`native.ts`, ~140-200 LOC, includes its own oracle).
- 3 small additive edits (index.ts barrel, README, example/usage docs).
- 0 changes to the reactivity engine (reactive.ts, store.ts) and to all derived/transit/
  effect/wire/sync/meter/typed/rate modules.
- Optional: bench + RPC round-trip.

The whole feature is a skin; the risk surface is one file.

## Open questions / risks

- Naming: `createReactive` (default pick) vs `createNative` / `reactive`. Free-fn names
  `onValue/onChange/onKey/onDeep`.
- `opts` passthrough to the store (`deepEqual`, `opaque`) — expose via `createReactive`'s
  second arg (forward verbatim to `createTransportStore`).
- Array support: store treats arrays via `isContainer`? Arrays are objects but
  `constructor == Array`, so `isContainer` returns false -> stored as an opaque leaf.
  Decide whether `createReactive` should support reactive arrays (likely defer; document
  that arrays are leaf-replaced wholesale for now).
- Symbol-key reads on the Proxy must be inert for everything except our private node
  Symbol (so `JSON`, `util.inspect`, `Symbol.iterator` probing don't break).

## Verify

```
node node_modules/ts-node/dist/bin.js --transpile-only observable/native.ts   # new oracle
node node_modules/ts-node/dist/bin.js --transpile-only observable/store.ts     # engine still green
node node_modules/ts-node/dist/bin.js --transpile-only observable/reactive.ts  # identity registry still green
```