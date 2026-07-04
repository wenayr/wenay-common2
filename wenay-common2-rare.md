# wenay-common2 — EXTENDED cheat sheet (notation)

> The full surface. For everyday helpers use **`wenay-common2.md`** (brief). Root import:
> `import { ... } from "wenay-common2"`. Notation: `name(args) -> ret  // note`. Short names are
> canonical; `// alias:` marks the older `@deprecated` long names (still exported, byte-for-byte).

## 🔔 events (rare)
```
new CObjectEventsArr<T>() / new CObjectEventsList<T>(log?=true)        // handler collections
  .add(item, {at?:'start'|'end'})   // item: { func?, func2?, del?, OnDel? }; default end (func2 = run-once-then-del)
  .emit(data?) · .clear() · get size · .OnSpecEvent(fn)
  // alias: Add/AddEnd->add · AddStart->add(_, {at:'start'}) · OnEvent->emit · Clean->clear · count/length->size
  // CObjectEventsList warns at >20 subscriptions (leak detector)

ListenNext namespace / `wenay-common2/listen2` subpath:
funcListenCore<T>(opts?) -> core               // minimal hot path: func/addListen/removeListen/on/once/close/count/getAllKeys
funcListenCallbackBase<T>(producer, opts?) -> full
  // full = core + producer lifecycle + close hooks + cbClose + addListenClose; output type is `ReturnType<typeof funcListenCallbackBase<T>>`
funcListenCallback = funcListenCallbackBase · funcListenCallbackFast<T>(producer)
UseListen<T>(opts?) -> [emit, full]            // pure event list: no value storage/current replay
UseListen2<T>(opts?) -> [emit, slim]           // slim view: on/close/count only
withStoreListen(full, currentGetter) -> storeListen
UseListenStore<T>({current,...opts}) -> [emit, storeListen]
  // storeListen stores only the current getter reference, not store values

full Listen: .on(cb,{key?,cbClose?})->off · .once(cb,{key?})->off · .onClose(cb)->off · .close() · .count()
store Listen: .on(cb,{current?:true|()=>args,key?,cbClose?})->off · .once(cb,{current?:true|()=>args,key?})->off
slim Listen2: .on(cb,{key?})->off · .close() · .count()
// deprecated compat on full: .addListen/.removeListen/.eventClose/.removeEventClose; new code keeps the off() returned by on/once/onClose.
```
External current getter example:
```
const [emit, listen] = ListenNext.UseListenStore<[Market]>({
  current: () => store.node.has() ? [store.node.snapshot()] : undefined,
})
listen.on(cb, {current: true})       // current store value first, then future emit(...) events
listen.once(cb, {current: true})     // current store value once, or waits for one future event if current() returns undefined
```
Old `Listen.ts` remains exported from root for compatibility and comparison; new split implementation is in `Listen2.ts`.
```
isListenCallback(obj) -> boolean                  // duck-type a funcListenCallback* result
socketBuffer3(...) · funcListenCallbackSnapshot(...)   // snapshot/buffer adapters over a realSocket2
```
## 🔢 number formatting & math (full)
```
round(value, digits=0)                            // alias: NormalizeDouble
roundSig(value, {digitsPoint?, digitsR?, type?: 'max'|'min'})           // alias: NormalizeDoubleAnd
formatAuto(value, maxDigits=8) -> string          // alias: DblToStrAuto  (negative maxDigits = significant digits)
formatSig(value, {digitsPoint?, digitsR?, type?}) -> string             // alias: DblToStrAnd (pairs with roundSig)
decimals(value, maxDigits=8, minDigits=0) -> number                     // alias: GetDblPrecision / GetDblPrecision2
gcd(a, b, digits?=8) | gcd(values: Iterable<number>, digits?=8)         // alias: MaxCommonDivisor / MaxCommonDivisorOnArray
CorrelationRollingByBuffer(data)                  // rolling Pearson correlation over a ring buffer
```

