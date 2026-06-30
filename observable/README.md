# observable — cheap reactive primitives

A reactive **variable / object / map** that you read & write like a plain value
but that is *also* a subscription source — and pays nothing while nobody listens.

Sandbox folder, **not wired into `src/index.ts`** yet (for review).

## Native API — `createReactive` (start here)

The headline surface: work with a reactive tree as a **plain object**, at any
depth, including replacing a whole sub-tree. No `.set/.get` ceremony, no
identity caveat. Subscription lives in free functions, so the object stays
pure data.

```ts
import {createReactive, onKey, onValue, onChange, onDeep, listen, listenValue, snapshot} from './native'

const p = createReactive({price: 0, balances: {BTC: 1, ETH: 10}})

p.price = 100               // plain set  → emits
p.balances.BTC = 2          // nested set → emits (sub-catalog mutation)
p.balances = {a: {c: 5}}    // whole sub-tree replace → DIFFS, only changed leaves fire
delete p.balances.ETH       // plain delete → emits
p.balances.BTC              // plain read
Object.keys(p.balances)     // native enumeration / spread / `in`

onKey(p, 'price', v => …)            // one direct leaf
onValue(p, ['p','a','c'], v => …)    // one DEEP leaf (path-addressed)
onChange(p, (k, v) => …)             // direct children: [key, value]
onDeep(p, (path, v) => …)            // anything below: [path, value]
listenValue(p, 'price')              // a FIELD's value stream  → RPC, unchanged
listen(p, 'balances')                // a COLLECTION's [key,value] deltas → RPC
snapshot(p, 'balances')              // plain detached copy
```

It's a thin Proxy skin over the transport store below — the store does all the
diffing/snapshot/RPC; the Proxy only turns native syntax into node calls. Lazy
twice: events allocate nothing until subscribed, and a child Proxy is built only
when you navigate into that branch. Run: `… --transpile-only observable/native.ts`.

> The `.get()/.set()` primitives (`createCell` / `createRObject` / `createRMap`)
> below are the **low-level layer**. Reach for them when you want an explicit
> single cell/key; otherwise prefer `createReactive`.

## Design

- **Cheap until subscribed.** The underlying multicast Listen
  (`funcListenCallbackBase`, 3 internal Maps) is created **lazily on the first
  `addListen`**. With zero subscribers a cell is just a closure + one field and
  `emit` is an empty `if`. A per-key Listen is created only for keys someone
  actually subscribes to.
- **Subscription = new updates only.** No snapshot on subscribe by default;
  the current value is read separately via `.get()`. The callback is
  *conditional*: pass `{current: true}` to also receive the current value
  immediately, before future updates.
- **Change-detected.** A `.set()` to an equal value (default `Object.is`) is a
  no-op — no emit. Pass `{equals}` to override.
- **RPC-ready by reuse.** Every source exposes the real Listen via `.listen()`,
  the exact `funcListenCallbackBase` shape the network layer expects
  (`listenSocket` / `listen-deep`). It drops into the existing RPC plumbing with
  no extra work. Verified via `isListenCallback` in the demo.
- **0-dep.** Built on the project's own `Listen`; no external libraries.

## API

```ts
// variable
const n = createCell(0)
n.get(); n.set(5); n.update(v => v + 1)
n.subscribe(v => ...)                  // new updates only
n.subscribe(v => ..., {current: true}) // + current value now
n.map(v => v * 2)                      // derived (see below)
n.listen()                             // stable Listen façade, for RPC

// object — per-key + whole
const o = createRObject({a: 1, b: 2})
o.get('a'); o.set('a', 10)
o.key('a').subscribe(v => ...)         // one key (lazy per-key Listen)
o.subscribe((k, v) => ...)             // whole object: [key, value]

// map — dynamic keys, add/delete
const m = createRMap<string, number>([['x', 1]])
m.set('y', 2); m.delete('x')           // delete emits undefined
m.key('y').subscribe(v => ...)
m.subscribe((k, v) => ...)

// derived — pull get() + lazy push
const a = createCell(2), b = createCell(3)
const sum = combine([a, b], ([x, y]) => x + y)
sum.get()                              // pulls; sources stay COLD (no upstream sub)
sum.subscribe(v => ...)                // now connects a & b; disconnects on last leave
const c = computed(a, x => x + 1)      // single-source sugar

// recycle — fully back to primitive after subscribers churn
const r = createCell(0, {recycle: true})
```

## Run

```
node node_modules/ts-node/dist/bin.js --transpile-only observable/showcase.ts  # ★ narrated server→front story (createReactive), also a living test
node node_modules/ts-node/dist/bin.js --transpile-only observable/example.ts   # quick demo
node node_modules/ts-node/dist/bin.js --transpile-only observable/usage.ts     # realistic usage scenarios
node node_modules/ts-node/dist/bin.js --transpile-only observable/test.ts      # full oracle + real RPC round-trip
node node_modules/ts-node/dist/bin.js --transpile-only observable/auto.ts      # lazy Proxy upgrade (primitive↔reactive)
node node_modules/ts-node/dist/bin.js --transpile-only observable/rate.ts      # rate-limited subscription (waitRun)
node node_modules/ts-node/dist/bin.js --transpile-only observable/store.ts     # transport store (path-addressed tree)
node --expose-gc node_modules/ts-node/dist/bin.js --transpile-only observable/bench.ts   # microbenchmark
```

**`store.ts` — "transport store"** is the headline use-case (see `STORE-PLAN.md`): a
path-addressed reactive tree mixing primitives + maps at any depth, with diff-on-whole-replace
(the Binance "fresh map, only changed coins fire" case), 3-granularity subscribe
(`value`/`entries`/`deep`), `snapshot()` reconstruction, and RPC-ready `listen*()` streams for
single-element or group sync.

Extra layers:
- **`auto.ts`** — `createAuto(obj)`: stays a raw primitive until observed, upgrades to a
  Proxy on first subscribe (plain `store.x=5` emits), downgrades back when the last
  listener leaves. Caveat: `.store` identity changes on upgrade — read it fresh.
- **`rate.ts`** — `throttle(source, {ms, mode})`: at most one update per `ms`, always the
  latest value. `trailing` (debounce) / `leading` (immediate + trailing guarantee). Built on
  `waitRun`. Per-subscriber rate via `subscribe(cb,{ms})` + `.setRate(ms)`; `.listen()` throttles
  once and fans out (the "don't flood the network" RPC path).

`test.ts` boots a real RPC client+server over the loopback transport (same as
`src/Common/rcp/rpc.harness.spec.ts`) and streams a cell over the wire, verifying
remote subscribe/unsubscribe and that the server-side cell returns to 0 subscribers.

## Done beyond the brief

- **Recycle to primitive on last unsubscribe** (`{recycle:true}`) — frees the
  inner Listen at 0 listeners. `.listen()` returns a *stable façade* (exact
  `funcListenCallbackBase` shape, passes `isListenCallback`), so a captured ref
  (incl. an RPC binding) survives the destroy/recreate cycle.
- **Derived graph** (`combine` / `computed` / `.map`) — `get()` pulls with zero
  upstream subscriptions; the graph only connects upstream while a leaf has a
  listener, and collapses back when it leaves.

## Open follow-ups (not done)

- **Snapshot-via-the-variable** (the "get current value through the same source
  on connect" idea) — deliberately left out; tracked separately.
- **Delete vs set-undefined** in `RMap` are conflated (both emit `undefined`).
  Add a separate `deletes` stream if the distinction matters.
- **Wire into `src/index.ts`** — kept out of the public barrel until you review.
