# wenay-common2 — EXTENDED cheat sheet (notation)

> The full surface. For everyday helpers use **`wenay-common2.md`** (brief). Root import:
> `import { ... } from "wenay-common2"`. Notation: `name(args) -> ret  // note`. Short names are
> canonical. Removed old names are listed in `NAMING_RENAMES.md`.

## 🔔 events (rare)
```
new CObjectEventsArr<T>() / new CObjectEventsList<T>(log?=true)        // handler collections
  .add(item, {at?:'start'|'end'})   // item: { func?, func2?, del?, OnDel? }; default end (func2 = run-once-then-del)
  .emit(data?) · .clear() · get size · .OnSpecEvent(fn)
  // alias: Add/AddEnd->add · AddStart->add(_, {at:'start'}) · OnEvent->emit · Clean->clear · count/length->size
  // CObjectEventsList warns at >20 subscriptions (leak detector)

Listen API from root import:
createListenCore<T>(opts?) -> core               // minimal hot path: emit/on/off/once/close/count/keys
createListen<T>(producer, opts?) -> full         // producer receives emit and may return teardown
createFastListen<T>(producer) -> full            // createListen(..., {fast:true})
listen<T>(opts?) -> [emit, full]                 // pure event list: no value storage/current replay
slimListen<T>(opts?) -> [emit, slim]             // slim view: on/off/close/count only
withStoreListen(full, currentGetter) -> storeListen
createStoreListen<T>(producer, {current,...opts}) -> storeListen
listenStore<T>({current,...opts}) -> [emit, storeListen]
  // storeListen stores only the current getter reference, not store values

full Listen: .emit(...args) · .on(cb,{key?,cbClose?})->off · .off(key|cb) · .once(cb,{key?})->off · .onClose(cb)->off · .run() · .isRunning() · .close() · .count() · .keys()
store Listen: .on(cb,{current?:true|()=>args,key?,cbClose?})->off · .once(cb,{current?:true|()=>args,key?})->off
slim Listen: .on(cb,{key?})->off · .off(key|cb) · .close() · .count()
```
External current getter example:
```
const [emit, listen] = listenStore<[Market]>({
  current: () => store.node.has() ? [store.node.snapshot()] : undefined,
})
listen.on(cb, {current: true})       // current store value first, then future emit(...) events
listen.once(cb, {current: true})     // current store value once, or waits for one future event if current() returns undefined
```
```
isListenCallback(obj) -> boolean                  // duck-type a full Listen result
socketBuffer(...) · listenSnapshot(...)           // snapshot/buffer adapters over a SocketSource
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
  // replay-transparent exposure: facade members that are replay listens (replayListen — brand-detected,
  //   opts.replay: false|'auto'|'force') are exposed with BOTH surfaces under the SAME key: the legacy plain-Listen
  //   path stays byte-for-byte (Pkt.MAP only grows additively), plus line/frameLine/since/keyframe/frame — so
  //   upgrading listen -> replayListen is a declaration-site-only change; replaySubscribe(client.func.key) works as is.
  //   opts.replayOpts {pending?, highWater?, lowWater?, pollMs?} arms the per-connection lag gate on frameLine
  //   (consumer picks policy 'queue'|'frame' at subscribe time); the replay `line` stays ungated for connected queue-policy live delivery.
createRpcServer(opts)                               // lower-level core
createRpcServerAutoDetect(opts)                          // + legacy/v2 protocol auto-detection (createRpcServerAutoWithProtocolDetection)
createRpcServerInProc(...)                          // in-process fast path (no socket)
// clients
createRpcClientHub(opts) + rpc                      // multiplexing client hub: connect(token)/reauth(token)/onConnect/onDisconnect + connectListen/disconnectListen
  // alias: hub.setToken->connect. onConnect/onDisconnect are legacy single-slot setters; the additive
  //   *Listen registries return per-listener off functions and cannot overwrite each other or internal recovery.
  //   A transient disconnect/reconnect of the SAME Socket.IO object keeps this client generation: after
  //   the new route/auth handshake, each active deduped logical Listen gets exactly one new physical attempt.
  //   Local consumers and their off handles survive; a consumer removed offline is not resurrected.
  //   connect()/setToken() hard-rotates the socket/client generation; close()/dispose() is terminal.
client members: func (proxy) · strict (schema-safe) · schema() · auth() · reauth() · onDisconnect()
                close(reason?, {socketAlive?}) · ready() · init(obj?) · api.subscriptions()
  // alias: dispose->close · readyStrict->ready · initStrict->init
  // func/space/strict child proxies are cached per createRpcClient instance + surface + lossless RPC path:
  //   c.func.a.b === c.func.a.b and c.all === c.func; dotted keys remain distinct from segmented paths.
  //   Identity survives strict-schema refresh, reauth and transient reconnect. Hard token rotation creates
  //   a fresh client/cache; incompatible wait/surface semantics never share a proxy.
  //   Only Listen subscriptions are transport-resumed. Pending/attempted ordinary RPC and pipe calls reject
  //   on disconnect and are NEVER replayed: retrying an arbitrary command could repeat side effects.
noStrict(obj) / isNoStrict(obj)                     // dynamic (no-schema) subtree
endCallback(fn)                                     // alias: rpcEndCallback
// subscription primitives (rare/manual; createRpcServerAuto/createRpcClientHub are the normal path)
listenSocket(parent, opts?) · listenSocketFirst · listenSocketAll · listenSocketSmart
deepListenFirst(obj, opts?) · deepListenAll · deepListenSmart
RPC Listen surface on client: stream.on(cb)->off · stream.once(cb)->off · stream.close()
  // typed projection: client.func as unknown as DeepSocketListen<ServerFacade> (usually hidden behind a local webListen(client) helper).
  //   replay members project as ReplaySocketListen<Z> automatically (legacy surface + line/frameLine/since/keyframe/frame,
  //   tuples preserved end-to-end) — client.func.key passes to replaySubscribe as is, no casts.
  //   The same projection is built into BOTH typed-client paths (ClientAPIAll/ClientAPIStrict): on a plain rpc<T>() client
  //   replay members are already ReplaySocketListen on client.func/client.strict — no webListen and no casts for them
  //   (plain Listen members still need the DeepSocketListen projection).
  // off is callable + thenable: off() unsubscribes; await off waits for stream end.
  // *First/*All/*Smart differ only in callback arity: first arg / all args / single-vs-tuple smart.
matchKeys(a,b) · matchKeysList(a, keys) · deepMapByKeys · deepMapByKeysList
// wire serialization (rpc-walk): Date/Map/Set/RegExp/BigInt are marked+restored; functions -> callback refs.
//   TypedArray/DataView/Buffer/ArrayBuffer pass through as BINARY leaves (socket.io carries them natively;
//   never rebuilt into {0:…,1:…} dicts — raw canvas/video byte payloads are wire-safe and cheap).
RpcLimits (opt, per server/client): maxDepth 32 · maxKeys 1000 · maxArgs 64 · maxArrayLen 10k
  · maxStringLen 1M · maxCallbacks 100 · maxPathLen 16 · maxBinaryLen 8MB (bytes per binary leaf)
// modes: func (proxy) · strict (schema-safe) · pipe (whole chain in one packet) · space (fire-and-forget)
// legacy (oldCommonsServer.ts, @deprecated forwarders onto oldСommonsServerMini — identical wire):
//   funcPromiseServer->promiseServer · funcForWebSocket->wsWrapper · funcScreenerClient2->createClientProxy
//   CreatAPIFacadeServerOld->createAPIFacadeServer ; CreatAPIFacadeClientOld & funcPromiseServer2 kept as-is
```