## 🗺️ niche data structures
```
class MyMap<K extends {valueOf():number}, V>      // sorted keys
  .set/.get/.has/.delete/.clear · get size · .clone()    // JS-Map surface
  // alias: Set/Get/Contains/Remove/Clear/Count->set/get/has/delete/clear/size · Clone->clone
  // (no keys()/values()/entries() — use getters: sortedKeys: readonly K[], Values: readonly V[])
class MyNumMap<V> extends MyMap<number,V>          // also indexable: map[5]=v / map[5]
class StructMap<TKey, TResult> { set/get/has/keys/values/entries }      // tuple / multi-part keys
class StructSet<TKey>          { add/has/keys/values }
class ArrayMap<TKey extends number|string, TVal> extends StructMap<readonly TKey[], TVal>
class ArraySet<TKey extends number|string>        extends StructSet<readonly TKey[]>
new VirtualItems<T>(getItem:(i)=>T, getLength:()=>number)               // lazy array via Proxy; indexable+iterable, .length
class CCachedValue2<TKey extends [any,any], TVal> { getOrSet(key, ()=>val) }   // recompute when any key element changes
class CObjectID<TObject, TOwner> { value:number; static getInfo/getObjectByOwner }   // opaque typed ids
```

## ⏳ cancellation & timers
```
class CancelablePromise<T> extends Promise<T> { constructor(exec, onCancel?); cancel(msg?); static resolve }
class CancelToken { get aborted; abort() }         // poll-only (NOT a full AbortSignal). alias: isCancelled->aborted · cancel->abort
createCancellableTimer(interval_ms, onTimer:()=>boolean|void, onStop?) -> CancelablePromise<never>   // onTimer()===false stops
createCancellableTaskWrapper<T>(task, isStopped, interval_ms=50)
class MyTimerInterval { constructor(period_ms, onTimer, onStop?); stop() }
```

## 🧭 object paths · linked list · byte stream
```
objectGet(obj, path:string[]) -> T                 // THROWS on missing/non-object segment   (alias: objectGetValueByPath)
objectSet(obj, path, value) -> void                                                          (alias: objectSetValueByPath)
objectUnset(obj, path) -> boolean                                                            (alias: objectDeleteValueByPath)
deepEntries(obj, filter?) -> Generator<[key, value, path]>                                   (alias: iterateDeepObjectEntries)

class CList<T> implements Iterable {
  get first/last · get size (=length/count) · push(v)/unshift(v) -> node · pop()/shift() -> T|undefined
  delete(valueOrNode)/deleteFirst()/deleteLast()/clear() · find(v)/findLast(v) · nodes()/reversedNodes()
}   // immutable views: IList<T>, IListReadonly<T>, IListImmutable<T>

class ByteStreamW / ByteStreamR                    // pushNumber(value, type)/readNumber(type) over NumericTypes union
nullable(type: NumericTypes)                       // typed push*/read* (int8..uint64/float/double) stay as extended surface
```

## 🎀 decorators
```
wrap(fn, { beforeParams?, modifyParams?, afterParams?, onResult?, modifyResult?, onCatch?, onFinally? }) -> (...args)=>R
  // hooks around a call (sync or async-aware). NOTE the error hook is `onCatch` (not onError). alias: enhancedDecorator
around(fn, ([args, fn]) => R) -> (...args) => R    // AOP around-advice, fn passed UN-CALLED (lodash _.wrap). alias: Transformer
// also @deprecated -> wrap/around: enhancedTransformer, Decorator, TransformerResult
```

## ⏰ timeframes & periods
```
class TF {                                          // S1, M1, H1, D1, ...
  static get(name) -> TF|null  ·  static getAsserted(name) -> TF  ·  static fromSec(sec)
  static createCustom(unit, count) · createCustomFromSec(sec) · readonly all · S1 S5 M1 M5 H1 D1 ...
  get sec/msec/name              // alias: fromName->get
}
class Period { get tf/index/startTime/endTime; static StartTimeForIndex(tf, index) }
class PeriodSpan · class CDelayer                   // deferred-run helper
durationToStr_h_mm_ss(ms) / _ms · durationToStrNullable(ms)   // (alias: -> formatDuration)
toPrintObject(obj)                                  // = convertDatesToStrings
```

