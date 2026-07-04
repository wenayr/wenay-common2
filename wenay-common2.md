# wenay-common2 — BRIEF cheat sheet (notation)

> Root import: `import { ... } from "wenay-common2"`.
> Notation: `name(args: types) -> ret  // note`. Types are shown where they decide a correct call (callback shape,
> overloads, return). Short names are **canonical**; older long names are `@deprecated` (listed as `// alias:`).
> Full surface → **`wenay-common2-rare.md`**. Code style → `CLAUDE.md`. Full RPC guide → `rpc.md`.

## ⭐ events — `ListenNext` / `Listen2`
```
import { ListenNext } from "wenay-common2"                 // namespace export, no conflict with old Listen.ts
import { UseListenStore } from "wenay-common2/listen2"      // direct v2 subpath

ListenNext.UseListen<T>(opts?) -> [emit, listen]            // pure event list: no local value storage, no current replay
emit(...args: T)                                            // dispatch event only
listen.on(cb: (...args: T) => void, {key?, cbClose?}) -> off
listen.once(cb, {key?}) -> off                              // one future event
listen.onClose(cb: () => void) -> off
listen.close()                                              // clear listeners + fire close hooks + teardown producer
listen.count() -> number

ListenNext.UseListenStore<T>({current, ...opts}) -> [emit, listen]
  // store wrapper: current() reads external store by reference; the listener does not keep its own value copy
listen.on(cb, {current: true}) -> off                       // current store value first, then future events
listen.on(cb) -> off                                        // future events only
listen.once(cb, {current: true}) -> off                     // one value from current store, if present; otherwise waits future event
listen.once(cb) -> off                                      // one future event
listen.on(cb, {current: () => argsOrUndefined}) -> off      // per-subscription current getter overrides wrapper current

opts: { fast? = true, event?(t: 'add'|'remove', count, api), addListenClose? }
// Old root `UseListen` from `Listen.ts` is kept for compatibility/comparison. New store-current work lives in `ListenNext` / `listen2`.
```
```
UseListenTransform<TIn, TOut>(src, map: (...a: TIn) => TOut | null, opts?) -> [emit, listen]   // map+filter (null skips); lazy subscribe
joinListens(listens | ports, keyExtractor?) -> { listen, add(port, key?), pending: number, clear(tid?) }   // zip by key
```
## ⭐ sleep
```
sleepAsync(ms = 0) -> Promise<void>
```

## ⏱️ async
```
createThrottle() -> { throttle(ms: number, fn: () => void) -> void,
                      debounce(ms: number, fn: () => void) -> Promise<void> }
  // fn is a ZERO-ARG thunk the scheduler runs itself; NOT a lodash-style wrapper that returns a callable
  // ONE createThrottle() = ONE shared limiter (shared busy/pending) — use a SEPARATE instance per operation;
  //   throttle + debounce on the SAME instance contend (a busy throttle silently drops the debounce's trailing run)
createAsyncQueue(concurrency = 1) -> { add<R>(task: () => Promise<R>) -> Promise<R>, onIdle() -> Promise<void>, size: number }   // p-queue
createReadyGate() -> { add(fn: () => void), ready() }                  // buffer fns until ready(), then run them in order
PromiseArrayListen<T>(arr: (Promise<T> | (() => Promise<T>))[]) -> {
  listenOk(cb), listenError(cb), promise: { all() -> Promise<any[]>, allSettled() }, getData(), status() -> { ok: number, error: number, count: number } }
  // factory entries start on .all()/.allSettled()/getData() (once); .all() NEVER rejects — read the real outcome via status()
// alias: enhancedWaitRun->createThrottle · createTaskQueue->createReadyGate(.setReady->.ready) · createAsyncQueue.enqueue->add · .getQueueSize->size
```

## 🧰 core — clone / compare
```
clone<T>(v: T) -> T            // deep: cycles + Map/Set/Date, rebinds functions      (alias: deepClone)
shallowClone<T>(v: T) -> T
isEqual(a, b) -> boolean       // PLAIN object/array trees ONLY; on Map/Set/Date it returns a vacuous `true` — don't use it on them   (alias: deepEqual)
shallowEqual(a, b) · arrayShallowEqual(a, b) -> boolean      // strict-by-key vs loose-by-index — both kept on purpose
toImmutable<T>(o: T) -> T      // deep-frozen clone + Mutable:false marker
JSON_clone<T>(o: T) -> T       // JSON round-trip; DROPS Map/Set (-> {}) and turns Date -> string. NOT a rich clone — use clone() for those
```