### RPC dynamic maps: prefer `noStrict` for personal/runtime keys
Use `noStrict(obj)` for user-scoped or runtime-keyed objects whose children are not a stable API schema: strategy maps, account maps, ORM/DB proxies, per-session private objects. The name is exactly `noStrict`.

```ts
return {
  strategies: noStrict(strategyByName),
}

await client.func.strategies["mystrategy.2020"].start()
```

Contract:
- `noStrict` stops schema walking and routeMap indexing below that object.
- It is not an access-control boundary and does not bypass safe-key/path limits. Validate user-owned names in your facade if they are security-sensitive.
- RPC paths are arrays of string segments. `"mystrategy.2020"` is one segment, so the call above is `["strategies", "mystrategy.2020", "start"]`, not `["strategies", "mystrategy", "2020", "start"]`.
- The failure mode to avoid is treating `path.join(".")` as identity: `["a.b", "c"]` and `["a", "b", "c"]` both display as `a.b.c` but are different RPC paths.
- Static dotted keys are also supported: `api["a.b"].c` is distinct from `api.a.b.c`. Internal route/listen/cache identity must stay lossless; dotted strings are only a debug display form.
- If a branch is a fixed public API, keep it strict. If a branch is a personal/dynamic keyspace, wrap that branch in `noStrict` instead of trying to publish all current keys as schema.

## 📦 Resource — file storage intents + AI job coordinator

`Resource.createFileJobHost({storage, runner, policy?, id?, now?, history?, drain?})` is the
application-facing layer for a frontend file and a backend/AI workflow. It does not choose a
storage provider, transport URL, or AI vendor.

```ts
type FileStoragePort = {
  beginUpload({file}) -> uploadInstruction | Promise<uploadInstruction>
  confirmUpload?({file}) -> void | Promise<void>
  download?({file}) -> downloadInstruction | Promise<downloadInstruction>
}
type FileJobRunner = {
  run({file, job, input, report, cancelled}) -> {result?} | Promise<{result?} | void>
}

const host = Resource.createFileJobHost({storage, runner})
const conn = host.connection(account)
createRpcServerAuto({object: {...legacy, files: conn.fragment}, ...})
disconnectListen.on(conn.close)

const client = Resource.createFileJobClient({remote: rpc.func.files})
await client.ready
client.store.state.files[id]  // FileResource: uploading | uploaded | failed
client.store.state.jobs[id]   // FileJob: queued | running | ready | failed | cancelled
```

Host control/API split:

- `storage.beginUpload({file})` returns an opaque upload instruction. The browser uploads bytes to
  that destination directly; `confirmUpload` makes the resource usable only after storage verifies
  it.
- `runner.run` receives safe file metadata, opaque job input, `report({progress?, message?, result?})`
  and `cancelled()`. A late report/result after cancellation is ignored.
- `connection(account).fragment` exposes `state` (an account-filtered Store patch replay),
  `startUpload`, `confirmUpload`, `startJob`, `cancelJob`, and `download`. It is designed to be
  spread beside existing RPC keys; `connection.close()` stops its per-connection projection.
- Default policy is owner-only. `FileJobPolicy.canRead` controls what reaches the projection;
  `canWrite` controls confirmation, processing, cancellation, and download. The authoritative
  global Store is server-only and must not be exposed as an RPC object.

`FileResource` deliberately has no storage key or bytes. `FileJob.result` should be a small
descriptor, link, or structured AI result — write large output back through the storage port.
The local stand (`npm run demo`) uses a tiny in-memory HTTP storage adapter solely to show the full
upload → confirm → AI progress/result → download path; production code supplies its own storage
port. Oracle: `replay/file-job.test.ts` (real Socket.IO/RPC, owner ACL, progress, result, cancel).