## 🎨 color
```
rgb(r, g, b) -> ColorString
hue(value=180, count=100, index=1) -> ColorString          // distinct palette color   (alias: colorGeneratorByCount)
hueRGB(value=180, count=100, index=1) -> [r,g,b]                                          (alias: colorGeneratorByCount2)
toRGBA(str: ColorString) -> [r,g,b,a]  |  toRGBA(str: string) -> [r,g,b,a]|undefined      (alias: colorStringToRGBA)
toColorString(str) -> ColorString                          // validates, else throws
isSimilarColors(c1, c2, maxDelta=32) -> boolean
```

## 🖥️ console · proxy · id · rate-window · input
```
callerLine(lvl=0) -> "file:line:col  func"          // V8 caller frame   (alias: __LineFile2; __LineFile/__LineFiles->callerLines)
callerLines(start=0, end=5) -> string[]             // (alias: __LineFiles)
enable(flag=true) / disable()                       // clickable source links in console (IDE)
installProxyTracking()                              // call once at startup (browser fallback). isProxy(v)->boolean   (alias: isProxyInit)
createIdPool() -> { next() -> number, release(id) }                                       // reuses released ids
createRateWindow() -> { add(item), prune(type, ms?), sumWeight(type), readyAt(...), ...legacy }   // alias: funcTimeW
rateWindow                                          // shared default createRateWindow() instance   (= FuncTimeWait)
SetAutoStepForElement(el, { minStep?, maxStep? })   // browser input
copyToClipboard(text) -> Promise<void>  ·  GetEnumKeys(E)  ·  isDate(v)
```

## ⚠️ errors
```
class MyError<D> extends Error { toJSON() -> tWire<D> }     // wire-serializable error
toError = { ... }                                          // build/normalize MyError from unknown
```

## 🌐 rpc (full)
```
// servers
createRpcServerAuto(opts)                           // canonical: nested object -> typed client proxy (auto Listen handling)
createRpcServer(opts)                               // lower-level core
createRpcServerAuto2(opts)                          // + legacy/v2 protocol auto-detection (createRpcServerAutoWithProtocolDetection)
createRpcServerInProc(...)                          // in-process fast path (no socket)
// clients
createRpcClientHub(opts) + rpc                      // multiplexing client hub: connect(token)/reauth(token)/onConnect
  // alias: hub.setToken->connect
client members: func (proxy) · strict (schema-safe) · schema() · auth() · reauth() · onDisconnect()
                close(reason?, {socketAlive?}) · ready() · init(obj?) · api.subscriptions()
  // alias: dispose->close · readyStrict->ready · initStrict->init
noStrict(obj) / isNoStrict(obj)                     // dynamic (no-schema) subtree
endCallback(fn)                                     // alias: rpcEndCallback
// subscription primitives (rare/manual; createRpcServerAuto/createRpcClientHub are the normal path)
listenSocket(parent, opts?) · listenSocketFirst · listenSocketAll · listenSocketSmart
deepListenFirst(obj, opts?) · deepListenAll · deepListenSmart
RPC Listen surface on client: stream.on(cb)->off · stream.once(cb)->off · stream.close()
  // typed projection: client.func as unknown as DeepSocketListen<ServerFacade> (usually hidden behind a local webListen(client) helper).
  // off is callable + thenable: off() unsubscribes; await off waits for stream end. Legacy .callback/.removeCallback/.unsubscribe exist for old code only.
  // *First/*All/*Smart differ only in callback arity: first arg / all args / single-vs-tuple smart.
matchKeys(a,b) · matchKeysList(a, keys) · deepMapByKeys · deepMapByKeysList
// modes: func (proxy) · strict (schema-safe) · pipe (whole chain in one packet) · space (fire-and-forget)
// legacy (oldCommonsServer.ts, @deprecated forwarders onto oldСommonsServerMini — identical wire):
//   funcPromiseServer->promiseServer · funcForWebSocket->wsWrapper · funcScreenerClient2->createClientProxy
//   CreatAPIFacadeServerOld->createAPIFacadeServer ; CreatAPIFacadeClientOld & funcPromiseServer2 kept as-is
```