## 🧰 core — binary search / maps / mutex / memo
```
BSearch<T>(arr: ArrayLike<T>, value: T | comparer, match?: 'equal'|'lessOrEqual'|'greatOrEqual', sort?: SortMode) -> number
  // comparer is (item: T) => number  OR  (a: T, b) => number; without it, T must have valueOf():number
BSearchNearest<T>(arr: ArrayLike<T>, value: number, getter?: (el: T) => number, maxDelta?: number) -> number
new MapExt<K,V>() / new WeakMapExt<K,V>():  .getOrSet(k, () => v) -> V          // lazy insert (a plain value is also accepted)
new Mutex():  .runExclusive<T>(fn: () => T | Promise<T>) -> Promise<T>   |   .lock() -> Promise<release: () => void>   // runExclusive: was dispatch
MemoFunc<A extends any[], R>(opts?: { timeDelta?: number, maxLimits?: number }) -> { func(...a: A) -> R, cleanAll(), memo }   // TTL + LRU; per-call {timeDelta, reSave}
```

## 🔢 core — number (frequent)
```
round(value: number, digits = 0) -> number                  // round to N decimals          (alias: NormalizeDouble)
roundSig(value: number, { digitsR?: number /*total significant digits*/, digitsPoint? = 4, type?: 'max'|'min' }) -> number
  // round to N significant digits — roundSig(1234.5678, {digitsR: 3}) -> 1230     (alias: NormalizeDoubleAnd)
gcd(a: number, b: number, digits = 8) -> number   |   gcd(values: Iterable<number>, digits = 8) -> number
  // floats ok; in the ITERABLE overload the 2nd arg is PRECISION digits, not an operand   (alias: MaxCommonDivisor[OnArray])
formatAuto(value: number, maxDigits = 8) -> string          // shortest decimal string      (alias: DblToStrAuto)
decimals(value: number, maxDigits = 8, minDigits = 0) -> number   // count of meaningful decimals (alias: GetDblPrecision)
```

## ⏰ time
```
format(date: Date, pattern, { utc? = true }) -> string     // (alias of 11 timeToStr_*/timeLocalToStr_*)
  pattern: 'HH:mm:ss' | 'HH:mm:ss.SSS' | 'yyyy-MM-dd'
         | 'yyyy-MM-dd HH:mm' | 'yyyy-MM-dd HH:mm:ss' | 'yyyy-MM-dd HH:mm:ss.SSS'
         | 'yyyy-MM-dd HH:mm O' | 'yyyy-MM-dd HH:mm:ss O'   // O = GMT offset (local)
  { utc: false } -> local variants
formatDuration(ms: number, pattern?: 'H:mm:ss' | 'H:mm:ss.SSS') -> string   // clock; hours unbounded
durationToStr(ms: number) -> string                        // humanized
minDate(a: Date | null, b: Date | null) / maxDate(a, b) -> Date | null      // null-tolerant   (alias: MinTime/MaxTime)
convertDatesToStrings(obj)                                 // Date -> strings, recursively (logs)
const:  H1_S D1_S W1_S · M1_MS H1_MS D1_MS W1_MS
```

## 🌐 rpc (brief) — transport is ALWAYS caller-supplied (`{emit,on}`); there is NO url / built-in socket
```
// SERVER: `object` is the impl tree, `socket` is a {emit,on} transport adapter
createRpcServerAuto({ socket: {emit, on}, object, socketKey: string, auth?, limits?, maxPerListen?, throttle?, opt? }) -> { api, ... }
createRpcServer(opts)        // lower-level core (same { socket, object, socketKey })
noStrict(obj)                // mark a dynamic subtree (no schema)
endCallback(fn)              // mark an RPC stream-callback's end   (alias: rpcEndCallback)

// CLIENT hub: takes TWO functions — a socket factory + a schema builder; it is NOT an {url} or an options bag
createRpcClientHub(
  createSocket: (token: string | null) => socket,             // YOU build the socket, e.g. socket.io io(url, {auth:{token}})
  schemaBuilder: (rpc) => ({ key: rpc<Api>('socketKey') }),   // declare each socketKey's typed API
  hubOpts?: { opt? },
) -> hub
hub:     connect(token) -> Promise<clients>  ·  reauth(token)  ·  facade  ·  promise  ·  socket  ·  onConnect/onDisconnect   // connect: was setToken
         // connect()'s promise resolves on the socket's 'connect' event; for in-proc/loopback (no 'connect') use hub.facade + await hub.promise
client (on clients[key], NOT on the hub):  func (proxy) · strict (schema-safe) · close() · ready() · init() · subscriptions()
         // pipe = batch a server chain in one packet · space = fire-and-forget

// minimal wiring (the part no signature can show):
const [tick, ticks] = UseListen<[number]>()
createRpcServerAuto({ socket, object: { math: { add: (a, b) => a + b, ticks } }, socketKey: 'math' })
const hub = createRpcClientHub((t) => io(url, { auth: { t } }), (rpc) => ({ math: rpc<Api>('math') }))
const c = await hub.connect(token)               // c = facade of per-socketKey clients
await c.math.ready();  await c.math.func.add(2, 3)
const l = c.math.func as unknown as DeepSocketListen<Api>  // typed Listen projection; wrap as webListen(c.math) in app code
const off = l.ticks.on(v => console.log(v))                // canonical stream subscribe; off is callable and awaitable
off()                                                     // unsubscribe; .callback/.removeCallback are legacy compat, don't teach them
l.ticks.once(v => console.log(v))                         // one event, then auto-off
// full guide + examples → rpc.md
```

