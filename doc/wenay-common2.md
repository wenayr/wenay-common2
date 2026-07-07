# wenay-common2 — BRIEF cheat sheet (notation)

> Root import: `import { ... } from "wenay-common2"`.
> Notation: `name(args: types) -> ret  // note`. Types are shown where they decide a correct call (callback shape,
> overloads, return). Short names are **canonical**; removed old names are listed in `NAMING_RENAMES.md`.
> Full surface → **`wenay-common2-rare.md`**. Code style → `CLAUDE.md`. Full RPC guide → `rpc.md`.

## ⭐ events — `listen` / `listenStore`
```
import { listen, listenStore, mapListen } from "wenay-common2"

listen<T>(opts?) -> [emit, listen]                   // pure event list: no local value storage, no current replay
emit(...args: T)                                     // dispatch event only
listen.on(cb: (...args: T) => void, {key?, cbClose?}) -> off
listen.once(cb, {key?}) -> off                       // one future event
listen.onClose(cb: () => void) -> off
listen.close()                                       // clear listeners + fire close hooks + teardown producer
listen.count() -> number

listenStore<T>({current, ...opts}) -> [emit, listen]
  // store wrapper: current() reads external store by reference; the listener does not keep its own value copy
listen.on(cb, {current: true}) -> off                // current store value first, then future events
listen.on(cb) -> off                                 // future events only
listen.once(cb, {current: true}) -> off              // one value from current store, if present; otherwise waits future event
listen.once(cb) -> off                               // one future event
listen.on(cb, {current: () => argsOrUndefined}) -> off

opts: { fast? = true, event?(t: 'add'|'remove', count, api), closeOn? }
```
```
mapListen<TIn, TOut>(src, map: (...a: TIn) => TOut | null, opts?) -> [emit, listen]   // map+filter (null skips); lazy subscribe
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
promiseProgress<T>(arr: (Promise<T> | (() => Promise<T>))[]) -> {
  onOk(cb), onError(cb), all() -> Promise<any[]>, allSettled(), items(), stats() -> { ok: number, error: number, count: number } }
  // factory entries start on .all()/.allSettled()/items() (once); .all() rejects like Promise.all — read aggregate progress via stats()
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
createRpcServerAuto({ socket: {emit, on}, object, socketKey: string, auth?, limits?, maxPerListen?, throttle?, opt?, replay?, replayOpts? }) -> { api, ... }
  // replay: false|'auto' (default)|'force' — facade members that are replay lines (replayListen) are exposed
  //   with BOTH surfaces under the SAME key: legacy plain-Listen path byte-for-byte + line/frameLine/since/keyframe/frame.
  //   Upgrading listen -> replayListen is a declaration-site-only change; the facade and clients don't move.
  // replayOpts: {pending?, highWater?, lowWater?, pollMs?} — per-connection lag gate for 'frame'-policy subscribers
  //   (pending defaults to socket.io writeBuffer; gates close on disconnect automatically). Replay lines are never throttled.
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
const [tick, ticks] = listen<[number]>()
createRpcServerAuto({ socket, object: { math: { add: (a, b) => a + b, ticks } }, socketKey: 'math' })
const hub = createRpcClientHub((t) => io(url, { auth: { t } }), (rpc) => ({ math: rpc<Api>('math') }))
const c = await hub.connect(token)               // c = facade of per-socketKey clients
await c.math.ready();  await c.math.func.add(2, 3)
const l = c.math.func as unknown as DeepSocketListen<Api>  // typed Listen projection; wrap as webListen(c.math) in app code
const off = l.ticks.on(v => console.log(v))                // canonical stream subscribe; off is callable and awaitable
off()                                                     // unsubscribe; .callback/.removeCallback are legacy compat, don't teach them
l.ticks.once(v => console.log(v))                         // one event, then auto-off

// replay upgrade — ONE WORD at the declaration site, everything below follows automatically:
// const [tick, ticks] = listen<[number]>()                                       // before
const [tick, ticks] = replayListen<[number]>({history: 1024, current: 'last'})    // after — same facade, same key
// legacy subscribers unchanged (byte-for-byte). Replay consumers now also get:
const sub = replaySubscribe(l.ticks, v => {}, {since: saved, onSeq: s => saved = s})  // catch-up + live, no gaps/dups
const sub2 = replaySubscribe(c.math.func.ticks, v => {})  // replay members project on func/strict directly — no cast needed
await l.ticks.frame(mySeq)                                // pull at YOUR pace (50ms timer etc.) — server condenses via the line's frame lambda
// full guide + examples → rpc.md; frame model / lag policies → 🎞️ recipe below and rare docs
```