## 📈 exchange — params (`CParams`)
```
class CParams / CParamsReadonly implements IParams
toValues(params) -> SimpleParams                    // IParams -> plain enabled values   (alias: GetSimpleParams)
fromValues(infos, values) -> IParams                // inverse                            (alias: mergeParamValuesToInfos)
isSimpleParams(params) -> boolean                   // (isSimpleParams2 @deprecated)
isParamBase(p) · isParamGroup(p) · isParamGroupOrArray(p)
enableAllParams(params, enabled=true) -> clone
// types: IParam (the union) + IParamBase are the entry points; the per-flavour IParamNum/IParamEnum/IParamTime*/...
//        and *Readonly twins exist but read the union — wrap with ReadonlyFull<T> rather than the *Readonly aliases.
```

## 📈 exchange — bars (`Bars`)
```
class OHLC · class CBar extends CBarBase (IBar)
class CBars (IBarsImmutable) · class CBarsMutable / CBarsMutableExt (IBarsExt)
  .push(bars|bar)        // append            (alias: Add)
  .updateLast(bar) · .addTick(tick) · .addTicks(ticks)        (alias: AddTick/AddTicks)
createRandomBars(tf, startTime, endTime|count, startPrice?, volatility?, tickSize?) -> CBars   // alias: CreateRandomBars
class CTimeSeries<T=number> (ITimeseries) · CTimeSeriesReadonly<T>
findBarsShallow(srcBars, barsToFind) -> number
```

## 📈 exchange — market data (`MarketData`)
```
class CQuotesHistory
  .get(tf) -> IBarsImmutable|null                   // build-on-demand   (alias: Bars(tf))
class CQuotesHistoryMutable / CQuotesHistoryMutable2 extends CQuotesHistory
  .append(bars[, tf])    (alias: AddEndBars)  ·  .prepend(bars[, tf])   (alias: AddStartBars)
  .addTicks(ticks)       (alias: AddTicks; replaces last bar)  ·  AddNewTicks (strict append-only, rare)
  .deleteBefore(time)
```

## 🧩 server / socket helpers
```
SocketServerHook(opt?) · WebSocketServerHook(hook, params?, disconnect?)    // server-side socket wiring
saveKeyValue({ dirDef, key? }) -> SaveKeyValueStore                          // fs-backed key/value store
createWebhookServer(params) · createWebhookClient(opts) · buildSelfWebhookUrl(ip, raw)
createSignatureFunction(hmacCreator) -> SignatureFunction
```

## 🧬 type utilities (`core/type.ts`, `core/BaseTypes.ts`)
```
Nullable<T> · PartialBy<T,K> · RequiredBy<T,K> · StringKeys<T> · ObjectEntries<T>
ArrayElementType<T> · TupleFirst<T>/TupleLast<T> · MapKeyType<T>/MapValueType<T> · ResolvedReturnType<T>
ReadonlyFull<T> · MutableFull<T> · Mutable<T> · Immutable<T> · const_Date
KeysByType<T,P> · PickTypes<T,P> · OmitTypes<T,E> · ReplaceKeyType<S,K,New>
```