## 🎙️ Media over socket — browser capture as binary Listen
> `import { Media } from "wenay-common2"` or `import * as Media from "wenay-common2/media"`.
> The hot path event is ONE `Uint8Array`: fixed 40-byte common2 media header + raw payload. No JSON envelope.
```
Media.createAudioSource(opts?) -> [emit, listen] & control
Media.createVideoSource(opts?) -> [emit, listen] & control
Media.encodeMediaFrame(meta, payload) -> Uint8Array
Media.decodeMediaFrame(frame) -> {kind, codec, seq, tMono, payload, sampleRate?, channels?, nSamples?, width?, height?}

control: start() -> Promise<MediaSourceState> · stop() · getStats() · setDevice(id) · listDevices()
state: 'idle'|'requesting'|'live'|'denied'|'no-device'|'error'
```
Audio source:
- default `mode:'pcm'`, `format:'int16'`, raw PCM payload; uses `AudioWorklet` when available and falls back to `ScriptProcessor` only when the browser cannot run a worklet.
- `mode:'record'` uses `MediaRecorder` chunks (`webm-opus`) for record/upload flows, not live STT.
- `getStats().rms` gives a VU-meter signal; permission denied/no device returns typed state, not a thrown public failure.

Video source:
- default snapshots, not a 30fps video stream: JPEG, `fps` default 3, `quality` default 0.82.
- each frame carries absolute image bytes, so `replay:true` can safely keep the latest frame for lag recovery.
- capture is hidden-tab-proof by default (Chrome throttles hidden tabs three ways, each stage has its own escape): the tick comes from a Blob-worker timer (in-page `setInterval` drops to ~1/s), the frame comes from `ImageCapture.grabFrame()` when available (a hidden `<video>` stops painting; `<video>->canvas` stays as the fallback), and JPEG encode runs in a worker over a transferred `ImageBitmap`, returning a transferred `ArrayBuffer` — never a structured-cloned frame (main-thread `convertToBlob` is gated to ~1s per call when hidden). `worker: false` opts out of all three into the plain in-page path.
- one explicit dimension (`width` or `height`) scales the other proportionally from the track resolution, downscale-only; pass both to force an exact size. `grabFrame`'s ~50ms serial latency caps the pipeline around ~15-20fps regardless of `fps`.

Viewer helpers (`media-view`): the consumer side of any media line (local pair or RPC surface).
- `attachVideoCanvas(line, canvas, {createBitmap?, onError?})` — per-frame codec/size come from the 40-byte header, canvas resizes to follow; decode overload is busy-skipped (keep-latest, `stats().frames` vs `stats().drawn` shows the gap); `createBitmap` injects a custom decoder (tests, OffscreenCanvas pipelines).
- `attachAudioPlayer(line, {maxBacklogSec? = 0.35, audioContext?, onError?})` — pcm16/float32 through a sequential playhead; a backlog past `maxBacklogSec` is dropped and the playhead rebases near "now" (live beats lossless; `stats().dropped` counts rebases). `enable()` must come from a user gesture (browser autoplay rules); `audioContext` injects a factory for tests/custom routing.
- `pipeMediaPublish(line, publish, {stamp? = true, onError?})` — fire-and-forget pipe into an RPC call; the default `Date.now()` stamp is what viewer `stats().ageMs` measures against. Both attach helpers also expose `stats().perSec` (rolling 1s rate).
- Oracle: `replay/media-view.test.ts`.

Replay/RPC wiring:
```ts
const audio = Media.createAudioSource({sourceId: 'mic'})                 // plain lossless queue Listen
const video = Media.createVideoSource({sourceId: 'cam', fps: 2, replay: true})

createRpcServerAuto({
    socket, socketKey: 'media',
    object: {audio: audio[1], video: video[1]},
    replayOpts: {highWater: 64, lowWater: 8},
})
```
`replay:true` makes the returned listen a `Replay.replayListen` surface before capture emits into it, so `createRpcServerAuto` brand-detects it and exposes legacy + replay under the same key. Defaults differ by media kind: audio replay is a sacred queue (`history:1024`, no keyframe/frame, do not drop samples); video replay is keep-latest (`history:256`, `current:'last'`, `frame` returns the newest covered frame). Pass `replay:{...}` for custom history/current/frame.

Backpressure rule: audio consumers should use the default queue policy unless the app explicitly accepts loss. Video consumers can use `Replay.replaySubscribe(remote.video, cb, {policy:'frame'})`; a slow socket drains to the latest frame instead of accumulating stale images. The binary frame itself is RPC-safe because `rpc-walk` passes `TypedArray`/`ArrayBuffer` leaves through natively and applies `maxBinaryLen`.

WebRTC future contract:
- `transport:'socket'` is the implemented default today.
- `transport:'webrtc'` is reserved and currently reports `state:'error'` on `start()`; it is not a hidden second transport.
- Future WebRTC support must be explicit opt-in for sub-200ms human duplex. Signaling belongs on the existing socket/RPC control channel (offer/answer/ICE), and backend/AI access requires an SFU that re-emits media bytes into the same `Media` Listen/replay surface. Downstream RPC/replay/store consumers must not change.

Oracle: `npx ts-node replay/media-socket.test.ts` checks header decode, plain Listen shape, `replay:true`, typed no-device state in Node, and real Socket.IO binary delivery.

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