## 🔁 Observe — reactive state + store/mirror API
> `import { Observe } from "wenay-common2"` or `import * as Observe from "wenay-common2/observe"`.
> This is the documented v2 reactive/store surface.
```
// coarse reactive object: subscribe to the fact that a subtree changed, then re-read current state
Observe.reactive<T extends object>(obj, opts?) -> T
Observe.onUpdate(node, cb: () => void) -> off
Observe.onUpdatePaths(node, cb: ({paths}) => void) -> off   // optional dirty paths, relative to node
Observe.flushReactive(node) -> Promise<void>
Observe.toRaw(node) -> raw value behind the proxy              // snapshots/serialization without touching lazy nodes
Observe.listenUpdate(node) -> Listen<void>                  // RPC bridge for coarse change notifications
Observe.listenUpdatePaths(node) -> Listen<{paths: PropertyKey[][]}>
opts: { drain?: "immediate"|"micro"|number|((flush)=>void), depth?, eager? }

// path-addressed store facade over reactive()
Observe.createStore<T extends object>(initial, opts?) -> Store<T>
store.state                                                   // reactive data object; write normally
store.node.path.to.leaf.get()/snapshot()/replace(v)           // set(v) is a deprecated alias of replace(v)
store.node.path.to.leaf.on((value, ctx) => {}, {current?, drain?, key?}) -> off
store.node.path.to.leaf.once(cb, opts?) -> off
store.update(mask, opts?) -> selection                         // typed selected snapshot
selection.get() · selection.on((snap, ctx)=>{}, opts?) -> off · selection.onEach((value, ctx)=>{}, opts?) -> off
store.each(opts?) -> Listen<[key, value, ctx]>                 // changed TOP-LEVEL keys as a plain Listen — THE per-key feed
  // one call per CHANGED key per drain window: value = current store.state[key] at flush time; undefined = key deleted;
  //   two writes to one key in a window = ONE call (last value); deeper dirt (state.a.b = ...) reports 'a' once
  // root replace (store.replace / mirror keyframe) EXPANDS: one call per key of the new state + (key, undefined)
  //   per key the replace removed — cold start / reconnect are NOT special cases for per-key consumers
  // plain Listen shape (on(cb) -> off · once · count); zero cost while it has no subscribers
  // NOT update(true).onEach: onEach fires per SELECTED path, and mask true selects the root —
  //   ONE call per window with the whole dict (a dev warn points to each())
store.count() -> number

// network shape: backend exposes snapshots + changed Listen; frontend mirrors selected masks locally
Observe.exposeStore(store, opts?) -> { get(mask?), set(path,value), replace(path,value), changed, changedPaths, patches?, changedData? }
Observe.createStoreMirror(remote, initial, opts?) -> store & { sync(mask, opts?) -> Promise<off>; syncPatches(mask, opts?) -> Promise<off>; syncChangedData(mask, opts?) -> Promise<off> }
// changedPaths is optional optimization: mirror pulls mask ∩ dirty paths; fallback is changed -> get(mask).
// Optional push-data mode: exposeStore(store,{push:true}) + syncPatches/syncChangedData; details in rare docs.

// Sequenced sync (replay line): seq-numbered patch stream — keyframe catch-up, reconnect by seq (tail, not snapshot)
Observe.exposeStoreReplay(store, {history? = 1024}) -> { api /* spread into the RPC server object */, replay, close }
  // the patch line declares its condensing `frame` itself (last patch per exact path) — reconnect tails and
  //   lag recovery arrive as a mini-frame (changed paths only), zero config
Observe.syncStoreReplay(mirror, remote /*{line, since, keyframe, frame?} of api.replay*/, {since?, onSeq?}) -> off
  // off.ready (catch-up done) · off.seq() (save for reconnect: syncStoreReplay(..., {since: prev.seq()}))
  // lagging/late client NEVER gets a backlog: evicted seq -> ONE fresh keyframe + live
  // freshness is an option, not consumer boilerplate: {staleMs, onStale} flags a silent line / stale keyframe (edge-triggered both ways; 🎞️ in rare docs)
Observe.syncStoreReplayEach<T>(remote, (key, value, ctx) => {}, opts?) -> off & {store, ready, seq(), isStale(), lastTs()}
  // one-call remote fold: mirror store + syncStoreReplay + store.each() — the callback fires per CHANGED
  //   top-level key; first delivery = keyframe EXPANDED per key; (key, undefined) = key deleted
  // opts = all replaySubscribe opts (since/onSeq/policy/staleMs/onStale/onError...) + {drain?, initial?}
  // off() tears down BOTH the store sub and the wire sub; direct reads via off.store.state.KEY
  // reconnect: syncStoreReplayEach(remote, cb, {since: prev.seq(), initial: prev.store.snapshot()})
  //   — the tail lands ON TOP of the previous state (a fresh empty mirror would not converge)
// Offline persisted mirror (snapshot mode): local cache first, then replay catch-up by seq
Observe.createOfflineStore({key, remote?, initial, storage, version?, debounceMs?, syncOpts?}) -> Promise<store & {ready, flush(), close(), status(), statusListen, reconnect(remote)}>
Observe.persistStore(store, {key, storage, seq?, debounceMs?}) -> {flush, forceFlush, close, setSeq, seq, status, statusListen}
Observe.createMemoryOfflineStorage(initial?) -> OfflineStorage
  // persists {version, seq, snapshot, savedAt}; seq is the correctness coordinate, timestamps are UX/freshness only
  // mode:'topLevel' is reserved; first implemented mode is snapshot

// Declarative resource manager above mirror/replay/offline: app chooses what to start, not the store core
Observe.managedStore.mirror({remote, initial, mask, tags?, priority?, explicitOnly?, large?, sync?})
Observe.managedStore.replay({remote, initial, tags?, priority?, explicitOnly?, large?, syncOpts?})
Observe.managedStore.offline({remote?, initial, storage, storageKey?, tags?, priority?, explicitOnly?, large?, syncOpts?})
Observe.createStoreManager(resources) -> {plan(opts?), start(key, opts?), startPlanned(opts?), stop(key), stopAll(), get(key), touch(key, weight?), usage(), statusListen, handles}
  // plan excludes explicitOnly/large by default; {includeExplicit, includeLarge} opts opt them in
// Slow-client conflation: recipe section 🎞️ below. Full generic surface (any event line, history/time-travel) -> Replay namespace, 🎞️ in rare docs.
// Object add/delete/deep set are paths. Array mutation dirties the whole array branch, not splice internals.
```
```
type Market = {data: {BTC?: number; ETH?: number}; meta: {status?: string}}
const market = Observe.createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: "ok"}})

market.state.data.BTC = 3                                      // plain local mutation
market.node.data.BTC.on((v, ctx) => {}, {current: true})        // ctx.path = ["data", "BTC"]
market.node.data.on(data => {}, {current: true, drain: 50})     // branch snapshot, per-sub drain
market.update({data: {BTC: true, ETH: true}}, {current: true}).on(snap => {})

// backend facade over RPC
const api = Observe.exposeStore(market)

// frontend mirror: UI subscribes to local mirror, not RPC directly
const mirror = Observe.createStoreMirror<Market>(api, {data: {}, meta: {}})
const stop = await mirror.sync({data: {BTC: true}, meta: {status: true}}, {current: true, drain: 250})  // uses changedPaths when available
mirror.node.data.BTC.on(v => {}, {current: true})
stop()

// per-key feed — dict store -> grid rows; keyframe / reconnect are just expansion, not special cases
type Rows = Record<string, {qty: number}>
const rows = Observe.createStore<Rows>({})
const offRows = rows.each().on((key, row) => { /* row === undefined ? removeRow(key) : upsertRow(key, row) */ })

// the same per-key contract over the wire — ONE call (mirror store + syncStoreReplay + each)
const exposed = Observe.exposeStoreReplay(rows, {history: 1024})   // server side: spread exposed.api into the RPC object
const feed = Observe.syncStoreReplayEach<Rows>(exposed.api.replay, (key, row) => {}, {drain: "micro"})
await feed.ready                                   // catch-up done: keyframe arrived expanded per key
feed.store.state                                   // the mirror — direct reads / extra subscriptions
feed()                                             // tears down the store sub AND the wire sub
// reconnect later: syncStoreReplayEach(remote, cb, {since: feed.seq(), initial: feed.store.snapshot()})
// offline persisted mirror — cached snapshot first, then replay catch-up over the same remote
const offline = await Observe.createOfflineStore<Rows>({
    key: "rows",
    remote: exposed.api.replay,
    initial: {},
    storage: Observe.createMemoryOfflineStorage(), // use IndexedDB/SQLite adapter in an app
    debounceMs: 250,
})
offline.each().on((key, row) => {})
await offline.ready
await offline.flush()
offline.close()

// configurable app-level resource plan
const manager = Observe.createStoreManager({
    market: Observe.managedStore.mirror({remote: api.market, initial: {data: {}, meta: {}}, mask: {data: {BTC: true}}, tags: ['bootstrap'], priority: 10}),
    rows: Observe.managedStore.offline({remote: exposed.api.replay, initial: {}, storage: Observe.createMemoryOfflineStorage(), tags: ['grid']}),
    video: Observe.managedStore.replay({remote: videoReplay, initial: {}, explicitOnly: true, large: true}),
})
await manager.startPlanned({tags: ['bootstrap']})
manager.touch('rows', 3)               // usage can raise future plan score
await manager.start('video', {explicit: true})
```
Runnable example: `npx tsx observe/store-mirror.example.ts`.
Offline oracles: `npx tsx replay/offline-store.test.ts`; real Socket.IO/RPC wire: `npx tsx replay/offline-store-socket.test.ts`.

