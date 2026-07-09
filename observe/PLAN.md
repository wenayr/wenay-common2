# observe — status and contract

`observe` is the small reactive core for coarse, consistent invalidation.
It is intentionally not a MobX/Vue clone: the API does not expose deltas,
paths, old values, or computed values.

Implemented surface:

```ts
import {reactive, onUpdate, flushReactive, listenUpdate} from './reactive'

const state = reactive({
    price: 100,
    balances: {BTC: 1, ETH: 10},
})

const off = onUpdate(state.balances, () => {
    const total = Object.values(state.balances).reduce((a, b) => a + b, 0)
})

state.balances.BTC = 2
state.balances = {SOL: 250, DOT: 150, ADA: 100}
await flushReactive(state.balances)
off()
```

## Core idea

Subscribe to the fact that something under a node changed. The callback receives
no `(key, value)`, no diff, and no string path. It fires after the settled batch;
the consumer re-reads the current state through normal typed property access.

This is the intended trading/backend use case:

- a feed applies several synchronous mutations;
- subscribers fire once after the batch;
- aggregate code reads a consistent snapshot;
- replacing a whole subtree does not break existing subscribers on that subtree.

## What is implemented

- `reactive(obj, opts?)` wraps a plain object/array tree in stable proxies.
- `onUpdate(node, cb)` subscribes to a reactive node and returns an idempotent `off()`.
- `flushReactive(node)` resolves after queued drains for that reactive tree settle.
- `listenUpdate(node)` adapts a node to the project's existing `Listen` shape for RPC.
- Synchronous bursts are coalesced into one callback per subscribed node.
- A callback that mutates state queues a follow-up drain instead of recursing.
- A throwing callback does not stop sibling subscribers; the first error is re-thrown asynchronously.
- Whole-subtree replacement preserves existing child proxy identity where possible.
- `depth` makes deeper objects opaque leaves.
- `eager` pre-walks/wraps the tree to `depth`.
- `drain` is pluggable: `'immediate'`, `'micro'`, `number`, or custom scheduler.
- Plain objects and arrays are reactive. `Date`, `Map`, `Set`, and class instances are opaque leaves.

## Chosen laziness model

The original design considered subscription-driven wrapping with `subtreeSubs`.
The implemented model is simpler and is now the contract:

- root is always a proxy;
- child proxies are created lazily on read, up to `depth`;
- with zero subscribers, writes only mutate and do not schedule drains;
- built-in/class objects are not proxied.

So this is **lazy-on-read**, not subscription-driven wrapping. That is a conscious
tradeoff: it keeps normal `onUpdate(state.a.b, cb)` usage simple and avoids the
identity caveat of fully lazy upgrades.

## Options

```ts
type Drain =
    | 'micro'
    | 'immediate'
    | number
    | ((flush: () => void) => void)

type Opts = {
    drain?: Drain      // default: 'immediate'
    depth?: number     // default: Infinity
    eager?: boolean    // default: false
}
```

Drain semantics:

- `'immediate'`: uses `setImmediate` when available, otherwise `setTimeout(0)`.
- `'micro'`: uses `queueMicrotask`.
- `number`: uses `setTimeout(ms)` and coalesces to the last state.
- custom scheduler: receives the flush function.

Use `flushReactive(node)` in tests/examples instead of guessing event-loop order.

## Verified by oracle

Run:

```bash
npx tsx observe/reactive.test.ts
npx tsx observe/usage.ts
```

The oracle covers:

- plain and nested read/write;
- cold writes with no subscribers;
- one fact per batch;
- the `$500` whole-map replacement case;
- subscriber survival across middle-node replacement;
- root subscriber behavior;
- unsubscribe before flush;
- mutation from inside callback;
- arrays;
- opaque `Date`/`Map`/class leaves;
- `depth` behavior;
- callback error isolation.

## Not implemented here

These are intentionally not part of the finished local core:

- per-key delta streams;
- string paths;
- `computed`/derived graph primitives;
- dependency tracking by reads;
- automatic network mirror over RPC.

`listenUpdate(node)` already stacks with `createRpcServerAuto` as a notification
stream. The larger mirror extension remains separate: subscribe to a subtree,
send whole snapshots on settle/throttle, and atomically replace the mirror branch
on the client.