## 🔁 Observe Store — path node facade + simple mirror sync
> Public v2 store API: `import { Observe } from "wenay-common2"` or `import * as Observe from "wenay-common2/observe"`.
> `Observe.createStore(initial)` wraps the fact-based `reactive` core with typed path nodes. `state` is the plain-feeling data object; `node` is the subscribable path tree. Transport stays simple: selected snapshots, not public diffs.
```
type Market = {data: {BTC?: number; ETH?: number}; meta: {status?: string}}
const store = Observe.createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}})

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
sel.onEach((value, ctx) => { ctx.pathString })      // one event per SELECTED path, with route (explicit masks only)
```
`store.each()` — extended notes (the per-key feed itself: signature, expansion contract and the
canonical example live in wenay-common2.md):
- A key whose primitive value is unchanged by a root replace does not fire (the set trap skips
  `Object.is`-equal writes); object values always fire — replay patches apply fresh snapshot copies.
- `each({depth})` is reserved: only `1` (top-level keys) is accepted today, anything else throws.
- `ctx` is `{path: [key]}`. `key` is typed `string`; symbol top-level keys pass through at runtime as-is.
- The `update(true).onEach` dev warn fires once per process (explicit key masks never warn —
  `onEach` stays correct for them).
- `{'*': true}` is not a wildcard — it subscribes a literal `'*'` key (zero calls, no warn).

Backend expose + frontend mirror:
```
const facade = { market: Observe.exposeStore(store) }
// createRpcServerAuto({object: facade, ...}) exposes: get(mask?), changed/changedPaths Listen, set/replace(path,value)

const mirror = Observe.createStoreMirror<Market>(api.market, {data: {}, meta: {}})
const stopSync = await mirror.sync(
  {data: {BTC: true, ETH: true}, meta: {status: true}},
  {current: true, drain: 250}, // default partial:true uses changedPaths when available
)
mirror.node.data.BTC.on(v => render(v), {current: true})
stopSync()
```
Runnable example: `npx tsx observe/store-mirror.example.ts`.
Optional push-data channels (explicit high-frequency mode; usually choose one):
```
type StorePatch = {path: PropertyKey[]; value: any; exists: boolean}
type StoreChangedData = {mask: any; data: any}

const pushed = Observe.exposeStore(store, {push: true})

// Raw manual wiring: patch event carries one dirty path's current value.
pushed.patches!.on((patch) => {
  Observe.applyStorePatch(mirror, patch)       // exists:false means delete path
})
Observe.applyStorePatches(mirror, patches)     // batch variant: apply an array of patches in order

// Batch-shaped dirty data: one event has dirty mask + snapshot for that mask.
pushed.changedData!.on(({mask, data}) => {
  Observe.applyStoreMask(mirror, mask, data)
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

Declarative manager over store resources:
```ts
const manager = Observe.createStoreManager({
  market: Observe.managedStore.mirror({
    remote: api.market,
    initial: {data: {}, meta: {}},
    mask: {data: {BTC: true}, meta: {status: true}},
    tags: ['bootstrap', 'route:main'],
    priority: 10,
    sync: {mode: 'pull', opts: {current: true, drain: 'micro'}},
  }),
  rows: Observe.managedStore.offline({
    remote: api.rows.replay,
    initial: {},
    storage: indexedDbStorage,
    storageKey: 'rows',
    tags: ['grid'],
    priority: ({usage}) => usage?.weight ?? 0,
    syncOpts: {staleMs: 30_000},
  }),
  video: Observe.managedStore.replay({
    remote: api.video.replay,
    initial: {},
    explicitOnly: true,
    large: true,
  }),
})

