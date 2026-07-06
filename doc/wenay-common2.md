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
createRpcServerAuto({ socket: {emit, on}, object, socketKey: string, auth?, limits?, maxPerListen?, throttle?, opt?, replay?, replayOpts? }) -> { api, ... }
  // replay: false|'auto' (default)|'force' — facade members that are replay lines (UseReplayListen) are exposed
  //   with BOTH surfaces under the SAME key: legacy plain-Listen path byte-for-byte + line/frameLine/since/keyframe/frame.
  //   Upgrading UseListen -> UseReplayListen is a declaration-site-only change; the facade and clients don't move.
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
const [tick, ticks] = UseListen<[number]>()
createRpcServerAuto({ socket, object: { math: { add: (a, b) => a + b, ticks } }, socketKey: 'math' })
const hub = createRpcClientHub((t) => io(url, { auth: { t } }), (rpc) => ({ math: rpc<Api>('math') }))
const c = await hub.connect(token)               // c = facade of per-socketKey clients
await c.math.ready();  await c.math.func.add(2, 3)
const l = c.math.func as unknown as DeepSocketListen<Api>  // typed Listen projection; wrap as webListen(c.math) in app code
const off = l.ticks.on(v => console.log(v))                // canonical stream subscribe; off is callable and awaitable
off()                                                     // unsubscribe; .callback/.removeCallback are legacy compat, don't teach them
l.ticks.once(v => console.log(v))                         // one event, then auto-off

// replay upgrade — ONE WORD at the declaration site, everything below follows automatically:
// const [tick, ticks] = UseListen<[number]>()                                       // before
const [tick, ticks] = UseReplayListen<[number]>({history: 1024, current: 'last'})    // after — same facade, same key
// legacy subscribers unchanged (byte-for-byte). Replay consumers now also get:
const sub = replaySubscribe(l.ticks, v => {}, {since: saved, onSeq: s => saved = s})  // catch-up + live, no gaps/dups
await l.ticks.frame(mySeq)                                // pull at YOUR pace (50ms timer etc.) — server condenses via the line's frame lambda
// full guide + examples → rpc.md; frame model / lag policies → 🎞️ recipe below and rare docs
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

// Sequenced sync (replay line): seq-numbered patch stream — keyframe catch-up, reconnect by seq (tail, not snapshot)
ObserveAll2.exposeStoreReplay(store, {history? = 1024}) -> { api /* spread into the RPC server object */, replay, close }
  // the patch line declares its condensing `frame` itself (last patch per exact path) — reconnect tails and
  //   lag recovery arrive as a mini-frame (changed paths only), zero config
ObserveAll2.syncStoreReplay(mirror, remote /*{line, since, keyframe, frame?} of api.replay*/, {since?, onSeq?}) -> off
  // off.ready (catch-up done) · off.seq() (save for reconnect: syncStoreReplay(..., {since: prev.seq()}))
  // lagging/late client NEVER gets a backlog: evicted seq -> ONE fresh keyframe + live
  // freshness is an option, not consumer boilerplate: {staleMs, onStale} flags a silent line / stale keyframe (edge-triggered both ways; 🎞️ in rare docs)
// Slow-client conflation: recipe section 🎞️ below. Full generic surface (any event line, history/time-travel) -> Replay namespace, 🎞️ in rare docs.
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

## 🎞️ Fast ticks vs slow client — replay lines + server-owned lag gate (recipe)
> The problem: the producer emits faster than a bad link drains. Naive streaming grows an unbounded
> outgoing queue per slow client. The replay stack solves it with ONE mental model — the FRAME:
> `frame(sinceSeq, hint?)` on the line returns envelopes bringing a consumer from `sinceSeq` to now,
> as compact as the line allows (exact tail -> condensed mini-frame -> keyframe fallback). The same
> method serves reconnect (`since`), client pull (own pace) and lag recovery. The transport sees only
> `seq`; ALL event semantics live in two lambdas declared on the line: `current` (keyframe = pointer
> to truth) and `frame` (condenser — may honor a client-supplied `hint`, see below).
```ts
import { ObserveAll2, Replay } from 'wenay-common2'

// ---- producer: declare what the line HAS (its class follows — no mode flags) ----
const [emitQuote, quotes] = Replay.UseReplayListen<[string, number]>({
    history: 4096,
    frame: (tail, hint) => lastPerSymbol(tail, hint),  // mini-frame; hint = client's pick of the condensation rule
})   // current+frame = condensable · current only = keyframe recovery · neither = sacred queue (never skipped, loud on eviction)
// store lines: exposeStoreReplay already declares current + frame (last patch per path) — zero config
const store = ObserveAll2.createStore<World>(initial, { drain: 'micro' })
const exposed = ObserveAll2.exposeStoreReplay(store, { history: 1024 })

// ---- per CONNECTION: the rpc server owns the gate; the facade does NOT change ----
io.on('connection', socket => {
    const [disconnect, disconnectListen] = UseListen<[]>()
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
// store mirror: ObserveAll2.syncStoreReplay(mirror, deep.replay, {since: prev.seq()}) — same contract
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