## 🔁 ObserveAll2 — reactive state + store/mirror API
> `import { ObserveAll2 } from "wenay-common2"` or `import * as ObserveAll2 from "wenay-common2/observe-all2"`.
> This is the documented v2 reactive/store surface.
```
// coarse reactive object: subscribe to the fact that a subtree changed, then re-read current state
ObserveAll2.reactive<T extends object>(obj, opts?) -> T
ObserveAll2.onUpdate(node, cb: () => void) -> off
ObserveAll2.onUpdatePaths(node, cb: ({paths}) => void) -> off   // optional dirty paths, relative to node
ObserveAll2.flushReactive(node) -> Promise<void>
ObserveAll2.toRaw(node) -> raw value behind the proxy              // snapshots/serialization without touching lazy nodes
ObserveAll2.listenUpdate(node) -> Listen<void>                  // RPC bridge for coarse change notifications
ObserveAll2.listenUpdatePaths(node) -> Listen<{paths: PropertyKey[][]}>
opts: { drain?: "immediate"|"micro"|number|((flush)=>void), depth?, eager? }

// path-addressed store facade over reactive()
ObserveAll2.createStore<T extends object>(initial, opts?) -> Store<T>
store.state                                                   // reactive data object; write normally
store.node.path.to.leaf.get()/snapshot()/replace(v)           // set(v) is a deprecated alias of replace(v)
store.node.path.to.leaf.on((value, ctx) => {}, {current?, drain?, key?}) -> off
store.node.path.to.leaf.once(cb, opts?) -> off
store.update(mask, opts?) -> selection                         // typed selected snapshot
selection.get() · selection.on((snap, ctx)=>{}, opts?) -> off · selection.onEach((value, ctx)=>{}, opts?) -> off
store.count() -> number

// network shape: backend exposes snapshots + changed Listen; frontend mirrors selected masks locally
ObserveAll2.exposeStore(store, opts?) -> { get(mask?), set(path,value), replace(path,value), changed, changedPaths, patches?, changedData? }
ObserveAll2.createStoreMirror(remote, initial, opts?) -> store & { sync(mask, opts?) -> Promise<off>; syncPatches(mask, opts?) -> Promise<off>; syncChangedData(mask, opts?) -> Promise<off> }
// changedPaths is optional optimization: mirror pulls mask ∩ dirty paths; fallback is changed -> get(mask).
// Optional push-data mode: exposeStore(store,{push:true}) + syncPatches/syncChangedData; details in rare docs.
// Object add/delete/deep set are paths. Array mutation dirties the whole array branch, not splice internals.
```
```
type Market = {data: {BTC?: number; ETH?: number}; meta: {status?: string}}
const market = ObserveAll2.createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: "ok"}})

market.state.data.BTC = 3                                      // plain local mutation
market.node.data.BTC.on((v, ctx) => {}, {current: true})        // ctx.path = ["data", "BTC"]
market.node.data.on(data => {}, {current: true, drain: 50})     // branch snapshot, per-sub drain
market.update({data: {BTC: true, ETH: true}}, {current: true}).on(snap => {})

// backend facade over RPC
const api = ObserveAll2.exposeStore(market)

// frontend mirror: UI subscribes to local mirror, not RPC directly
const mirror = ObserveAll2.createStoreMirror<Market>(api, {data: {}, meta: {}})
const stop = await mirror.sync({data: {BTC: true}, meta: {status: true}}, {current: true, drain: 250})  // uses changedPaths when available
mirror.node.data.BTC.on(v => {}, {current: true})
stop()
```
Runnable example: `npx tsx observable2/store-mirror.example.ts`.