manager.plan()                         // excludes explicitOnly/large by default
manager.plan({includeExplicit: true, includeLarge: true})
await manager.startPlanned({tags: ['bootstrap']})
manager.touch('rows', 3)                // records local usage for future scoring
await manager.start('video', {explicit: true})
manager.stopAll()
```

Contract:
- `node` subscriptions are address-based, so `store.state.data = {BTC: 10}` keeps `store.node.data.BTC` subscriptions alive.
- Primitive, missing, and later-created paths are subscribable.
- `{current:true}` emits only when a value exists; absent paths wait for the first value.
- `drain` is per subscription/sync. Branch subscribers receive whole branch snapshots; mask `.on()` receives the selected snapshot; `.onEach()` receives `(value, ctx)` with route; `store.each()` receives `(key, value, ctx)` per changed top-level key.
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
npx tsx observe/listen-store.test.ts
npx tsx observe/store.test.ts
npx tsx observe/store-manager.test.ts
npx tsx observe/store-mirror.example.ts
```
## 🎞️ Replay — snapshot + sequenced delta line
> Keyframe + seq-numbered deltas + recovery via a fresh keyframe — one pattern for store sync,
> ticks and video-like frame streams. `import { Replay } from "wenay-common2"` or
> `import { ... } from "wenay-common2/replay"`; the store pair lives in `Observe`.
> Design: `REPLAY-PLAN.md`; oracles: `replay/` (import the canonical `src/` modules).
```
withReplayListen(base, {current?, frame?, history?, getSince?, onJournal?, now?, staleMs?, onStale?}) · replayListen   // layer A: journal {seq, ts, event}; on(cb, {since, onSeq}); head()/getSince()/keyframe()/hasKeyframe · isStale()/lastTs()
  // FRAME MODEL — one method, two sources, three triggers. frame(sinceSeq, hint?) -> envelopes bringing a consumer
  //   from sinceSeq to head, as compact as the line allows; default = exact journal tail ?? keyframe.
  //   Source 1 (keyframe): `current` — full state SAMPLED from the owner of truth (never computed from deltas);
  //     sugar `current: 'last'` — single-entity lines: keyframe = last journaled envelope, no hand-kept state.
  //   Source 2 (mini-frame): `frame` lambda — gets the raw tail, returns a state-equivalent compact
  //     (last-per-entity, gap aggregate...); cost ~ touched entities, wins over keyframe while the journal covers.
  //   Line classes FOLLOW from declared lambdas (no mode flags): current+frame = condensable with keyframe fallback;
  //     current only = exact retained tail + keyframe fallback; frame without current condenses only while the tail
  //     is retained and still fails on eviction; neither = sacred exact queue — eviction THROWS terminally.
  //   Triggers: reconnect (`since`), client pull (own timer — replaces any server-side interval mode), server gate drain.
  //   The transport sees ONLY seq; entity keys/skip rules live in producer lambdas (hint = opaque per-subscriber pass-through).
exposeReplay(replay)  <->  replaySubscribe(remote, cb, {since?, onSeq?, staleMs?, onStale?, skewMs?, now?, policy?, hint?}) -> off   // wire pair over the EXISTING rpc: line = plain Listen, since/keyframe/frame = plain methods
  // NORMAL PATH: createRpcServerAuto exposes replay listens automatically (see rpc section) — exposeReplay stays
  //   as the manual/custom-transport path. replaySubscribe prefers `frame` when the server has it (one round trip,
  //   server picks tail/mini-frame/keyframe; sacred throw -> onError), falls back to since/keyframe on old servers.
  //   policy: 'queue' (default — ungated connected live line) | 'frame' (subscribes frameLine when present: on lag
  //   the server may drop and recover via a state-equivalent frame(lastSent)). Catch-up is shared by both policies
  //   and may use a producer mini-frame/keyframe, so a covered raw seq jump is not a logical data gap. A non-envelope
  //   on the line (RPC_STOP — e.g. the gate's loud sacred failure) surfaces via onError + off, never silence.
  //   hint reaches the frame lambda on catch-up and on every explicit frame(seq, hint) call (pull); the push-gate's
  //   drain recovery uses the line's DEFAULT condensation — client-specific rules/pace = the pull path.
  // off.ready (first handover done, or terminal error/teardown) · off.seq() (last honestly delivered coordinate) · off.isStale()/off.lastTs().
  //   Hub-managed RPC remotes resume automatically after transient reconnect from off.seq(): live is restored first,
  //   racing envelopes queue, then frame/since catch-up is sorted+deduped. Transport-agnostic remotes without RPC
  //   lifecycle metadata still reconnect by creating a new subscriber with {since: prev.seq()}.
replayRouteSubscribe(remote, cb, {label?, since?, onSeq?, onError?, onRoute?}) -> off & {ready, switch(nextRemote, {label?, since?, reset?, policy?, hint?}), seq(), label(), active()}
  // transport hand-off helper: old route remains live, replacement subscribes+catches up from seq, then old closes; overlap is seq-deduped. Use for relay -> direct and direct -> relay over any ordered ReplayRemote.
  // DELIVERY CONTRACT (guaranteed, not best-effort): the subscriber's cb sees ONE uniform stream —
  //   first delivery = the snapshot (keyframe as an event of the SAME type; store: root patch),
  //   then only strictly-newer events, seq-ascending and deduped. A raw seq jump is valid only when a
  //   producer-declared mini-frame/keyframe is state-equivalent to the omitted range; sacred retained tails
  //   are exact. Live events racing ahead of the
  //   keyframe over the wire are queued during catch-up and seq-deduped — they can NEVER arrive first.
  //   With {since: K}: same fold, journal tail after K instead of a keyframe (evicted -> keyframe fallback,
  //   visible as a covered seq jump > +1). A sacred eviction instead calls onError, closes the subscriber and
  //   never drains post-gap live events as a false continuation. Requires an ORDERED transport (socket.io / TCP / in-proc).
  //   Net effect: one client fold `state = apply(state, event)` handles cold start, reconnect,
  //   conflation recovery and archive playback identically — snapshot is not a special case.
  // FRESHNESS (staleMs/onStale — an option, not consumer boilerplate): delivery is consistent but silent
  //   about staleness. Two failure modes it would otherwise hide: a SILENT LINE (producer died, line stays
  //   open, no envelopes) and a STALE KEYFRAME (arrives now, but its ts is old — "fresh over the wire" while
  //   minutes stale). onStale({stale, lastTs, age}) is edge-triggered BOTH ways, never a repeating alarm.
  //   Producer side: no journal event for staleMs -> stale; the timer exists only with onStale and arms after
  //   the first event (a cold line stays free); isStale()/lastTs() are lazy getters, no timer needed.
  //   Client side, two signals: ARRIVAL GAP (local clock, the only timer — catches the silent line regardless
  //   of clock skew) + ENVELOPE-TS AGE checked at delivery (producer clock — a stale keyframe reports stale
  //   IMMEDIATELY; clock-skew caveat: producer/client clocks may disagree, skewMs tolerance absorbs it, default 0).
  //   A since-tail's historical ts never flaps mid-catch-up (one assessment after handover); off() disarms the timer.
createRouteCoordinator({connect, policy?, shadow?, catchUpTimeoutMs?}) -> coordinator    // policy-gated relay <-> direct routing shell over pure connectors (ROADMAP 0.1)
  // LAYERING: a CONNECTOR is a pure transport (no route decisions) — {info: {label, kind: 'relay'|'direct',
  //   binary?, ordered?, reliable?}, open() -> ReplayRemote, close(), state(), metrics?() -> {rtt?, pending?},
  //   onFail?}; the COORDINATOR alone owns promotion/fallback (state machine + policy); data continuity is
  //   replayRouteSubscribe underneath, so ANY route change is deduped and has no uncovered logical gap;
  //   a producer-authorized frame/keyframe may still jump raw seq.
  //   WebRTC/NAT is deliberately absent here: a future datachannel is just another RouteConnector.
  // connect(ref, kind) -> RouteConnector — transport factory per pair and kind (called per activation).
  // policy hooks run BEFORE any transport action; absent hook = allowed, present hook must return true:
  //   canDirect (may the pair attempt direct) · mustRelay (force relay: NDA/audit/moderation — beats canDirect)
  //   · mustShadowRelay (direct payload + relay audit copy) · canExposeEndpoint (may signaling reveal
  //   endpoint/session material) · canReinterpose (may relay step back into the path).
  // coordinator.pair(a, b) -> link (symmetric key: pair(a,b) == pair(b,a)) · state/promoteDirect/
  //   reinterposeRelay/fallback/block(pairOrKey, ...) · onRoute(cb) -> off (all transitions, all pairs)
  //   · pairs() · close()
  // link: .subscribe(cb, opts?) -> off & {ready, seq(), label(), active()}   // the pair's data: a replay stream
  //     that survives every route change; facade/authority semantics never learn the transport switched
  //   .promoteDirect({timeoutMs?, reason?}) -> Promise<{ok, state, reason?}>  // policy denial and transport
  //     failure are EXPECTED OUTCOMES (result object), not exceptions; ops are serialized per link
  //   .reinterposeRelay(reason?) / .fallback(reason?) / .block(reason?) · .state() · .label() · .metrics() · .close()
  // STATE MACHINE: relay -> direct:connecting -> direct | direct+shadowRelay; direct -> relay:reinterposing -> relay;
  //   failed/slow direct (timeoutMs) -> fallback (relay kept live the whole time, switch failed loudly);
  //   direct onFail (endpoint revoked, link died) -> auto fallback: close direct, resume relay from seq;
  //   any state -> blocked (terminal: subs closed, new subscribe throws, promote denied).
  // direct+shadowRelay: payload rides direct while deps.shadow(ref, ...ev) receives the relay audit copy,
  //   starting from the consumers' seq coordinate — the switch window never escapes the audit.
  // Acceptance oracle: replay/route-coordinator.test.ts (fake in-process relay/direct connectors).
createSignalHub({authorize?}) -> {register(account) -> {send, signals, close}, revoke(pair, accounts, reason?), accounts(), close()}
  // WebRTC signaling over the EXISTING control channel: the port shape {send, signals} is a function +
  //   Listen — exactly what createRpcServerAuto exposes, so the relay socket IS the signaling wire
  //   (per connection: const port = hub.register(account); object = {send: port.send, signals: port.signals}).
  // authorize(env) is the SERVER-side canExposeEndpoint point — endpoint/session material is revealed only
  //   past it; client-side coordinator policy stays advisory. from-spoofing is cut at the port.
  // SignalEnvelope = {type: 'offer'|'answer'|'ice'|'revoke'|'close' | 'ring'|'accept'|'decline'|'hangup',
  //   pair, from, to, sdp?, candidate?, session?, reason?} — session is opaque auth material (the wire
  //   never looks inside). The call types (peer-call) ride the SAME hub: routing is by `to` only, webrtc
  //   connectors filter by pair+type (no interference), and authorize(env) sees call envelopes too —
  //   one server-side policy point for endpoint material AND calls.
createWebRtcConnector({port, rtc, self, peer, pair, session?, label?, openTimeoutMs?}) -> RouteConnector
  // the direct connector for createRouteCoordinator: open() drives offer/answer/ICE through the signal
  //   port, waits for the datachannel, returns a replay wire over it. RTCPeerConnection is NOT bundled:
  //   rtc is a runtime factory — browser `() => new RTCPeerConnection(cfg)`, Node werift/node-datachannel,
  //   tests an in-proc fake (RtcPeerConnection/RtcDataChannel are structural types, no lib.dom).
  //   The replay channel encodes Uint8Array explicitly, preserving Media frames byte-for-byte instead
  //   of JSON's numeric-key object conversion; native tracks/SFU are optional performance adapters.
  //   revoke/close signals and channel death (incl. DURING open) fail loudly -> coordinator auto-fallback.
acceptWebRtcDirect({port, rtc, self, serve, accept?}) -> close()
  // responder side: on offer, negotiates answer/ICE and serves serve(env) (exposeReplay(...) as is) into
  //   the incoming datachannel; accept(env) validates session material and rejects with a loud revoke
  //   (the initiator fails fast, not by timeout). Repeated offer for a pair recreates the session.
Peer.createPatchRelayJournal({history?, gap?: 'resume'|'sacred'}) -> {push(env) -> true|false|{seq}, remote, gap, seq(), snapshot(), close()}
  // server-side mirror of an OWNER-sequenced patch line: push() takes the owner's envelopes VERBATIM.
  //   Owner seq space is the point: relay and direct routes share coordinates -> hand-off is a seq resume.
  // CORRECTNESS CONTRACT (gap = the SERVER's data-type decision):
  //   'resume' (default, folding): keyframe folded server-side (late joiners never need the owner online);
  //     a ROOT patch always resets the journal (owner restart AND keyframe repair share one rule); a
  //     non-root envelope with a seq gap — and a non-root FIRST envelope (partial-state lie) — is
  //     REJECTED as {seq: N}: that coordinate IS the repair request, no separate handshake exists.
  //   'sacred': the journal never invents — no folded keyframe, no root-reset, strict contiguity only;
  //     frame() on an evicted tail THROWS. For data where an invented snapshot is unacceptable.
  //   Duplicates (reconnect/repair overlap) are idempotent no-ops. Rejection never corrupts the fold.
  //   remote is ReplayRemote-shaped (+ additive `seq()` for publisher resync) and rpc-exposable as is
  //   (line is a REAL Listen — the rpc layer detects listen nodes by registry, a hand-rolled
  //   {on: cb => ...} wrapper would not stream).
  // Publisher side (createPeerClient): {journal?: 'resume'|'sacred', repair?: 'tail'|'keyframe',
  //   onPublishError?, resync()}. 'tail' = missed envelopes verbatim (falls back to a root keyframe if
  //   the local journal evicted them — resume only); 'keyframe' = one cheap root reset (ephemeral state).
  //   TYPE RULE, not a runtime check: journal:'sacred' narrows repair to 'tail' (tPublishRepair<J>) —
  //   lie about the journal kind and the relay simply keeps rejecting you (loud via onPublishError).
  //   resync() = call after transport reconnect: compares relay seq() with the local line, repairs the
  //   gap without waiting for the next write. Oracle: replay/peer-repair.test.ts (full gap matrix).
  // The full SDK on top (createPeerHost/createPeerClient) is most-used surface -> wenay-common2.md.
  // Host fragment also carries `presence` (>= 1.0.74): {list() -> string[], changes: Listen<{account,
  //   online}>} — refcounted per account (several connections = one identity), edges on 0<->1 only.
  //   changes is a PLAIN Listen (no replay journal): subscribe FIRST, then list(), to close the race.
  // `peers` auto-creates an EMPTY relay journal on first touch (>= 1.0.74, Proxy over the dynamic
  //   keyspace): a mirror subscribed before its owner ever connected waits for the first publish
  //   instead of failing (no subscribe-order race). createPeerHost({accounts?: k => bool}) gates
  //   which keys may materialize — set it on public servers to stop junk-key journals.
Peer.createMediaRelay({lines: {name: 'video'|'audio'}, videoHistory? = 8, audioHistory? = 64, canWatch?}) -> {publishOf(account), watchOf(watcher), watch, lines(account), accounts(), dropAccount(account), close()}
  // formalized demo media hub: per-account named replay lines, relay-first by design (media rides the
  //   socket relay; direct stays a separate opt-in). 'video' = keep-latest ring + current:'last' (late
  //   joiner pulls keyframe() instantly, frame() condenses to the last frame); 'audio' = short lossless
  //   queue. Frames are [frame, sentAt] — the wall-clock stamp feeds Media.attach* latency stats.
  //   publishOf is EAGER (the account's lines exist the moment the connection is wired) and re-resolves
  //   per frame — a dropAccount'ed account revives on its next publish.
  // WATCH ACL: wire `media.watch = relay.watchOf(thisConnectionAccount)` — a per-watcher view whose
  //   Proxy has/get traps run canWatch(watcher, owner, line) on EVERY rpc path resolution (the dynamic
  //   walk does `seg in curr` + `curr[seg]` per call), so new subscribe/keyframe/frame are gated live —
  //   "media access follows the call" is app code: grant on 'active', revoke on 'ended'. Revocation
  //   also filters every forwarded frame/keyframe on an already-open policy view; the subscription
  //   stays allocated but receives no data. dropAccount(owner) closes its lines loudly.
  //   Views are cached per (watcher, owner) — stable node identity for the wire. An owner key is
  //   visible only if at least one line passes the policy (no keyspace metadata leak).
  //   `watch` (unfiltered global map) stays for trusted wiring (demo/single-tenant); prefer watchOf.
  //   dropAccount also clears the account's watcher-view cache both as owner and as watcher.
Peer.createCallManager({port, self, ringTimeoutMs? = 30000, incoming?}) -> {ready, call(peer, meta?), rings, active(), close()}
  // messenger-style calls as envelopes over the EXISTING signal port (callPortOf(remote) flattens the
  //   fragment proxy) — zero new server surface; pair = 'call:<id>' never collides with route pairs.
  //   ready = registration ack (a self-probe rides the same ordered socket AFTER the subscribe — before
  //   it, a hub-emitted ring could be lost: plain Listen, no journal, by design). call() -> handle:
  //   {id, peer, direction, meta, state() 'ringing'|'active'|'ended', reason(), changed, ended: Promise,
  //   accept(), decline(reason?), hangup()}. Ends: 'declined'|'busy'|'offline' (send verdict false —
  //   fails FAST, no timeout)|'timeout' (both sides expire)|'hangup'|'canceled' (ringing side)|'closed'.
  //   incoming(info) gate: false = auto-decline 'busy'; the default gate declines during any live call,
  //   which also settles glare (both call each other -> mutual busy). Media is NOT owned by the call
  //   layer: on 'active' the app publishes/attaches relay lines itself (Media.attach* viewers).
  //   Oracle: replay/peer-call.test.ts (real Socket.IO/RPC wire, presence + calls + media relay).
serveReplayChannel(source, channel) <-> channelReplayRemote(channel) -> ReplayRemote
  // replay wire over ANY ordered string channel (datachannel/MessagePort/worker/pipe): tiny JSON
  //   sub/req/res protocol, no RPC core — a direct channel lives OUTSIDE the main rpc connection.
  //   Channel close = non-envelope (null) on the line: replay subscribers report onError, never silence.
  //   ReplayMessageChannel = {send, onMessage, onClose?, close?}; channelFromDataChannel(dc) adapts a
  //   datachannel (and owns its handlers). Oracle: replay/route-webrtc.test.ts (fake RTC runtime +
  //   in-proc hub + the same signaling over a real Socket.IO/RPC wire).
exposeStoreReplay(store, opts?)  <->  syncStoreReplay(mirror, remote, opts?)            // layer B: patch line; keyframe = root patch ({path: [], value: snapshot})
syncStoreReplayRoute(mirror, remote, opts?) -> off & {ready, switch(nextRemote, opts), seq(), label(), active()}   // same patch fold, but route-replaceable for relay/direct promotion
syncStoreReplayEach<T>(remote, cb, opts?) -> off & {store, ready, seq(), isStale(), lastTs()}   // one-call per-key fold over the patch line (mirror + syncStoreReplay + store.each()); most-used surface — full contract + example in wenay-common2.md
createOfflineStore({key, remote?, initial, storage, version?, debounceMs?, syncOpts?}) -> Promise<OfflineStore<T>>
  // snapshot-mode persisted mirror: read local {version,seq,snapshot,savedAt}, create a normal Store immediately,
  // then syncStoreReplay(..., {since: savedSeq}) when remote exists. reconnect(remote) attaches later after offline start.
persistStore(store, {key, storage, seq?, debounceMs?}) -> control
  // durable writes are snapshot+seq in one record; flush()/forceFlush(); statusListen emits ready/syncing/offline/stale/saving.
createMemoryOfflineStorage(initial?) -> OfflineStorage & {dump()}
  // test/reference adapter. Browser IndexedDB/SQLite/file storage should implement the same OfflineStorage lambdas.
  // Real wire oracle: `npx tsx replay/offline-store-socket.test.ts` (Socket.IO + RPC + persisted cache).
conflateReplay(replay, {pending, highWater, lowWater?, pollMs?, keyOf?, maxKeys?}) -> {api, close, stats}  // layer D.1: per-connection gate — pending() over highWater -> deltas DROP (never queue);
  // drained -> fresh keyframe on the SAME line, seq dedup cuts the overlap; pending() = e.g. socket.conn.writeBuffer.length
  // build per connection where the rpc server is built; api spreads in place of exposeReplay(...); close() on disconnect
  // one-call form: exposeReplay(replay, {conflate: opts}) -> {line, since, keyframe, close, stats} — same gate, wiring collapsed;
  //   destructure aside (const {close, stats, ...api} = ...) — close/stats must NOT reach the rpc object (they'd become remotely callable)
  // keyOf (@deprecated — declare `frame` on the LINE instead; held-map path kept working for old calls):
  //   while lagged keep the LAST envelope per key, drain -> tail of those (ascending seq) instead of a full keyframe;
  //   events must be ABSOLUTE per key (store patches are — use storePatchKey from Observe); keyOf -> null or over maxKeys (1024) -> degrade to keyframe recovery
  //   exposeStoreReplay declares its condensing frame automatically (last patch per exact path) — zero config for stores
ReplayStorage = {putEvent, putKeyframe, getKeyframe({seq?|ts?}?), getEvents(from, to)}   // layer C: archive behind 4 lambdas (file/DB/anything); createMemoryReplayStorage(caps?) = reference impl
archiveReplay(replay, {storage, everyEvents? = 64, everyMs?}) -> {close, stats}          // event log + keyframe cadence (every N events OR T ms of line-ts, whichever first; frames only ON events)
openHistory(storage, live?) -> {at({seq?|ts?}?), subscribe(cb, {since?|ts?, onSeq?}) -> off}   // seek + playback, SAME subscriber interface; with live: archive -> live journal -> live handover
  // seamless rewind->live: create the line with getSince reading the same storage («memory outside»); else the gap closes with a keyframe jump (still consistent)
storeReplayAt(storage, {seq?|ts?}?) -> snapshot | undefined                              // store time machine: bit-exact state at any archived moment (same applyStorePatch mechanism)
```
> Killer property for state/frame lines: a lagging/late/stalled consumer can replace backlog with a state-equivalent frame/keyframe. A sacred queue deliberately does not: its retained tail is exact, and eviction is a terminal error rather than silent loss.
> Files: `src/Common/events/replay-{listen,wire,conflate,history,index}.ts` + `src/Common/Observe/store-{replay,offline}.ts`;
> everything is additive (the canonical Listen surface gained only `registerListenOn`/`ListenOnBrand`; exposeStore/mirror untouched).
> Oracles: `npx ts-node replay/<f>.ts` — replay-listen / store-replay / offline-store / socket-replay / offline-store-socket / conflate / conflate-socket / coalesce / history / staleness / canvas-socket (raw bytes) / video-socket.demo;
> wire coverage also lives in the RPC harness cookbook (`npm run test:rpc`).