## 🎞️ Fast ticks vs slow client — replay lines + server-owned lag gate (recipe)
> The problem: the producer emits faster than a bad link drains. Naive streaming grows an unbounded
> outgoing queue per slow client. The replay stack solves it with ONE mental model — the FRAME:
> `frame(sinceSeq, hint?)` on the line returns envelopes bringing a consumer from `sinceSeq` to now,
> as compact as the line allows (exact tail -> condensed mini-frame -> keyframe fallback). The same
> method serves reconnect (`since`), client pull (own pace) and lag recovery. The transport sees only
> `seq`; ALL event semantics live in two lambdas declared on the line: `current` (keyframe = pointer
> to truth) and `frame` (condenser — may honor a client-supplied `hint`, see below).
```ts
import { Observe, Replay } from 'wenay-common2'

// ---- producer: declare what the line HAS (its class follows — no mode flags) ----
const [emitQuote, quotes] = Replay.replayListen<[string, number]>({
    history: 4096,
    frame: (tail, hint) => lastPerSymbol(tail, hint),  // mini-frame; hint = client's pick of the condensation rule
})   // current+frame = condensable · current only = keyframe recovery · neither = sacred queue (never skipped, loud on eviction)
// store lines: exposeStoreReplay already declares current + frame (last patch per path) — zero config
const store = Observe.createStore<World>(initial, { drain: 'micro' })
const exposed = Observe.exposeStoreReplay(store, { history: 1024 })

// ---- per CONNECTION: the rpc server owns the gate; the facade does NOT change ----
io.on('connection', socket => {
    const [disconnect, disconnectListen] = listen<[]>()
    socket.on('disconnect', () => disconnect())
    createRpcServerAuto({
        socket: { emit: (k, d) => socket.emit(k, d), on: (k, cb) => socket.on(k, cb) },
        socketKey: 'world',
        object: { ...exposed.api, quotes },       // replay lines auto-exposed: both surfaces, same key
        disconnectListen,                          // gates close on disconnect automatically
        replayOpts: { highWater: 64, lowWater: 8 },// arms frameLine; pending defaults to socket.io writeBuffer
    })
})

// ---- client: picks its LAG POLICY per subscription; no conflation logic anywhere ----
const sub = Replay.replaySubscribe(deep.quotes, cb, {since: saved, policy: 'frame'}) // server may skip; drain -> mini-frame
const sub2 = Replay.replaySubscribe(deep.quotes, cb2, {since: saved})                // 'queue' (default): nothing ever skipped
// own pace (e.g. 50ms skips + condensation): pull on YOUR timer — hint picks the rule, server condenses:
//   every(50, async () => { for (const ev of await deep.quotes.frame(mySeq, hint)) apply(ev); })
// store mirror: Observe.syncStoreReplay(mirror, deep.replay, {since: prev.seq()}) — same contract
// delivery contract: FIRST delivery = snapshot/tail start (same event type), then strictly-newer,
// seq-ascending, deduped; reconnect via {since} = mini-frame/tail, not a full snapshot
```
Rules that make it correct (violating any of these silently breaks convergence):
- **The line declares its recovery sources.** `current` (keyframe: SAMPLED from truth, never computed
  from deltas; `'last'` = last envelope for single-entity lines) and/or `frame` (condenser). A line
  with neither is a sacred queue: full tails only, evicted journal -> `frame()` THROWS (loud) — a
  lagging `'frame'`-policy subscriber gets a stream end, never silent loss.