## 🔁 ObserveAll2 Store — path node facade + simple mirror sync
> Public v2 store API: `import { ObserveAll2 } from "wenay-common2"` or `import * as ObserveAll2 from "wenay-common2/observe-all2"`.
> `ObserveAll2.createStore(initial)` wraps the fact-based `reactive` core with typed path nodes. `state` is the plain-feeling data object; `node` is the subscribable path tree. Transport stays simple: selected snapshots, not public diffs.
```
type Market = {data: {BTC?: number; ETH?: number}; meta: {status?: string}}
const store = ObserveAll2.createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}})

store.state.data.BTC = 3                           // local backend/frontend code writes normally
store.node.data.BTC.get() -> number | undefined
store.node.data.BTC.replace(4)                     // writes this path; set(v) = deprecated alias
store.node.data.BTC.on((v, ctx) => {}, {current: true})       // primitive leaf; ctx.path / ctx.pathString
store.node.data.BTC.once(cb, {current: true})       // current value counts as the event
store.node.data.on((data, ctx) => {}, {current: true, drain: 50})
store.on((whole) => {}, {current: true})            // whole store snapshot
store.count()                                      // local subscribers through StoreNode
```
Typed masks / multiple subscriptions:
```
const sel = store.update({data: {BTC: true, ETH: true}, meta: {status: true}}, {current: true})
sel.get() -> {data: {BTC, ETH}, meta: {status}}
sel.on((snap, ctx) => {})                          // aggregated selected snapshot; coalesced by default
sel.once((snap) => {}, {current: true})
sel.onEach((value, ctx) => { ctx.pathString })      // one event per selected path, with route
```
Backend expose + frontend mirror:
```
const facade = { market: ObserveAll2.exposeStore(store) }
// createRpcServerAuto({object: facade, ...}) exposes: get(mask?), changed/changedPaths Listen, set/replace(path,value)

const mirror = ObserveAll2.createStoreMirror<Market>(api.market, {data: {}, meta: {}})
const stopSync = await mirror.sync(
  {data: {BTC: true, ETH: true}, meta: {status: true}},
  {current: true, drain: 250}, // default partial:true uses changedPaths when available
)
mirror.node.data.BTC.on(v => render(v), {current: true})
stopSync()
```
Runnable example: `npx tsx observable2/store-mirror.example.ts`.
Optional push-data channels (explicit high-frequency mode; usually choose one):
```
type StorePatch = {path: PropertyKey[]; value: any; exists: boolean}
type StoreChangedData = {mask: any; data: any}

const pushed = ObserveAll2.exposeStore(store, {push: true})

// Raw manual wiring: patch event carries one dirty path's current value.
pushed.patches!.on((patch) => {
  ObserveAll2.applyStorePatch(mirror, patch)       // exists:false means delete path
})

// Batch-shaped dirty data: one event has dirty mask + snapshot for that mask.
pushed.changedData!.on(({mask, data}) => {
  ObserveAll2.applyStoreMask(mirror, mask, data)
})

// Mirror helpers keep the client's selected mask and apply only its intersection
// with the global push event. current:true still does one initial get(mask).
const stopPatchSync = await mirror.syncPatches(
  {data: {BTC: true}, meta: {status: true}},
  {current: true, drain: 50},
)
const stopDataSync = await mirror.syncChangedData(
  {data: {BTC: true}, meta: {status: true}},
  {current: true, drain: 50},
)
```