## 🔁 Observe — coarse reactive object (`Observe`, fact-based)
> `import { Observe } from "wenay-common2"` → `Observe.reactive(...)`.
> Coarse fact-based core: no public deltas, no string-path event API, no computed graph in core.
> Subscribe to the fact that a subtree changed, then re-read the current state.
```
const state = Observe.reactive({
  account: {
    balances: {BTC: 100, ETH: 400},
    positions: {BTC: {qty: 0.5, entry: 60000}},
  }
})

Observe.onUpdate(state.account, () => console.log("account changed"))
Observe.onUpdatePaths(state.account, ({paths}) => console.log(paths)) // optional dirty paths, relative to account
Observe.onUpdate(state.account.positions, () => console.log("positions changed"))
Observe.onUpdate(state.account.positions.BTC, () => console.log("BTC changed"))

state.account.positions = {BTC: {qty: 3, entry: 59000}, SOL: {qty: 10, entry: 130}}
await Observe.flushReactive(state)
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
  accountChanged: Observe.listenUpdate(state.account),
  accountChangedPaths: Observe.listenUpdatePaths(state.account),
  btcChanged: Observe.listenUpdate(state.account.positions.BTC),
}
// createRpcServerAuto({ object: facade, ... }) exposes accountChanged/accountChangedPaths/btcChanged
// as normal RPC Listen subscriptions. This is a notification stream, not a full
// automatic snapshot mirror; send/read snapshots explicitly via facade methods.
```