- **A `frame` result must be state-equivalent to the tail it replaces** (per the line's own semantics).
  "Can't condense THIS tail" is legal and simple: return the tail as-is. Refuse-loudly is `throw`.
  Multiple condensation standards live INSIDE the lambda, dispatched by the client-supplied `hint`
  (opaque to the transport): `frame(tail, hint)`.
- **Events must be ABSOLUTE per their entity** for last-per-entity condensing (store patches are).
- Gate drops never hole the journal — it is written BEFORE any gate. Reconnect via `{since}` still
  gets everything; only an evicted `history` window degrades to keyframe (visible as a seq jump).
- `pending()` and the watermarks share units (bytes, packets, frames — anything, but the same).

Manual path (pre-rev2, still works, `keyOf` @deprecated): build the gate yourself with
`Replay.conflateReplay(exposed.replay, {pending, highWater, keyOf})` and spread `gated.api` into the
facade — details in rare docs. New code should declare `frame` on the line instead.

Wire-level proof/oracles: `npx ts-node replay/rpc-auto.test.ts` (real Socket.IO: auto-exposure, legacy
parity, frame equivalence, gate lag sim), plus `replay/conflate-socket.test.ts`, `replay/conflate.test.ts`,
`replay/coalesce.test.ts`. Full generic surface (history/time-travel, archive) → 🎞️ in rare docs.



