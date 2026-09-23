# Store: one source of types, optional distributed placement

The goal is to keep application behavior and consumer subscriptions stable while its transport and
placement change. Start with a local Store and domain commands, derive the facade type from the
factory, then compose RPC and Scale around those resources. Do not redeclare the same state and
command interfaces at each hop.

## Verified consumer journey

`oracle/realsocket/store-consumer-journey.spec.ts` (repository checkout) is an executable example
of the complete path. Run `node --import tsx oracle/realsocket/store-consumer-journey.spec.ts`
from a repository checkout; the npm package ships runnable consumer projects in `examples/` instead.

1. A command factory changes a local Store; a typed node subscription observes the result.
2. The same command map is passed to `Scale.createAuthority`. Its read/write facade types are
   derived from the authority's `serve` factories and used by the RPC hub.
3. Two `Observe.createStoreNode` instances mirror the authority. `Scale.createClusterClient`
   chooses a serving node and maintains one consumer Store.
4. Draining `n1` transfers the consumer to `n2`. Reusing a command request id through the second
   node returns its receipt without applying the command twice.
5. The consumer's node transports disconnect. An authoritative write occurs while it is offline.
   Reconnection catches up into the same Store and the original subscription continues.

The oracle checks the exact observed values, final state and Store identity. Consumer links use
real WebSockets; trusted mirror-to-authority links stay in-process. This is not a multi-process
partition or consensus proof. Existing replica/failover/socket oracles cover additional layers.

Transport construction, connection cleanup, credential verification and selection of the current
write session remain host responsibilities. The example makes that code explicit: the cluster
client currently routes replicated reads, not arbitrary domain writes.

## Type from the source

For a small ordinary RPC facade, derive everything from the implementation:

```ts
import {Observe, createRpcClient} from 'wenay-common2'

function createCounter() {
    const store = Observe.createStore({value: 0})
    return {
        store,
        control: {
            add(delta: number) {
                store.state.value += delta
                return store.state.value
            },
        },
        view: {read: () => store.snapshot()},
        events: {changed: store.listen()},
    }
}

const counter = createCounter()
const facade = {control: counter.control, view: counter.view, events: counter.events}
type CounterFacade = typeof facade
// The host supplies socket; serve the same facade with createRpcServerAuto.
const client = createRpcClient<CounterFacade>({socket, socketKey: 'counter'})
const value: number = await client.func.control.add(1)
const snapshot: {value: number} = await client.func.view.read()
```

For auth, follow [`RPC-AUTH.md`](RPC-AUTH.md): serve protected commands through the principal's
facade, with an empty initial object and `gate: true`. The example above describes types, not an
authorization policy. The journey oracle includes the token and principal setup.

`type-tests/store-through-types.ts` (repository checkout) verifies local node
and mask inference, ordinary RPC results and authority command names/inputs/results, including
negative compiler assertions. `demo/mini-scale-demo.ts` uses source-derived facade types rather
than `r<any>`; mirror commands live under the actual `miniScale` wrapper.

## Snapshot test doubles

Since 2.16, a snapshot reader tries the optional `chunks.begin/pull` facet before
`keyframe()`. `createReplicatedMap().api` offers that facet by default. A test double
such as `{...catalog.api, async keyframe() { ... }}` therefore retains another snapshot
path: successful chunk assembly bypasses the replacement `keyframe`, including its
delay, counter or injected error. A test waiting for that replacement can time out even
though the mirror is already ready.

When the test intends to intercept `keyframe`, hide `chunks` on the double:

```ts
// catalog, started and gate belong to the test fixture.
const delayedCatalog = {
    ...catalog.api,
    chunks: undefined,
    async keyframe() {
        started = true
        await gate
        return catalog.api.keyframe()
    },
}
```

Alternatively, keep the facet and pass `{chunkedKeyframe: false}` to
`followReplicatedMap(remote, options)` or `syncStoreReplay(store, remote, options)`.
If the fixture creates the producer, use `createReplicatedMap({...deps, replay:
{...deps.replay, chunks: false}})`; the underlying Store producer supports
`exposeStoreReplay(store, {chunks: false})` as well. These existing controls select the
monolithic snapshot path; they do not change how that path reports errors. If the test
is about chunk transfer itself, intercept `chunks` rather than disabling it.

## State and subscription rules

### A reconciliation pass across `await`

`state` remains live even when saved in a local variable. Use `snapshot()` when a
calculation needs one detached input, including its nested arrays:

```ts
import {createStore} from 'wenay-common2/observe'

const store = createStore({worker: {activeOperation: 'op-1', pending: ['op-1']}})
const live = store.state
const snapshot = store.snapshot()
const nextUpdate = Promise.resolve().then(function updateDuringIo() {
    store.state.worker.pending.push('op-2')
    store.state.worker.activeOperation = 'op-2'
})
await nextUpdate

live.worker.pending                       // ['op-1', 'op-2']
live.worker.activeOperation               // 'op-2'
snapshot.worker.pending                   // ['op-1']
snapshot.worker.activeOperation           // 'op-1'
```

