# observable2

Minimal reactive object core for coarse, consistent invalidation.

The idea is simple: subscribe to the fact that a reactive subtree changed, then
re-read the current state. There are no deltas, no string paths, no old/new
values, and no computed graph in the core.

## API

```ts
import {reactive, onUpdate, flushReactive, listenUpdate} from './reactive2'
```

### `reactive(obj, opts?)`

Wraps a plain object/array tree.

```ts
const state = reactive({
    balances: {BTC: 100, ETH: 400},
    price: 0,
})
```

You read and write normally:

```ts
state.price = 101
state.balances.BTC = 120
state.balances = {SOL: 250, DOT: 150, ADA: 100}
```

### `onUpdate(node, cb)`

Subscribes to a node. The callback receives no arguments. It means only:

> Something under this node changed; the batch is settled; read the state now.

```ts
const off = onUpdate(state.balances, () => {
    const total = Object.values(state.balances).reduce((a, b) => a + b, 0)
    console.log(total)
})

off()
```

### `flushReactive(node)`

Returns a promise that resolves after queued updates for this reactive tree
settle. Use it in tests, demos, and scripts instead of guessing event-loop order.

```ts
state.balances.BTC = 200
await flushReactive(state.balances)
```

### `listenUpdate(node)`

Adapts an Observe node to the project's existing `Listen` shape. This is the
bridge for RPC: `createRpcServerAuto` already knows how to expose `Listen`
objects as remote subscriptions.

```ts
const facade = {
    getBalances: () => state.balances,
    balancesChanged: listenUpdate(state.balances),
}
```

## Full Example

```ts
import {reactive, onUpdate, flushReactive} from './reactive2'

const sum = (o: Record<string, number>) =>
    Object.values(o).reduce((a, b) => a + b, 0)

async function main() {
    const account = reactive({
        balances: {BTC: 100, ETH: 400},
        positions: {
            BTC: {qty: 0.5},
        },
    })

    let balanceRecalc = 0
    let positionSync = 0

    const offBalances = onUpdate(account.balances, () => {
        balanceRecalc++
        console.log('balances total:', sum(account.balances))
    })

    const offPositions = onUpdate(account.positions, () => {
        positionSync++
        console.log('positions changed:', Object.keys(account.positions))
    })

    // Several synchronous mutations become one callback.
    account.balances.BTC = 120
    account.balances.ETH = 380
    account.balances.SOL = 0
    await flushReactive(account.balances)

    console.log('balance recalculations:', balanceRecalc) // 1

    // Whole-subtree replacement is the important case:
    // the old account.balances proxy keeps working as a subscription target.
    account.balances = {SOL: 250, DOT: 150, ADA: 100}
    await flushReactive(account.balances)

    console.log('new total:', sum(account.balances))       // 500
    console.log('balance recalculations:', balanceRecalc) // 2

    // Deep writes under an already-read branch are reactive.
    account.positions.BTC.qty = 0.7
    account.positions.ETH = {qty: 3}
    await flushReactive(account.positions)

    console.log('position syncs:', positionSync) // 1

    offBalances()
    offPositions()
}

main()
```

## Options

```ts
type Opts = {
    drain?: 'immediate' | 'micro' | number | ((flush: () => void) => void)
    depth?: number
    eager?: boolean
}
```

Defaults:

```ts
reactive(obj, {
    drain: 'immediate',
    depth: Infinity,
    eager: false,
})
```

Drain modes:

- `'immediate'`: `setImmediate` when available, otherwise `setTimeout(0)`.
- `'micro'`: `queueMicrotask`.
- `number`: `setTimeout(number)`, useful as a throttle.
- custom function: bring your own scheduler.

Example throttle:

```ts
const md = reactive({price: 0}, {drain: 50})
let heavyRecalc = 0

onUpdate(md, () => {
    heavyRecalc++
})

for (let i = 0; i < 1000; i++) md.price = i
await flushReactive(md)

console.log(heavyRecalc) // 1
```

## Current Contract

- Root is always a proxy.
- Child proxies are created lazily on read.
- With zero subscribers, writes do not schedule drains.
- Plain objects and arrays are reactive.
- `Date`, `Map`, `Set`, and class instances are opaque leaves.
- Callback errors do not stop sibling subscribers; the first error is re-thrown asynchronously.
- A callback that mutates state queues a follow-up drain instead of recursing.

## What Was Finished

- Local in-process core: `reactive`, `onUpdate`, `flushReactive`.
- RPC bridge: `listenUpdate(node)` returns a `Listen` object.
- Coalesced settled updates.
- Whole-subtree replacement.
- Depth/eager/drain options.
- Edge-case oracle in `reactive2.test.ts`.
- Usage scenarios in `usage.ts`.

## What Is Not Part Of This Core

- Per-key delta streams.
- String-path subscriptions.
- `computed` or dependency tracking.
- Automatic RPC snapshot/mirror layer.

Those live in the layers built ON TOP of this core, not inside it.

## Where This Went

The sandbox has been assembled: the canonical core is
`src/Common/Observe/reactive2.ts`, exported from the package as `Observe`.
Layers on top of it (documented in `wenay-common2.md` / `wenay-common2-rare.md`):

- **Store** — `createStore` wraps the core with typed path nodes (`state` / `node` /
  `update(mask)`), `src/Common/Observe/store.ts`.
- **Mirror sync** — `exposeStore` ⇄ `createStoreMirror`: snapshots + changed
  notifications over RPC, optional push channels (`patches` / `changedData`).
- **Sequenced replay line** — the store's patch stream numbered by seq: keyframe
  catch-up, reconnect by seq, per-client conflation, archived history with
  time-travel. Exported as `Replay` (generic line) and via `Observe`
  (`exposeStoreReplay` / `syncStoreReplay` / `storeReplayAt`); oracles in `replay/`,
  status in `replay/PLAN.md`.

## Run

```bash
npx tsx observable2/reactive2.test.ts
npx tsx observable2/store.test.ts
npx tsx observable2/usage.ts
npx tsx observable2/usage-real-socket.ts
```