Contract:
- `node` subscriptions are address-based, so `store.state.data = {BTC: 10}` keeps `store.node.data.BTC` subscriptions alive.
- Primitive, missing, and later-created paths are subscribable.
- `{current:true}` emits only when a value exists; absent paths wait for the first value.
- `drain` is per subscription/sync. Branch subscribers receive whole branch snapshots; mask `.on()` receives the selected snapshot; `.onEach()` receives `(value, ctx)` with route.
- `pathString` is human-readable; internal route identity is collision-safe for dotted keys and distinct `Symbol()` keys.
- Mirror sync uses backend `changedPaths` when present: it pulls `selected mask ∩ dirty paths`; with no `changedPaths` or `{partial:false}` it falls back to `changed -> get(mask)`. UI subscribes to the local mirror store.
- Default `sync` is still pull-after-notify: event is light, reconnect is a fresh `get(mask)`, and each client owns its mask.
- `{push:true}` adds global push-data channels. `patches` emits `{path,value,exists}` per dirty path; `changedData` emits `{mask,data}` per dirty batch. They are separate from `changed`, so old clients and default mirror behavior do not change.
- `syncPatches` and `syncChangedData` are explicit mirror modes. They require the matching remote channel, do one initial `get(mask)` unless `{current:false}`, then apply pushed events without per-change round-trip.
- Push events are global, not per-subscriber mask streams. The mirror intersects each event with its own selected mask; a broad branch replace only updates selected leaves locally.
- Prefer default `sync` until round-trip cost or latency matters. Push mode sends more data in the event and reconnect should still resync with a fresh current snapshot.
- JSON/RPC transports should use JSON-safe path keys for push channels; `Symbol` paths are local-only even though the in-memory store can address them.
- Dirty paths are facts about changed object routes: add key, delete key, or deep set. Array mutation dirties the whole array branch; no public splice/index diff is promised.
- `snapshot()`/`update().get()` walk raw targets (`toRaw`), so a snapshot of a cold store creates no lazy reactive nodes.
- Writing a reactive proxy back into state stores its raw value (no reactive-in-reactive).
- Mirror `sync` pulls are chained sequentially: a slow (stale) response never overwrites a newer one.
- A slot keeps its proxy identity across an array↔object replace, so `Array.isArray` on a captured proxy reflects the original shape; JSON serialization follows the current value. Use `toRaw()` when the real shape matters.

Run coverage:
```bash
npx tsx observable2/listen-store.test.ts
npx tsx observable2/store.test.ts
npx tsx observable2/store-mirror.example.ts
```
## 🧪 Legacy reactive sandbox (`observable/`, not public API)
> The old `observable/` tree remains in the repo for regression/sandbox work only.
> Do not document it as package API and do not teach it in new examples. Use root-exported `ObserveAll2` instead.
> Existing tests may still import `observable/*` directly while the replacement surface settles.

## 🔁 ObserveAll2 — coarse reactive object (`ObserveAll2`, fact-based)
> `import { ObserveAll2 } from "wenay-common2"` → `ObserveAll2.reactive(...)`.
> Different from the old `observable/` sandbox: no public deltas, no string-path event API, no computed graph in core.
> Subscribe to the fact that a subtree changed, then re-read the current state.
```
const state = ObserveAll2.reactive({
  account: {
    balances: {BTC: 100, ETH: 400},
    positions: {BTC: {qty: 0.5, entry: 60000}},
  }
})

ObserveAll2.onUpdate(state.account, () => console.log("account changed"))
ObserveAll2.onUpdatePaths(state.account, ({paths}) => console.log(paths)) // optional dirty paths, relative to account
ObserveAll2.onUpdate(state.account.positions, () => console.log("positions changed"))
ObserveAll2.onUpdate(state.account.positions.BTC, () => console.log("BTC changed"))

state.account.positions = {BTC: {qty: 3, entry: 59000}, SOL: {qty: 10, entry: 130}}
await ObserveAll2.flushReactive(state)
```
```
reactive<T extends object>(obj, opts?) -> T
onUpdate(node, cb)->off
onUpdatePaths(node, cb)->off            // cb({paths}); paths are relative to subscribed node
flushReactive(node)->Promise<void>
toRaw(node)->raw value                  // current raw target behind the proxy; creates no lazy nodes
listenUpdate(node)->Listen<void>        // RPC bridge: createRpcServerAuto recognizes it
listenUpdatePaths(node)->Listen<{paths: PropertyKey[][]}>

opts: {
  drain?: 'immediate' | 'micro' | number | ((flush)=>void)
  depth?: number
  eager?: boolean
}
```
RPC stacking:
```
const facade = {
  getAccount: () => state.account,
  accountChanged: ObserveAll2.listenUpdate(state.account),
  accountChangedPaths: ObserveAll2.listenUpdatePaths(state.account),
  btcChanged: ObserveAll2.listenUpdate(state.account.positions.BTC),
}
// createRpcServerAuto({ object: facade, ... }) exposes accountChanged/accountChangedPaths/btcChanged
// as normal RPC Listen subscriptions. This is a notification stream, not a full
// automatic snapshot mirror; send/read snapshots explicitly via facade methods.
```