Use the snapshot to calculate a candidate action. Before a destructive external
operation, recheck the live operation identity, relevant revision and cancellation
state; if they changed, discard that candidate and schedule a fresh pass. A local
recheck still cannot make external IO atomic with a Store update. A snapshot supplies
neither a transaction across `await` nor distributed ownership/fencing.

### Replacing a parent while retaining nested reactive values

Since 2.21.2, assignment resolves Observe proxies in the incoming plain-object/array
graph **before** rebinding any destination path. This includes `state` assignment,
property definitions, `store.replace`/node replacement and initial Store input.
For example, ordinary history maintenance needs no per-item copying workaround:

```ts
store.state.article = {
    title: 'second',
    history: [...store.state.article.history, {title: 'first'}].slice(-20),
}
store.state.article.history[0].title = 'updated'
```

Proxy identity belongs to a **path**, not to an entity. A captured proxy and its
subscriptions survive replacement at the same path. After moving an element to another
branch or shifting array indices, obtain the element through its new path; a previously
captured index proxy does not follow the entity. Values placed in a replacement resolve
to their current raw objects before any of those paths change, including sibling swaps.

Admission adopts the supplied containers; it does not deep-clone the whole graph.
Nested Observe proxies in own data properties are replaced with their raw targets,
preserving descriptors, sparse arrays, null prototypes and ordinary repeated raw
references. Accessors retain their behavior and rich values remain opaque leaves.
The walk is iterative and cycle-aware; locally cyclic values remain supported by
`snapshot()` and do not loop during eager initialization. Wire formats still impose
their own data/serialization constraints, and cross-branch graph identity is not a
replication guarantee, as described below.

If an incoming **non-writable, non-configurable** data property contains a proxy,
admission throws a descriptive `TypeError` before changing the destination or the
submitted graph. It cannot replace that slot in place. Pass a detached mutable value
from `cloneStoreValue(input)` if a frozen wrapper must be reused as input. Plain frozen
data containing no proxies does not require this conversion. Mutations of external raw
references still bypass Store ownership and notifications.

### Surface contracts

| Surface | Contract |
| --- | --- |
| `state`, `get()`, node callbacks | Live values; object references are not historical snapshots |
| `snapshot()`, `cloneStoreValue()` | Detached copies; arrays keep holes/length, repeated rich values retain identity within one clone |
| Plain objects and arrays | Mutations through the reactive Store are observed and coalesced |
| Map, Set, Date, typed arrays, class instances | Opaque leaves; replace the value to publish a change, do not rely on in-place mutation |
| `on` / `once` / selections | Keep the returned unsubscribe; `once` detaches before invoking the callback; failed immediate callbacks clean up |
| Mirror `sync` unsubscribe | Stops queued pulls and discards results of a pull already in flight |
| Replica `close()` | Terminal even if election or handoff completes later |
| Offline `staleMs` | Freshness status updates even without a custom `onStale` callback |

Keep the original object passed to `createStore` under Store ownership. Mutating an external raw
reference bypasses its proxy and therefore notifications. A drain coalesces observations; it is
not a transactional rollback mechanism. `flushReactive` waits for scheduled observations, not for
all remote replicas to acknowledge a write.

For replicated state, use a tree of independent values and IDs for relationships. **Shared mutable
object identity across branches is not a distributed guarantee.** For example, `{a: shared,
b: shared}` followed by `state.a.n = 1` changes both raw branches locally, but a detached wire
consumer can receive only the patch for `a`. Store snapshots preserving repeated references does
not turn replay into a graph-identity protocol. Normalize it as `{entities: {id: value}, aId: 'id',
bId: 'id'}` or explicitly update independent branches.

Binary snapshots clone each view's visible bytes; do not depend on separate views retaining a
shared backing buffer. Class instances remain opaque in live state; their prototype behavior is
not a promise of the detached/network representation. For keys colliding with node methods such
as `get` or `replace`, use `node.at(key)`; known keys retain their value type; unknown keys remain a legacy escape hatch (`any`).

## Types across RPC and replicas

Store getters keep the full-state overload and mask-dependent result through RPC `func`, `strict`
and `pipe`:

```ts
const exposed = Observe.exposeStoreReplay(store)
const client = createRpcClient<typeof exposed.api>({socket, socketKey: 'store'})
const full = await client.func.get()
const selected = await client.func.get({counter: {value: true}})
const follower = Observe.createStoreFollower({remote: client.func.replay})
```

Replay sources, sessions, offers, followers and cluster connectors carry the source
state type. Destination initial state checks compatibility without widening to accommodate a
wrong source. Compatible extra source fields are allowed. Store nodes preserve the forwarded
command map, checking command names, arguments and results.

This metadata exists only in TypeScript: it adds no runtime symbol and no packet field.
It is not wire validation. Legacy untyped remotes and default any contracts still bypass these
checks; preserve inferred source types instead of annotating a remote with an untyped default.
The named read wrapper above remains valid, but is no longer needed for getter inference.

## Separate-process verification

Run `npm run test:scale-process`. An authority and two nodes start as separate OS processes,
with a consumer in the test process. The scenario checks real Socket.IO links, a killed node,
route failover, receipt reuse without a repeated mutation, offline catch-up and a restarted node
with a new PID. This verifies local process boundaries with one authority. It does not establish
quorum, split-brain safety or behavior under a partition between independent authorities.
