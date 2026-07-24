# wenay-common2 — EXTENDED cheat sheet (notation)

> The full surface. For everyday helpers use **`wenay-common2.md`** (brief). Root import:
> `import { ... } from "wenay-common2"`. Notation: `name(args) -> ret  // note`. Short names are
> canonical. Removed old names are listed in `NAMING_RENAMES.md`.
> Public raw-IP/hostname HTTPS/WSS demo, certificate issuance, router ports, and diagnostics → **[`DEMO-HTTPS.md`](DEMO-HTTPS.md)**.

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
  // opts.binary is negotiated independently and defaults off. Without an explicit binary option, application
  //   traffic stays on JSON arrays. With binary:true on both peers, a correlated Uint8Array probe must round-trip
  //   before either peer switches application traffic. Peers which both advertise BINARY_MSGPACK select universal
  //   msgpackr binary v3; otherwise BINARY_SCHEMA selects typed-schema v2, BINARY selects v1, and peers without
  //   BINARY keep legacy arrays. CAPS/MAP/auth stay legacy arrays,
  //   while the v2 PROBE/ACK byte payload exchanges predeclared schema descriptions before application data.
  //   `{msgpack:false}` pins schema-v2, `{schema:false}` pins v1; absent/false binary
  //   on either side or an old peer keeps every application packet on the unchanged legacy path. ready()/hub connect
  //   waits for correlated caps and the probe; a byte-blocking adapter selects correlated raw after 250 ms. A late
  //   ACK upgrades future calls and migrates declared Listen subscriptions without duplicating their consumers.
  //   RPB/3 encodes the complete existing RPC packet with msgpackr records, so CALL, RESP, PIPE, callbacks,
  //   callback batches, errors and Store use one implementation. Frames are independently decodable and reuse
  //   record definitions for repeated layouts inside a frame; there is no route-specific or cross-message catalog.
  //   It preserves ordinary primitives, undefined, NaN/infinities, BigInt, rich values and binary views. Scalar -0,
  //   sparse holes, lone UTF-16 surrogates and null-prototype identity follow msgpackr normalization.
  //   RPB/2 and RPB/1 exactly preserve undefined, false, true, null, integer/float/-0/NaN/infinities, strings (including
  //   lone surrogates), BigInt, sparse arrays, plain/null-prototype objects and canonical native values: Date,
  //   RegExp, Map, Set, ArrayBuffer, DataView and standard TypedArrays. RegExp v1 requires the standard lastIndex=0
  //   state. Native expandos fail closed where they can be checked without enumerating every binary index; a large
  //   TypedArray's declared value domain is its exact type plus active bytes, not arbitrary expando properties.
  //   Callback references have a private binary tag; the old marker strings are ordinary business data in this mode.
  //   A top-level function result, symbols, cycles, accessors, class instances and non-standard TypedArrays fail
  //   the one RPC request instead of corrupting the cache. Function-valued properties of an otherwise data result
  //   are omitted through a rare fallback, matching the legacy JSON projection. Protocol v1 also rejects Float16Array,
  //   resizable/growable buffers and runtime-new RegExp flags/source constructs which a supported Node 16 peer could
  //   not reconstruct with the same semantics.
  //   V2 schema identity contains object prototype + ordered keys (or tuple positions) + physical field types.
  //   Constants use zero payload bytes, booleans use bitmaps in runs, and integer/float/string/nested lanes carry no
  //   repeated per-field tags. Homogeneous and segmented arrays use one schema id per run at any nesting depth;
  //   wide dynamic-key objects (including a 15,000-entry Store snapshot) carry one key dictionary plus typed value runs.
  //   A string/number/false change selects another schema; it is not a validation error. Rare layouts use the exact
  //   generic binary escape until their frequency reaches `promotionThreshold` (default 3). Candidate tracking and
  //   admitted schemas are bounded; only admitted schemas consume the direction-local 1,000-id wire table.
  //   `opt.binary.predeclared` accepts representative runtime values, recursively extracts descriptions and sends
  //   only those descriptions in the probe. No representative value is transmitted. Each definition is announced
  //   once per direction/connection generation; following values carry its short schema id. Dynamic inference
  //   continues in the remaining table. `maxSchemas`
  //   controls v2; legacy `maxShapes` remains the v1 setting and is also the v2 default when maxSchemas is absent.
  //   `{msgpack:false}` pins v2; `{schema:false}` pins v1; `binary:false` pins legacy arrays.
  //   ArrayBuffer, DataView and every supported TypedArray are direct binary leaves: their subtype/range and bytes
  //   enter the typed lane without first becoming a generic object or a nested binary wrapper.
  //   Definitions commit only after successful emit/full decode; reconnect, server replacement and rollback reset
  //   cache/session state. A malformed stateful frame in either direction rejects pending work and negotiates a fresh
  //   session before any shape reference is reused. Independent logical clients sharing one socket/key receive
  //   isolated correlated sessions; anonymous pre-correlation caps may enable only historical COMPACT, never another
  //   client's batch/binary policy.
  //   Once the correlated byte probe establishes the negotiated socket, application values use the trusted reader:
  //   framing, msgpack values, callback refs and (for v2) schema ids are interpreted directly without Zod, semantic
  //   field validation or duplicate/canonical-value scans. With no explicit client `limits`, there is no second result walk;
  //   opting into tighter client limits adds only a lightweight decoded-value budget walk. The sender classifies the
  //   actual JS layout before writing; the receiver follows the transmitted physical schema.
  //   Envelope/session routing, byte boundaries and explicit size limits remain part of framing; the standalone
  //   codec's checked decode entry remains available for data which did not arrive through that negotiated channel.
  // opts.callbackBatch is negotiated independently of binary and compact shapes. Default new/new transport batches
  //   same-microtask callbacks losslessly as Pkt.CB_BATCH (64 items / 64 KiB); RESP, errors and CB_END are ordering
  //   barriers. Binary batches become one binary attachment; legacy peers retain the JSON packet path. Set false on
  //   either side for packet-per-callback delivery. Reconnect renegotiates every transport generation. Batch sizing
  //   walks the value with a counting writer instead of allocating a throw-away frame; an obviously indivisible
  //   large binary callback is validated and encoded once. These are CPU/allocation fast paths only: wire bytes,
  //   call-time snapshot semantics, limits and ordering are unchanged.
  //   The binary value writer encodes UTF-8 into its destination and uses an exact Number varint path for safe
  //   integers, with BigInt retained for the rare zigzag boundary which cannot be represented exactly as Number.
  //   Decoding handles the complete +/-MAX_SAFE_INTEGER range without transient BigInt. Boundary/random tests compare
  //   every emitted integer byte with the original BigInt definition, so this optimization does not add a wire mode.
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
  // on/once also accept {current?:boolean}; true is narrowly forwarded to a server listenStore/current provider.
  // typed projection: client.func as unknown as DeepSocketListen<ServerFacade> (usually hidden behind a local webListen(client) helper).
  //   replay members project as ReplaySocketListen<Z> automatically (legacy surface + line/frameLine/since/keyframe/frame,
  //   tuples preserved end-to-end) — client.func.key passes to replaySubscribe as is, no casts.
  //   The same projection is built into BOTH typed-client paths (ClientAPIAll/ClientAPIStrict): on a plain rpc<T>() client
  //   replay members are already ReplaySocketListen on client.func/client.strict — no webListen and no casts for them
  //   (plain Listen members still need the DeepSocketListen projection).
  //   Late local subscribers receive the latest tuple observed by the shared physical subscription. The cache is
  //   cleared on disconnect/reauth; function-valued providers/options do not cross the wire.
  // off is callable + thenable: off() unsubscribes; await off waits for stream end.
  // *First/*All/*Smart differ only in callback arity: first arg / all args / single-vs-tuple smart.
matchKeys(a,b) · matchKeysList(a, keys) · deepMapByKeys · deepMapByKeysList
// wire serialization (rpc-walk): Date/Map/Set/RegExp/BigInt are marked+restored; functions -> callback refs.
//   TypedArray/DataView/Buffer/ArrayBuffer pass through as BINARY leaves (socket.io carries them natively;
//   never rebuilt into {0:…,1:…} dicts — raw canvas/video byte payloads are wire-safe and cheap).
RpcLimits (opt, per server/client): maxDepth 32 · maxKeys 1000 · maxArgs 64 · maxArrayLen 10k
  · maxStringLen 1M · maxCallbacks 100 · maxPathLen 16 · maxBinaryLen 8MB (bytes per binary leaf)
  // Binary RPC also has non-disableable protocol ceilings: application depth 32 plus four RPC-wrapper levels,
  //   10k array/Map/Set items, 1k object keys, 1,024 callback refs per complete frame,
  //   1M string code units/encoded bytes, 8,192-bit BigInt, 16MB per binary leaf, 32MB per complete frame and
  //   1M decoded value-work units. A result/callback/error outside that envelope fails explicitly in binary instead
  //   of falling through old marker/JSON encoding, because that could change -0/NaN/sparse data or marker-shaped
  //   objects. Server results, callback snapshots and error data are checked against server limits before copying or
  //   binary serialization. The same binary generation remains usable. Client `limits` are checked on the decoded
  //   application boundary after the protocol-hard bounded decode; omitting them adds no lower policy limit.
  //   `binary:false` forces legacy throughout.
// modes: func (proxy) · strict (schema-safe) · pipe (whole chain in one packet) · space (fire-and-forget)
// legacy (oldCommonsServer.ts, @deprecated forwarders onto oldCommonsServerMini — identical wire):
//   funcPromiseServer->promiseServer · funcForWebSocket->wsWrapper · funcScreenerClient2->createClientProxy
//   CreatAPIFacadeServerOld->createAPIFacadeServer ; CreatAPIFacadeClientOld & funcPromiseServer2 kept as-is
```

### RPC application wire versions

Negotiation is per socket generation and always chooses the newest mode advertised by both peers.
The control/bootstrap path remains backward-readable, so a new endpoint does not send an unknown
application envelope before agreement.

| Wire | Selected when | Application representation | Compatibility role |
|---|---|---|---|
| Legacy RPC arrays | either side disables binary, or a peer has no `BINARY` capability | Existing CALL/RESP/PIPE/callback/error arrays and native transport attachments | Unchanged old-client/old-server path and final mixed-peer fallback |
| RPB/1 | both peers have `BINARY`, but either lacks `BINARY_SCHEMA`; also `{schema:false}` | Versioned byte envelope with exact tagged values and its bounded ordered-layout cache | Binary compatibility bridge for a new peer talking to the previous binary implementation |
| RPB/2 | both peers have `BINARY_SCHEMA` but not `BINARY_MSGPACK`, or `{msgpack:false}` | Universal typed-schema envelope: predeclared and dynamically promoted schemas, field-major typed runs, constants/boolean bitmaps, exact generic escape and direct binary leaves | Exact compatibility mode for the previous new/new implementation |
| RPB/3 | both peers have `BINARY_MSGPACK` | The complete existing RPC packet encoded once by msgpackr records into one byte envelope | Current new/new mode; CALL, RESP, PIPE, callbacks, callback batches, errors and Store v7 share one codec |

RPB/3 and RPB/2 do not run Zod or application-semantic validation over negotiated values. RPB/3
uses independently decodable frames, with record definitions shared inside each complete packet.
RPB/2 retains its connection-generation schema table. In that mode, the sender
classifies the actual JavaScript representation; a different representation selects another schema
or the exact generic escape. Framing opcodes, byte boundaries, schema ids, callback references and
explicit resource limits are still decoded because they define the wire itself. Predeclared schemas
reserve their ids in PROBE/ACK before application traffic; dynamic heavy-hitter promotion fills the
remaining direction-local table up to 1,000 entries. Definitions are transmitted once per
generation, then referenced by id. Reconnect or server replacement resets the table and sends the
prelude again.

### HTTP facade server: static GET/POST mirror

`createHttpFacadeServer` is exported only from `wenay-common2/server`. It receives a caller-owned Express app and
walks the supplied object once at server setup. Every nested enumerable string-keyed function becomes a route whose
URL segments match its object path:

```ts
import express from 'express'
import {createHttpFacadeServer} from 'wenay-common2/server'

const app = express()
app.use(express.json())

const facade = {
    journal: {
        history: (kind: string, limit: number) => readHistory(kind, limit),
    },
}

createHttpFacadeServer({
    app,
    object: facade,
    method: 'get',
    basePath: '/inspect',
    middleware: checkAuth,
})

createHttpFacadeServer({
    app,
    object: facade,
    method: 'post',
    basePath: '/inspect',
    middleware: checkAuth,
})
```

This registers both `GET /inspect/journal/history` and `POST /inspect/journal/history`. GET reads positional arguments
from the `args` query as one JSON array. POST accepts `{args: [...]}` or a raw `[...]` JSON body. No `args` means an
empty argument list. Responses are `{ok: true, value}`; thrown values become `{ok: false, error}` with HTTP 500,
malformed input is HTTP 400, and `RpcLimits` violations are HTTP 413. `routes()` returns the registered method,
object path, and URL for inspection.

The existing RPC walk codec restores Date/Map/Set/RegExp/BigInt request values and packs them in results. This is not
a callback or binary transport: function signatures cannot be discovered at runtime, so callback/Listen-shaped
functions are registered like every other function and callers are responsible for not invoking them through HTTP.
Use an explicit download endpoint for bytes. The adapter preserves a function's parent as its invocation context,
rejects circular facade branches and forbidden RPC keys, and rejects repeated registration of the same app, method,
and URL. Dynamic keys added after setup do not create new routes; call the factory only after the static facade is ready.

Register this adapter once next to the HTTP server, not inside a Socket.IO `connection` callback. Authentication,
rate limiting, and network exposure remain ordinary Express middleware concerns. GET routes must stay read-only
because browsers and intermediaries may cache or prefetch them.

Living stand example: `npm run demo` registers the same safe diagnostics object for both methods and prints the URLs:

```text
GET  /http-facade/demo/status
POST /http-facade/demo/echo    {"args":["hello"]}
```

Both routes require `Authorization: Bearer <token>`. Set `DEMO_HTTP_FACADE_TOKEN` for a stable token; otherwise the
stand generates one for that run and prints it beside the URLs. Authorization runs before the POST JSON parser. The
example lives in `demo/server.ts` and deliberately exposes only status/echo rather than the account-scoped RPC facade.

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

## 🤖 AI — provider-neutral run protocol

`Ai.createAiRunHost({runner, capabilities?, policy?, id?, now?, history?, drain?})` adds a generic
model/tool workflow beside existing RPC keys. It is intentionally not an SDK for a particular model:
the application runner chooses a provider, prompt, tool implementations, persistence and billing;
the host owns safe lifecycle semantics on the socket boundary.

```ts
type AiRunRequest = {
  requestId: string               // required, owner-scoped idempotency key
  kind: string                    // capability name, e.g. 'assistant'
  input: unknown                  // runner-only; never copied into Store
  resourceIds?: string[]          // opaque Resource ids, never file bytes
}

type AiRunState =
  'queued' | 'running' | 'waiting_input' | 'waiting_approval' |
  'completed' | 'failed' | 'cancelled'

type AiRunRunner = {
  run({run, input, resourceIds, report, emit, artifact,
       requestApproval, waitForInput, cancelled}) -> {result?, usage?} | Promise<...>
  cancel?({run, reason?}) -> void | Promise<void>
}

const host = Ai.createAiRunHost({runner, capabilities: [{kind: 'assistant'}]})
const conn = host.connection(account)
createRpcServerAuto({object: {...legacy, ai: conn.fragment}, ...})
disconnectListen.on(conn.close)

const client = Ai.createAiRunClient({remote: rpc.func.ai})
client.events.on(event => renderDeltaOrApproval(event)) // attach before ready if initial sync matters
await client.ready
const run = await client.createRun({requestId, kind: 'assistant', input: {prompt}, resourceIds})
```

The fragment exposes `capabilities()`, `state` (account-filtered Store patch replay), `events`
(account-filtered semantic replay), `createRun`, `cancelRun`, `resolveApproval`, and `provideInput`.
`AiRunStore` has `{runs, approvals, inputs}`; raw values supplied to `provideInput` are resolved into
the runner only and are not written to Store. Default `AiRunPolicy` is owner-only;
`canCreate`/`canRead`/`canWrite` add tenant, quota or delegated-access policy.

Event contract:

- Runner-controlled live events: `text.delta`, `notice`, `tool.call`, `tool.result`.
- Host-controlled lifecycle events: `started`, `progress`, `artifact`, approval/input requested or
  resolved, `completed`, `failed`, `cancelled`.
- An event replay keyframe is a `sync` event containing the caller's currently authorized runs,
  approvals and input metadata. Use durable `run.result` for a complete transcript/result after a
  reconnect; deltas are an enhancement, not the only copy of user-visible output.

`requestId` is the crucial command rule: ordinary RPC calls never replay after transport loss, so an
application may intentionally retry `createRun` with the same id. The host returns the original run
and never invokes the runner twice. Cancellation immediately marks state terminal, rejects pending
input/approval waits, calls optional `runner.cancel`, and ignores every later report, event and result.

Security boundary: resource bytes, storage/provider keys, reusable URLs, arbitrary browser callbacks,
and raw chain-of-thought do not cross this API. Let the application adapter fetch a `resourceId` from
its authorized storage port; use `artifact({resourceId, descriptor})` for small output descriptors.
Tool execution stays server-side. If a tool needs user consent, the runner calls `requestApproval` and
waits for `resolveApproval`; it must never execute a browser-provided callback. The full rationale and
integration recipe are in `doc/AI-RUN-PROTOCOL.md`. Oracle: `replay/ai-run.test.ts` (real Socket.IO/RPC,
ACL, idempotent retry after a new connection, approval/input, provider cancellation and late-output guard).

## 🧩 Artifact — storage-backed descriptor and sandbox runtime

`Artifact.createArtifactHost({storage, policy?, id?, now?, history?, drain?})` is the explicit
boundary between AI/resource output and an interactive browser surface. A trusted server-side runner
first writes bytes into its own provider, then calls `host.register({owner, descriptor, storageKey,
retention})`. `storageKey` remains in the host's private registry; the account-filtered Store/replay
contains only `{id, owner, descriptor, state, retention, createdAt, updatedAt}`.

```ts
type ArtifactDescriptor = {
  kind: string
  label: string
  runtime: 'sandboxed-iframe' | 'download'
  mime?: string
  version?: string
}
type ArtifactRetention =
  | {class: 'ephemeral'; expiresAt: number}
  | {class: 'persistent'; expiresAt?: number}
type ArtifactStoragePort = {
  open({artifact, storageKey, account}) -> {url, expiresAt} | Promise<...>
  remove?({artifact, storageKey, reason: 'revoked' | 'expired'}) -> void | Promise<void>
}

const host = Artifact.createArtifactHost({storage})
const connection = host.connection(account)
createRpcServerAuto({object: {...legacy, artifacts: connection.fragment}, ...})

const client = Artifact.createArtifactClient({remote: rpc.func.artifacts})
await client.ready
client.store.state.artifacts[id]                 // descriptor/lifecycle only, never bytes/key/URL
const open = await client.open(id)               // one authorized, short-lived storage instruction
await client.revoke(id)                          // owner-only by default
await host.reap()                                // server scheduler decides when expiry is enforced
```

`connection(account).fragment` exposes only `state`, `open`, and `revoke`; registration and reaping
stay server authority. `ArtifactPolicy.canRead` defaults to owner-only, `canRevoke` controls visible
lifecycle writes, and `canRegister` is the tenant/quota hook for a trusted runner. `open` checks ACL,
ready state and expiry before calling storage; the adapter must enforce the same rules at its own
short-lived URL boundary.

For `sandboxed-iframe`, `createArtifactFrame({artifacts, frame, allowedOrigins})` requires an explicit
client allowlist and sets `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, and no feature
allow-list. It deliberately omits `allow-same-origin`, browser permissions and every parent bridge.
Serve executable bytes from a dedicated cookie-free origin with restrictive CSP; do not use `srcdoc`,
inline HTML from Store, or a same-origin convenience URL. `download` is a descriptor only in this
slice; the application opens its authorized storage instruction itself.

`ephemeral` requires an expiry; `persistent` documents a storage decision, not magical persistence:
the in-memory host and replay journal are not a database. A restart-safe deployment persists metadata
and the private provider-key mapping in its storage/application adapter, uses immutable/versioned
objects, and owns quotas, malware scanning, encryption, legal hold and audit retention. `revoke`/`reap`
make content unopenable immediately and call optional `storage.remove`; on removal failure the host keeps
the private key so a later revoke/reap can reconcile it. An adapter may retain a tombstone or archive.

Detailed design and stand assumptions: `doc/ARTIFACT-RUNTIME.md`. Oracle:
`replay/artifact-runtime.test.ts` (real Socket.IO/RPC owner ACL, no key/URL in Store, short-lived
open, iframe origin pinning, expiry and storage cleanup). `npm run demo` visibly creates an
AI-linked counter artifact at `artifact.localhost`, mounts it in the sandboxed iframe, and revokes it.
The public HTTPS launcher provisions a separate `artifact.<sslip-host>` certificate, pins that origin
through RPC, and restricts its proxy to `/artifact-open/*`; executable bytes never fall back to the
application origin.

## 💬 Conversation — logical channels, versioned blocks and scoped facts

`Conversation.createConversationHost({persistence?, initial?, policy?, id?, now?, history?, drain?})`
owns the authorized working projection for conversations, channels, immutable messages and facts. It
does not introduce a transport, run a model, fetch file bytes or execute an artifact. Each authenticated
RPC connection receives a filtered fragment from `host.connection(account)`:

```ts
const host = Conversation.createConversationHost({
  persistence: {
    // Persist both values atomically and idempotently before resolving.
    commit({event, receipt}) { return journal.commit(event, receipt) },
  },
  initial: {store: rehydratedProjection, receipts: rehydratedReceipts},
})
const connection = host.connection(account)
createRpcServerAuto({object: {...legacy, conversation: connection.fragment}, ...})
disconnectListen.on(connection.close)

const client = Conversation.createConversationClient({remote: rpc.func.conversation})
client.events.on(event => renderSemanticEvent(event))
await client.ready
```

The fragment exposes `state`, `events`, `createConversation`, `createChannel`, `postMessage`,
`upsertFact` and `retractFact`. `ConversationPolicy.canCreate/canRead/canWrite` runs on the host; by
default the creator and explicit `participantIds` can read and write. A guessed id never reveals an
empty shell. All mutations are serialized and require an account-scoped `requestId`; a retry returns
the first entity, while reusing that id for another command fails.

`host.control` is the trusted server facade. It adds `appendMessage(account, input)` for
assistant/system authors and accepts optional AI-run/system provenance on `upsertFact`; its `store`
is the server projection only. The client facade exposes the mirrored `store`, semantic `events`,
`stateSeq`/`eventSeq`, lifecycle `close`, commands, and derived sorted views:
`conversations()`, `channels(conversationId)`, `channelMessages(channelId)` and
`channelFacts(channelId)`.

Messages accept one or more `{kind, version: 1, ...}` blocks. Built-ins are plain `text`, stable-item
`list`, column/row `table`, references to a `fact`, `resource` or `artifact`, and namespaced `custom`
data. Payloads are copied as JSON-like values and reject non-finite numbers, sparse arrays, cycles,
functions, symbols, class instances, accessors and prototype-polluting keys. Renderers must treat
unknown custom types as inspectable data. HTML/JS and application execution stay in `Artifact`.

Facts are keyed by `(conversationId, scope, namespace, key)`, keep a stable id and increment their
revision on each upsert/retraction. `expectedRevision: 0` means create-only. An `inherit` channel sees
conversation facts, then ancestor and local channel facts with the narrower scope winning; an
`isolated` channel sees only its local facts. A narrower retracted fact remains a tombstone and hides
the inherited value instead of revealing it again.

The persistence port receives `{event, receipt}` before Store/event visibility. Persist them in one
transaction and rehydrate both; receipts are deliberately absent from every client Store. Without the
adapter the host is in-memory. Replay `history` bounds reconnect/event replay, not durable message
retention: partition the host or add archive pagination before accepting unbounded chat history.

Detailed contract: `doc/CONVERSATION-RUNTIME.md`. Oracle: `replay/conversation-runtime.test.ts`
(real Socket.IO/RPC ACL, typed blocks, fork, fact inheritance/conflict/tombstone, persistence failure,
idempotent restart and reconnect). `npm run demo` exercises the same flow with two participants.

## 🔗 Contract — versioned implementation runtime

> `import { Contract } from 'wenay-common2'` or
> `import * as Contract from 'wenay-common2/contract'`.

The namespace is additive and independent of frontend/build tooling:

```ts
Contract.createContractOffers(initial?) -> {
  control: {upsert(offer), remove(id), replace(offers), clear()},
  api: {list(), changes},
}

Contract.resolveContractBinding({demand, offers, policy?, unavailable?}) -> Promise<{
  demand, candidates, accepted, selected,
}>

Contract.createContractRuntime({offers?, policy?, retryMs?, drainTimeoutMs?, history?, now?}) -> {
  control: {
    require(demand), apply(demands), release(slotId, reason?),
    addOffer(offer), removeOffer(offerId), replaceOffers(offers),
    revokeOffer(offerId, reason?), restoreOffer(offerId),
    reconcile(slotId?), rollback(slotId),
  },
  api: {status, changed, binding(slotId), acquire<T>(slotId), explain(slotId), history()},
  close(),
}
```

`ContractDemand` is
`{slotId, contractId, versionRange, generation, authorityId, authorityEpoch, required?, capabilities?, proof?}`.
Its default order is higher authority epoch, lexical authority id, then higher generation. An exact
replay is idempotent; different contents at the same coordinate are a conflict. Override the order
only with `policy.compareDemands`.

`ContractOffer<T>` is a reusable capability:
`{id, descriptor, priority?, open(ctx) -> ContractSession<T>}`. The descriptor protocol is `1` and
separates `contractVersion`, `implementationVersion` and optional `runtimeVersion`; it may also carry
`integrity`, `capabilities` and opaque `proof`. A session is
`{api, onFail?, drain?, close}`. It is not a package archive or an already-live singleton.

Exact version equality is the default compatibility rule. `policy.compatible`, `acceptDemand`,
`acceptOffer`, `acceptSession`, `compareOffers` and `compareDemands` are the explicit extension seams.
Required capabilities are checked before `open`. Higher offer priority wins, then stable id.

Replacement is prepare-before-switch: the current session remains active until the candidate has
opened and passed `acceptSession`. `api.acquire` returns `{api, binding, release}`; a retired session
drains only after its leases release or `drainTimeoutMs` expires. An open or active-session failure
suppresses the offer for `retryMs` and tries the next compatible candidate. Revocation is reversible;
rollback reopens the previous offer only if it still satisfies the current demand and policy.

Slots report `idle | resolving | preparing | active | degraded | failed | closed`. `required:false`
with no offer is degraded; a required slot fails. `api.status` is an Observe Store, `changed` emits
binding transitions, and `explain` exposes candidate rejection reasons. `history()` is bounded by the
runtime option.

The upper application builds/downloads/loads JavaScript, WebGL or native bundles and turns them into
offers. This library deliberately does not compile TypeScript at runtime, run a package manager,
mount UI, fetch a CDN or own a Service Worker. Long-lived Store/replay and connection resources are
injected below replaceable implementations. Detailed lifecycle and authority contract:
`doc/CONTRACT-RUNTIME.md`. Oracles: `observe/contract-runtime.test.ts` and
`oracle/realsocket/contract-runtime.spec.ts`; browser stand: `npm run demo` → Lab.

## 🎙️ Media over socket — browser capture as binary Listen
> `import { Media } from "wenay-common2"` or `import * as Media from "wenay-common2/media"`.
> The hot path event is ONE `Uint8Array`: fixed 40-byte common2 media header + raw payload. No JSON envelope.
> External browser capture needs a secure context; use [`DEMO-HTTPS.md`](DEMO-HTTPS.md) to obtain and verify the demo certificate.
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
- default snapshots, not a 30fps video stream: JPEG, `fps` default 3, `quality` default 0.82; `fps:0` runs an unpaced capture-after-encode pump for throughput measurement.
- each frame carries absolute image bytes, so `replay:true` can safely keep the latest frame for lag recovery.
- capture is hidden-tab-proof by default (Chrome throttles hidden tabs three ways, each stage has its own escape): the tick comes from a Blob-worker timer (in-page `setInterval` drops to ~1/s), the frame comes from `ImageCapture.grabFrame()` when available (a hidden `<video>` stops painting; `<video>->canvas` stays as the fallback), and JPEG encode runs in a worker over a transferred `ImageBitmap`, returning a transferred `ArrayBuffer` — never a structured-cloned frame (main-thread `convertToBlob` is gated to ~1s per call when hidden). `worker: false` opts out of all three into the plain in-page path.
- one explicit dimension (`width` or `height`) scales the other proportionally from the track resolution, downscale-only; pass both to force an exact size. `grabFrame`'s ~50ms serial latency caps the pipeline around ~15-20fps regardless of `fps`.

Viewer helpers (`media-view`): the consumer side of any media line (local pair or RPC surface).
- `attachVideoCanvas(line, canvas, {createBitmap?, onError?})` — per-frame codec/size come from the 40-byte header, canvas resizes to follow; decode overload is busy-skipped (keep-latest, `stats().frames` vs `stats().drawn` shows the gap); `createBitmap` injects a custom decoder (tests, OffscreenCanvas pipelines).
- `attachAudioPlayer(line, {maxBacklogSec? = 0.35, audioContext?, onError?})` — pcm16/float32 through a sequential playhead; a backlog past `maxBacklogSec` is dropped and the playhead rebases near "now" (live beats lossless; `stats().dropped` counts rebases). `enable()` must come from a user gesture (browser autoplay rules); `audioContext` injects a factory for tests/custom routing.
- `pipeMediaPublish(line, publish, {stamp? = true, onError?})` — fire-and-forget pipe into an RPC call; the default `Date.now()` stamp is what viewer `stats().ageMs` measures against. Both attach helpers also expose `stats().perSec` (rolling 1s rate).
- The canvas path gives an ordinary ArrayBuffer-backed payload directly to `Blob` (SharedArrayBuffer still receives an owned copy), closes every decoded bitmap after draw/error, and ignores an in-flight decode after `off()`. A synchronous publisher does not allocate a Promise; thenables retain asynchronous error routing.
- Oracles: `replay/media-view.test.ts` and `replay/video-windows-stress.test.ts`. The latter uses
  real Socket.IO/RPC with five synthetic participants, ten independent video windows, 96-512 KiB
  frames, ACL/rejoin/latest recovery, slow-render busy-skip and listener-leak teardown without
  requesting camera or microphone permissions.

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
`replay:true` makes the returned listen a `Replay.replayListen` surface before capture emits into it, so `createRpcServerAuto` brand-detects it and exposes legacy + replay under the same key. Defaults differ by media kind: audio replay is a sacred queue (`history:1024`, no keyframe/frame, do not drop samples); video replay is keep-latest (`history:8`, `current:'last'`, `frame` returns the newest covered frame). Pass `replay:{...}` for custom history/current/frame.

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
pushed.patchesBatch!.on((patches) => {
  Observe.applyStorePatches(mirror, patches)   // one bounded physical envelope; unchanged legacy patches stays available
})

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
// syncPatches prefers patchesBatch and falls back to patches; {batch:false} forces legacy.
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
- Dynamic node-cache entries are pruned after their state path is deleted unless that path still has a `node` subscription; the subscription keeps its node identity until its final `off()`. Remote `set`/`replace` and the Replay journal write/read raw state, so transient wire keys do not materialize path nodes.
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
- `cloneStoreValue(value)` exposes that detached Store snapshot clone for boundary adapters; it preserves cycles, rich values and binary views.
- `listenStorePatches(store)` is the shared settled source behind Replay/push: one absolute patch array per natural Store drain. A bounded `patchesBatch` transport may split that source array.
- Fresh batch keyframes encode the owned `snapshot()` directly instead of cloning the complete tree a second time. Live/history/frame events remain defensively detached. Snapshot and columnar materialization use direct own-data writes only when the prototype chain has no setter/non-writable collision; otherwise they retain descriptor-based writes, including `__proto__`.
- Store paths may contain data keys such as `__proto__`, `constructor` and `prototype`: application uses own-property writes, so they do not mutate prototypes. Replicated Map deliberately has a narrower RPC-safe key contract below.
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
exposeReplay(replay)  <->  replaySubscribe(remote, cb, {since?, onSeq?, staleMs?, onStale?, skewMs?, now?, policy?, hint?, catchUp?, gapPolicy?, prepareCatchUp?}) -> off   // wire pair over the EXISTING rpc: line = plain Listen, since/keyframe/frame = plain methods
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
  // catchUp:'tail' bypasses frame compaction; gapPolicy:'error' rejects an evicted or non-contiguous tail/live jump.
  // prepareCatchUp({initial,since}) is an advanced async identity gate; {reset:true} requests a fresh keyframe.
  // Delivery commits seq only after cb succeeds. Any cb exception (including Store materialization, validateBatch or
  // low-level onBatch) is terminal through onError and leaves off.seq() at the preceding coordinate. onBatch runs
  // after Store application, so its own exception does not roll the already-applied state back.
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
Peer.createPeerPacketOffers<T>(initial?) -> {control, api}                               // dynamic reusable connection capabilities
Peer.createPeerPacketMesh<T>({meshId, nodeId, offers, instanceId?, maxHops?, seenLimit?, reconnectMs?, probeIntervalMs?, pingTimeoutMs?, accept?})
  // OFFER: {id, peerId, priority?, connect() -> {peerId, send(wire), messages, ping?, onFail?, close}}.
  // Sessions exchange path-vector route advertisements and arbitrary payload packets; lower additive
  //   priority + measured RTT wins. A disappeared/failed offer removes all paths through it and the
  //   next candidate becomes active; a restored offer is reopened and advertised automatically.
  // packet: {protocol:1, kind:'packet', meshId, packetId, originId, targetId, sequence, ttl, path, payload}.
  //   packetId dedupes per origin, path rejects loops, and TTL bounds forwarding. send().ok is next-hop
  //   acceptance, not a destination receipt. accept(packet, from) authenticates the immediate session
  //   peer only: unsigned originId/path are informational and every relay must be trusted unless the
  //   adapter/payload adds verifiable provenance. Intermediate nodes never inspect payload semantics.
  // api: send(target, payload, {packetId?, ttl?}) · broadcast(targets, payload, {ttl?}) · packets ·
  //   routes()/routeChanges · status()/statusChanges · stats() · probe() · close().
  // Group broadcast is intentionally independent per target, not lockstep. Oracle:
  //   replay/peer-packet-mesh.test.ts; interactive Lab stand: Peer packet mesh.
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
  //   New endpoints negotiate exact binary values plus bounded live batches (64 items / about 64 KiB)
  //   through ordered text hello/ready; either old side stays on historical JSON/base64 `{t:'ev'}`.
  //   Rich mixed values and Media frames stay byte-exact. Native tracks/SFU remain optional adapters.
  //   revoke/close signals and channel death (incl. DURING open) fail loudly -> coordinator auto-fallback.
acceptWebRtcDirect({port, rtc, self, serve, accept?}) -> close()
  // responder side: on offer, negotiates answer/ICE and serves serve(env) (exposeReplay(...) as is) into
  //   the incoming datachannel; accept(env) validates session material and rejects with a loud revoke
  //   (the initiator fails fast, not by timeout). Repeated offer for a pair recreates the session.
  // Public HTTPS/WSS launch and certificate verification -> DEMO-HTTPS.md.
Peer.createPatchRelayJournal({history?, gap?: 'resume'|'sacred'}) -> {push(env), pushBatch(envs), remote, gap, seq(), snapshot(), close()}
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
  //   pushBatch validates and commits the complete ordered owner batch before live delivery; throwing/re-entrant
  //   subscribers cannot interrupt or replace its suffix. createPeerClient uses the host's additive publishBatch in
  //   binary-aware bounded microtask bursts and falls back to publish(env) on an old host, re-probing each generation.
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
  // replay wire over any ordered channel: tiny JSON sub/req/res remains the compatibility baseline;
  //   additive sendBinary/onBinaryMessage enables a versioned exact-value byte path for sub, requests,
  //   responses and live microbatches. It has fresh bounded shape caches per channel and no RPC core —
  //   a direct channel lives outside the main RPC connection.
  //   Channel close = non-envelope (null) on the line: replay subscribers report onError, never silence.
  //   ReplayMessageChannel = {send, onMessage, sendBinary?, onBinaryMessage?, onClose?, close?};
  //   channelFromDataChannel(dc) selects ArrayBuffer delivery and owns its handlers. Oracles:
  //   replay/replay-channel-binary.test.ts and replay/route-webrtc.test.ts.
createReplicatedMap<V>({keyOf, initial?, store?, delivery, lineId?, replay?}) -> {api, control}  // high-level keyed collection over layer B, not a parallel journal
followReplicatedMap(remote, {delivery?, batch?=true, checkpoint?, onBatch?, onStatus?, staleMs?, ...}) -> followed map
  // PRODUCER: control = set/setMany/delete/deleteMany/replaceAll/get/has/snapshot/flush/close. All input iterables
  //   are validated before mutation; setMany is one producer/source operation. The root is a plain keyed object with
  //   enumerable string data properties; Replicated Map alone rejects __proto__, constructor and prototype for its
  //   RPC-safe root shape. Dotted keys stay one literal top-level key.
  // DELIVERY: latest removes equal writes and keeps only the final occurrence of a key within one operation;
  //   keyframe/frame reset is allowed. lossless preserves every accepted set (including same-key/equal repeats) in
  //   operations order, uses exact tail catch-up, and fails on eviction, non-contiguous seq or producer-line change.
  //   Deleting an absent key is a no-op in both modes: lossless is a mutation log, not a command-attempt audit log.
  //   latest.replaceAll(fullSnapshot) scans every candidate key but retains unchanged Store references and clones,
  //   mutates and publishes only semantic changes. New object identity is irrelevant. When the producer already has
  //   a dirty-key list, setMany(changes) avoids the full-snapshot scan.
  // CLIENT: get/has/snapshot/onKey/ready/status/statusChanges/batches/keys/seq()/replayMode()/delivery()/checkpoint()/isStale()/close().
  //   onBatch receives {delivery,set:[[key,value]],delete:[key],operations:[...]} after one bounded physical envelope
  //   is materialized. Bounds may split one setMany; maxDelayMs may merge adjacent source operations. Consumer errors
  //   on the high-level batches/keys/status streams are isolated from replay and reported as asynchronous throws.
  //   Values returned to callbacks/get/snapshot are detached from both producer state and the retained replay journal.
  // CHECKPOINT: one object binds snapshot + {lineId,delivery,replayMode,seq}. A naked cursor is deliberately not
  //   accepted. Same-line resumes use the tail; another latest line resets by keyframe; lossless rejects it loudly.
  //   Default lineId changes with every fresh journal. Supply lineId only when the exact seq-space is durably restored.
  // RECONNECT: descriptor/lineId is re-read before catch-up. Legacy Store Replay remotes are accepted only as latest
  //   and reset safely on reconnect because they have no identity. Lossless requires a Replicated Map descriptor.
  // DI: initial and store are mutually exclusive; an injected Store is latest-only and keeps listenStorePatches as
  //   its source. Its root and every initial/touched top-level entry must satisfy the public map shape and
  //   propertyKey == keyOf(value); an invalid external
  //   write throws before publication. Writes through the injected Store proxy, including nested writes, are normalized
  //   as top-level facts and journaled. Owned latest/lossless maps publish explicit operation batches internally.
  // ADVANCED DEBUG: debug.store is the writable local mirror. Observe it only; writing bypasses remote ownership.
  // ADVANCED FAILURE: flush() retries a retained journal precommit; repeating an equal latest set and close() also
  //   flush it. ready settles on terminal failure as the low-level replay ready does; inspect status().state/error.
  // Oracles: replay/replicated-map.test.ts, replay/replicated-map-socket.test.ts, replay/store-patch-safety.test.ts;
  // living stand: demo Workboard (map latest / replay batch / seq) including real-socket reconnect.
exposeStoreReplay(store, {batch?, patchSource?, ...})  <->  syncStoreReplay(mirror, remote, {batch?, validateBatch?, onBatch?, ...}) // layer B: patch line; keyframe = root patch
  // StoreReplayPatchSource = {on(cb: (patches: readonly StorePatch[]) => void) -> off}.
  // OPT-IN BATCH: exposeStoreReplay(store, {batch:true}) adds api.replay.batch beside the unchanged legacy surface;
  //   syncStoreReplay(mirror, api.replay, {batch:true}) negotiates it by presence and falls back to legacy when absent.
  //   An old client connected to a new server calls only the unchanged replay.line and therefore remains legacy.
  //   validateBatch(patches, mirror) runs after decode and before ANY Store mutation. Throwing is terminal, reports
  //   onError and leaves seq unchanged. onBatch runs after one physical envelope is applied; its throw is also terminal
  //   and leaves seq unchanged, but does not roll the already-applied Store state back.
  //   patchSource is an advanced absolute-fact feed: Store state must already reflect its complete emitted patch array.
  //   Application code still sees StorePatch objects. Wire v1 is
  //   [1,seq,ts,[[path,1,value]|[path,0]|[path,2],...]]; op 2 preserves an explicitly present undefined value.
  //   New servers expose v1-v7 over the SAME logical line/seq. v2 uses flat [key,value]/[key] set/delete tuples
  //   and [path,value]/[path] for nested/root patches; v3 adds recursive exact-value escapes.
  //   v4 groups ordered raw/delete/root runs and consecutive Object.prototype values with the same ordered enumerable
  //   data-field list into columns only when that structure is smaller. It may derive one field from the Store key.
  //   The shape is shallow and envelope-local:
  //   there is no persistent shape cache, cross-envelope dictionary, deep shape comparison or recursive columnization.
  //   v5 writes that same patch plan to one self-contained Uint8Array. Application code still receives ordinary
  //   StorePatch/value objects. V6 carries those ordinary logical objects directly through the universal outer
  //   RPC value path, removing the v5-inner-Uint8Array-inside-RPC-binary copy. V7 reuses the exact v2
  //   [2,seq,ts,patches] value without adding Store opcodes, a Store schema catalog or an inner byte wrapper.
  //   Universal RPB/3 applies msgpackr once to the complete RPC packet, so Store, calls, responses, errors and
  //   callbacks share the same serializer. RPB/2, RPB/1 and legacy remain transport fallbacks. New clients select
  //   v2 first; when v2 is absent they can still read v7/v6/v5/v4/v3/v1 and finally legacy;
  //   old clients and servers continue on their newest common member, with no change to the business API.
  //   v5 preserves null/undefined/booleans, finite and special Numbers (including -0/NaN/infinities),
  //   strings (including lone surrogates), BigInt up to 8,192 bits,
  //   dense/sparse arrays, plain and null-prototype objects, valid/invalid Date, RegExp, Map, Set, ArrayBuffer,
  //   DataView and standard typed arrays in fixed little-endian wire order; Buffer decodes as Uint8Array.
  //   Cycles, class instances, accessors,
  //   functions, symbols and custom array properties are rejected instead of being silently changed.
  //   Defensive v5 limits are depth 32 for the complete binary tree, 10,000 ordinary plan rows,
  //   a separate envelope-wide 20,000-entry materialized-root budget, 10,000 items per Array/Map/Set,
  //   and 1,000 keys per nested ordinary/null-prototype object,
  //   1,000,000 UTF-8 bytes and UTF-16 code units per string, 8,000,000 bytes per binary value and 16,000,000 bytes
  //   per complete frame. Plain and null-prototype root collections retain their prototype and are split into physical
  //   shape/raw/delete arrays of at most 10,000 rows; widening root snapshots does not widen ordinary arrays or patches.
  //   Explicit client RpcLimits clamp these hard ceilings inside the byte envelope. v4 allows value depth 64 with
  //   the same row/key budgets. The negotiated v5 Store reader trusts value semantics emitted by the paired encoder:
  //   it reads tags/lengths directly and does not rebuild validation sets or re-check canonical UTF/collection forms.
  //   Frame magic/version, byte boundaries, explicit size limits and the Store plan remain checked before mutation;
  //   negotiated RPB/3 and RPB/2 likewise use trusted readers without Zod or semantic value validation.
  //   A natural Store drain enters as one source array. maxItems/maxBytes may split it into several physical envelopes;
  //   maxDelayMs>0 may merge adjacent source arrays. onBatch is once per resulting envelope, not per original drain.
  //   Batch frame flattens retained envelopes, keeps the last state-changing patch per exact path, and preserves
  //   delete -> recreate ordering.
  //   {batch:{maxItems:256,maxBytes:65536,maxDelayMs:0}} defaults: maxItems is hard. Before publication maxBytes is
  //   conservatively screened and, near the boundary, checked on the complete envelope against the largest packed
  //   v1-v5 Store representations, including rich-value markers, full UTF-8 and binary attachments. V6 has no
  //   Store-specific packed representation: the selected outer RPC mode measures its ordinary event. One indivisible
  //   patch may exceed the configured target but must still fit the v5 hard frame. A combined hard-frame overflow
  //   is recursively split; invalid values fail before either legacy or batch journal/head/fan-out. maxDelayMs:0
  //   preserves the natural drain with no extra latency. Set maxDelayMs>0 only to combine adjacent drain windows.
  //   replayBatch/batchStats/flushPending stay local for inspection. Journal precommit is before head/fan-out;
  //   failed compact chunks and a non-transactional adapter's uncommitted suffix remain retryable without duplicates.
  //   Oracles: replay/store-replay-batch.test.ts, replay/store-replay-columnar-binary.test.ts,
  //   replay/store-replay-batch-socket.test.ts and replay/store-replay-large-stress.test.ts. The stress oracle
  //   materializes 15,000 records and drives seeded 250-key updates through v1-v7, 0/1/5ms batching, reconnect,
  //   compact-frame/keyframe recovery and both old-peer directions. The focused release diagnostic compares only
  //   legacy JSON, recommended v2 JSON and experimental v7 binary at 1/10/50/250 updates and a 15,000-key keyframe:
  //   `npm run bench:store-replay:v7`.
syncStoreReplayRoute(mirror, remote, {batch?, validateBatch?, onBatch?, ...}) -> off & {ready, switch(nextRemote, opts), seq(), label(), active(), mode}
  // Same validation/callback/seq contract as syncStoreReplay, but route-replaceable for relay/direct promotion.
createStoreReplicaOffers(initial?) -> {control, api}                                    // dynamic registry; api = {list, changes}; subscribe-before-list is handled by createStoreReplicaSet
createStoreReplicaSet<T>(deps) -> {control, api, close}                                 // layer B.2: self-assembling single-authority Store over arbitrary connection offers
  // OFFER, not connection: {id, priority?, connect() -> {remote, onFail?, close}}. The controller owns
  //   session lifetime/retry. remote = {descriptor(), changed?, replay, ping?}; therefore an RPC fragment,
  //   WebRTC datachannel, worker or in-process edge differs only in the offer adapter.
  // DESCRIPTOR: {protocol:1, storeId, originId, nodeId, lineId, leaderId, epoch, role,
  //   authorityLineId, authoritySeq, authorityCost, path, headSeq, proof?}.
  //   storeId = logical data set; originId = stable lineage; nodeId = physical participant;
  //   lineId = this process replay space (change on cold restart); authorityLineId = winning writer line.
  //   path is authority -> ... -> this node (unique ids only); authorityCost is measured cumulative ms.
  // ROUTE CHOICE: choose the best accepted authority, restrict to its freshest authoritySeq, then minimize
  //   remote authorityCost + measured local RTT + offer priority. The active route stays until a replacement
  //   wins by hysteresisMs. A path containing the local node is rejected; so a cheap descendant never loops.
  //   Same remote replay space hands off by seq; a different cascade/authority line resets through a keyframe.
  //   route.batch defaults false because independently re-exposed replicas do not share batch coordinates;
  //   opt in only when every offered route is another transport to the exact same batch line identity.
  // AUTHORITY: default fork choice is epoch -> leaderId -> authorityLineId (deterministic availability mode).
  //   Automatic promotion is OFF unless autoPromoteMs is supplied. Without an injected elect/accept policy,
  //   disconnected eligible components MAY both write; the higher fork wins when the network heals.
  //   For quorum/lease safety inject elect(ctx), accept(descriptor), compare(a,b); proof is opaque to the core.
  // CONFLICTS: before a writable losing leader adopts the winner keyframe, `api.conflicts` emits its complete
  //   local/authority snapshots plus diffKeyedState. The core never silently union-merges divergent branches.
  // COMMAND RULE: Store itself remains the state primitive and is technically mutable. Application command
  //   ports MUST admit writes only when canWrite() is true; client/cache nodes use eligible:false.
  // api.fragment is the transport-facing descriptor/changed/replay/ping namespace; api.ready resolves on the
  //   first usable leader/follower state; api.status/routes/conflicts are the operational observability surface.
  // Oracle: observe/store-replica-set.test.ts; real two-socket cascade:
  //   oracle/realsocket/store-replica-set.spec.ts; browser scenario: npm run demo -> Lab.
syncStoreReplayEach<T>(remote, cb, opts?) -> off & {store, ready, mode, seq(), isStale(), lastTs()}   // one-call per-key fold over the patch line (mirror + syncStoreReplay + store.each()); most-used surface — full contract + example in wenay-common2.md
createOfflineStore({key, remote?, initial, storage, version?, debounceMs?, syncOpts?}) -> Promise<OfflineStore<T>>
  // snapshot-mode persisted mirror: read local {version,seq,replayMode,snapshot,savedAt}, create a normal Store immediately,
  // then syncStoreReplay(..., {since: savedSeq}) when remote exists. reconnect(remote) attaches later after offline start.
  // V1-v7 share one `batch` mode; switching between legacy and batch resets seq and takes a safe keyframe.
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
ReplayStorage = {putEvent, putEvents?, putKeyframe, getKeyframe({seq?|ts?}?), getEvents(from, to)}   // layer C: putEvents is atomic all-or-throw; createMemoryReplayStorage(caps?) = reference impl
archiveReplay(replay, {storage, everyEvents? = 64, everyMs?}) -> {close, stats}          // event log + keyframe cadence (every N events OR T ms of line-ts, whichever first; frames only ON events)
openHistory(storage, live?) -> {at({seq?|ts?}?), subscribe(cb, {since?|ts?, onSeq?}) -> off}   // seek + playback, SAME subscriber interface; with live: archive -> live journal -> live handover
  // seamless rewind->live: create the line with getSince reading the same storage («memory outside»); else the gap closes with a keyframe jump (still consistent)
storeReplayAt(storage, {seq?|ts?}?) -> snapshot | undefined                              // store time machine: bit-exact state at any archived moment (same applyStorePatch mechanism)
```

### Store Replay wire generations

Every batch member represents the same logical Store patch line and sequence space. Versions are
additive optional RPC members, not different public Store APIs. The measured default is v2.
A dedicated high-frequency RPC connection whose batching window consistently produces roughly 50
or more changes per physical frame may deliberately expose v7 instead. JSON versus RPB/3 is
negotiated once per RPC connection; it is not selected again from each Store batch size. When v2
is absent, the reader can still consume the compatibility members and finally v1/legacy.

| Store route | Physical form | Main purpose | Mixed-peer behavior |
|---|---|---|---|
| Legacy `replay.line` | One ordinary `StorePatch` replay event at a time | Original compatibility surface; no batch member required | Old client + new server remains here; new client + old server falls back here |
| v1 | Compact op tuples inside a bounded batch envelope | First physical batching generation; preserves explicit `undefined` with its opcode | Selected only when no newer optional member exists |
| v2 | Flatter top-level and nested/root set/delete tuples over JSON arrays | Lowest measured CPU on the common ordinary-value path | Preferred whenever available; nested explicit `undefined` and exact RPC/Socket marker-shaped business objects need v3 semantics |
| v3 | v2 layout plus recursive exact-value escapes | Preserves marker-shaped business data and explicit `undefined` recursively without changing ordinary v2 values | Falls back to v2/v1 when absent |
| v4 | Envelope-local shallow column plan with raw/delete/root runs and optional derived Store key | Compresses consecutive same-shaped records without a persistent cross-envelope Store cache | Falls back to v3-v1; transport may still use native binary attachments |
| v5 | Self-contained Store-specific `Uint8Array` over the v4 plan | Exact rich/binary values in one canonical Store byte codec with Store-specific hard limits | Falls back to v4-v1; still remains the newest common route for clients which do not know v6 |
| v6 | Ordinary `ReplayEvent<[StorePatch[]]>`; no inner Store encoding | Historical universal-RPB experiment retained for diagnostics | Read only when v2 is absent |
| v7 | The unchanged v2 `[2,seq,ts,patches]` value inside opt-in universal RPB/3 msgpackr | Explicit high-frequency/large-batch connection; no second Store transform, opcodes, catalog or inner bytes | Select deliberately on a dedicated binary connection whose physical frames are normally around 50+ changes; does not displace v2 merely by existing |

No Store version leaks compact tuples, opcodes or bytes into application code. `onBatch`, mirrors and
Replicated Map receive ordinary keys, values and `StorePatch` objects. The selector is capability
presence, not a runtime guess from payload bytes.

V3-v6 are planned for removal in the next intentional breaking release. They were not redesigned
for 1.0.94 because their measured speed improvement was not satisfactory relative to the code and
compatibility surface they add. Removal is gated by one deprecation release and verification that
supported consumers negotiate only v2 or v7; legacy `replay.line` remains the old-client fallback.

> Killer property for state/frame lines: a lagging/late/stalled consumer can replace backlog with a state-equivalent frame/keyframe. A sacred queue deliberately does not: its retained tail is exact, and eviction is a terminal error rather than silent loss.
> Files: `src/Common/events/replay-{listen,wire,conflate,history,index}.ts` +
> `src/Common/Observe/{replicated-map,store-replay,store-replay-codec,store-replay-columnar,store-replay-binary,store-offline}.ts`;
> legacy replay/push members remain available; compact members and negotiation options are additive.
> Oracles: `npx ts-node replay/<f>.ts` — replay-listen / store-replay / offline-store / socket-replay / offline-store-socket / conflate / conflate-socket / coalesce / history / staleness / canvas-socket (raw bytes) / video-socket.demo;
> wire coverage also lives in the RPC harness cookbook (`npm run test:rpc`).

The targeted heavy gate is `npm run test:stress`. It runs the 15,000-record Store matrix,
multi-megabyte CALL/RESP/PIPE and callback/reconnect/legacy RPC matrix, and synthetic multi-window
video matrix. `npm run test:all` includes the same bounded stress files together with every ordinary
oracle.

`npm run test:stress:extended` first runs that gate and then a separate deterministic soak profile.
It scales verified work rather than sleeping for a minimum duration:

- Store: one 15,000-record source/mirror pair receives 419,838 writes through 6,780 drains; v1-v6,
  legacy, batches from 1 to 2,000 patches, hot-key conflation, rich/1,250-layout values, 0/1/5/20 ms
  windows and twelve queue/frame/keyframe reconnects must finish at an exact snapshot and seq.
- RPC: 122,804 logical operations include 24,000 bounded-concurrent tiny calls, 49,152 warm-layout
  records, 48,000 ordered heterogeneous callbacks, 1,300 layout saturation and 544.86 MiB of binary
  round-trip blocks from 1 byte through 4 MiB. Counts, checksum, wire kind and cleanup are asserted.
- Media: 3,138 source frames mix 4 KiB, 64 KiB, 256 KiB and 1 MiB payloads, repeated/changing bodies,
  JPEG/WebP/PNG metadata and reconnect generations. Three-viewer fan-out verifies 9,416 raw
  deliveries (1,114.7 MiB), SHA-256/order/latest semantics and complete bitmap/listener/socket cleanup.

Extended files are intentionally excluded from normal `test:all` and `test:stress`. Their printed
times and RSS are diagnostics, not machine-dependent pass thresholds; the operation, byte, boundary
and checksum floors are the pass criteria.

### Current focused legacy / v2 JSON / v7 binary benchmark

Run `npm run bench:store-replay:v7`. It compares the complete callback value pipeline and verifies
every decoded patch against the source. Update rows use one legacy message per patch and one message
for v2/v7; the keyframe is one message for every route. CPU is the median of seven windows after two
warm-up windows. Exact timings remain host diagnostics.

Fresh results on the same host, with encode and decode reported separately:

Node v24.18:

| Workload | Route | Messages | Bytes | Encode, us | Decode, us | Total, us |
|---|---|---:|---:|---:|---:|---:|
| 1 update | legacy JSON | 1 | 127 | 0.41 | 0.60 | 1.01 |
| 1 update | **v2 JSON** | 1 | 79 | **0.27** | **0.45** | **0.72** |
| 1 update | v7 binary | 1 | **64** | 0.70 | 0.52 | 1.22 |
| 10 updates | legacy JSON | 10 | 1,276 | 3.46 | 6.02 | 9.48 |
| 10 updates | **v2 JSON** | 1 | 643 | **1.45** | 2.67 | **4.12** |
| 10 updates | v7 binary | 1 | **325** | 2.07 | **2.14** | 4.21 |
| 50 updates | legacy JSON | 50 | 6,456 | 17.25 | 29.76 | 47.01 |
| 50 updates | v2 JSON | 1 | 3,183 | 7.18 | 12.69 | 19.87 |
| 50 updates | v7 binary | 1 | **1,487** | **6.43** | **4.82** | **11.25** |
| 250 updates | legacy JSON | 250 | 32,657 | 86.74 | 151.41 | 238.15 |
| 250 updates | v2 JSON | 1 | 16,034 | 34.55 | 63.13 | 97.68 |
| 250 updates | v7 binary | 1 | **7,288** | **27.91** | **17.24** | **45.15** |
| 15k keyframe | legacy JSON | 1 | 513,960 | 3,135.06 | 4,738.97 | 7,874.03 |
| 15k keyframe | **v2 JSON** | 1 | 513,914 | **3,128.91** | 4,213.64 | **7,342.56** |
| 15k keyframe | v7 binary | 1 | **330,030** | 5,412.45 | **2,834.69** | 8,247.15 |

Bun 1.3.14:

| Workload | Route | Messages | Bytes | Encode, us | Decode, us | Total, us |
|---|---|---:|---:|---:|---:|---:|
| 1 update | legacy JSON | 1 | 127 | 0.21 | 0.45 | 0.66 |
| 1 update | **v2 JSON** | 1 | 79 | **0.19** | **0.40** | **0.59** |
| 1 update | v7 binary | 1 | **64** | 0.64 | 0.80 | 1.43 |
| 10 updates | legacy JSON | 10 | 1,276 | 2.06 | 4.64 | 6.70 |
| 10 updates | **v2 JSON** | 1 | 643 | **1.16** | **2.15** | **3.31** |
| 10 updates | v7 binary | 1 | **325** | 1.64 | 2.52 | 4.15 |
| 50 updates | legacy JSON | 50 | 6,456 | 10.39 | 25.27 | 35.67 |
| 50 updates | v2 JSON | 1 | 3,183 | **5.14** | 12.10 | 17.23 |
| 50 updates | v7 binary | 1 | **1,487** | 5.52 | **6.23** | **11.75** |
| 250 updates | legacy JSON | 250 | 32,657 | 52.72 | 128.32 | 181.05 |
| 250 updates | v2 JSON | 1 | 16,034 | 38.04 | 66.78 | 104.81 |
| 250 updates | v7 binary | 1 | **7,288** | **27.52** | **24.54** | **52.06** |
| 15k keyframe | legacy JSON | 1 | 513,960 | **889.76** | 2,841.58 | 3,731.34 |
| 15k keyframe | **v2 JSON** | 1 | 513,914 | 909.70 | **2,734.35** | **3,644.05** |
| 15k keyframe | v7 binary | 1 | **330,030** | 1,214.13 | 2,781.76 | 3,995.90 |

V2 JSON is therefore the default. It wins the dominant one-event and ten-event paths on both
runtimes and also wins the complete 15k keyframe CPU result. V7 is the deliberate high-frequency
mode for a dedicated connection where batching consistently produces roughly 50 or more changes per
physical frame: at the measured 50/250 updates it both reduces bytes and wins total codec CPU. It
is not selected automatically or per batch. Enable binary RPC and expose v7 explicitly only on
that measured connection.

### Historical Store Replay v1-v6 benchmark inside RPB/2

`npm run bench:store-replay` now compares every Store generation through the same exact callback
packet, `[Pkt.CB, id, [event]]`, inside a negotiated warm RPB/2 connection. `warm B` is the complete
RPB payload before Socket.IO/Engine.IO/WebSocket framing, after 20 schema-learning warm-up rounds.
`full encode` includes the Store generation's transform and outer RPB/2 serialization; `full decode`
includes outer RPB/2 parsing, callback-value extraction and the Store generation's inverse transform.
The schema prelude, connection setup, Socket.IO I/O, Store application and network latency are
reported elsewhere by the benchmark and are deliberately not mixed into these codec CPU columns.
The CPU columns are `performance.now()` elapsed microseconds per synchronous batch, not hardware
cycle counters; this table does not measure heap allocation or RSS.

The workload is one logical batch of deterministic quote-shaped patches:
`{path: ['S' + i], exists: true, value: {c: i + 0.5, t: 1_000_000 + i}}`. Full CPU values are the
median of seven measured windows after two warm-up windows. Each 50-patch window runs 4,000 complete
batches; each 700-patch window runs 400. Every measured route is decoded and checked against the
original patches. These are representative runs on the same AMD Ryzen AI 7 350 host; they are
diagnostics, not a performance contract.

Node v24.18:

| Store | 50 warm B | 50 full encode, us | 50 full decode, us | 700 warm B | 700 full encode, us | 700 full decode, us | 700 vs v1: B / encode / decode |
|---|---:|---:|---:|---:|---:|---:|---:|
| v1 | 871 | 34.81 | 8.94 | 12,522 | 363.84 | 108.89 | baseline |
| v2 | 821 | 30.86 | 7.80 | 11,822 | 301.91 | 97.15 | -5.6% / -17.0% / -10.8% |
| v3 | 821 | 31.35 | 7.94 | 11,822 | 333.60 | 96.51 | -5.6% / -8.3% / -11.4% |
| v4 | 1,079 | 64.35 | 10.14 | 13,976 | 646.21 | 140.87 | +11.6% / +77.6% / +29.4% |
| v5 | 942 | 56.46 | 10.76 | 13,245 | 485.40 | 119.98 | +5.8% / +33.4% / +10.2% |
| v6 | 827 | 34.58 | 9.17 | 11,909 | 351.39 | 112.18 | -4.9% / -3.4% / +3.0% |

Bun 1.3.14, 700 patches on the same host:

| Store | warm B | full encode, us | full decode, us | vs v1: B / encode / decode |
|---|---:|---:|---:|---:|
| v1 | 12,522 | 319.38 | 167.25 | baseline |
| v2 | 11,822 | 228.15 | 136.48 | -5.6% / -28.6% / -18.4% |
| v3 | 11,822 | 259.21 | 136.88 | -5.6% / -18.8% / -18.2% |
| v4 | 13,976 | 610.32 | 176.07 | +11.6% / +91.1% / +5.3% |
| v5 | 13,245 | 611.92 | 140.50 | +5.8% / +91.6% / -16.0% |
| v6 | 11,909 | 199.96 | 166.86 | -4.9% / -37.4% / -0.2% |

For this flat workload, v2 and v3 are tied for the smallest warm payload, and v2 is the fastest
700-patch decoder in both recorded runtime runs because its Store-specific tuples fit the data
exactly. V6 is within 87 bytes of v2 at 700 patches, but uses the universal outer schema path and
removes v5's inner byte envelope. Against v5 in the Node run, v6 used 10.1% fewer bytes, 27.6% less
full encode CPU and 6.5% less full decode CPU.

Warm bytes are deterministic for this input and build. CPU values are not: runtime JIT state,
garbage collection, allocator state, power policy and other host load move individual rows. The Bun
run, for example, made v6 encoding especially fast while its v6 decode stayed roughly tied with v1;
that runtime-specific ordering should still be reproduced on the deployment host. Large differences
and repeated direction across runs are useful; sub-10% differences remain provisional.

### Sparse 500-key full-snapshot profile

Set `STORE_REPLAY_BENCH_PROFILE=sparse` to run the focused profile without the Socket.IO matrix:

```powershell
$env:STORE_REPLAY_BENCH_PROFILE='sparse'
npm run bench:store-replay
```

Each `replaceAll` input contains 500 freshly allocated quote objects. Three deterministic waves
change the first 20, a seeded-random 40 and a seeded-random 50 keys. The real
`ReplicatedMap.replaceAll(latest)` path compares the full input and emits one v6 event per wave.
Every event is then transformed independently through Store v1-v6 and a warm RPB/2 callback packet.
Exact materialized state and the changed key set are checked after every canonical wave.

Representative producer results on the same AMD Ryzen AI 7 350 host:

| Wave | Fresh input values | Emitted patches | Unchanged values not sent | Node v24.18 replaceAll, us | Bun 1.3.14 replaceAll, us |
|---|---:|---:|---:|---:|---:|
| first 20 | 500 | 20 | 480 | 354.00 | 326.50 |
| random 40 | 500 | 40 | 460 | 471.40 | 421.10 |
| random 50 | 500 | 50 | 450 | 530.10 | 461.00 |
| total | 1,500 | 110 | 1,390 | — | — |

Object construction happens before the timer because the facade receives an already built source
snapshot. `replaceAll` CPU includes semantic comparison of 500 keys, cloning only changed values,
Store mutation and synchronous replay publication. It does not include wire serialization.

Warm RPB/2 totals for the same three packets and 110 changed wire values:

| Store | Total B | Node encode, us | Node decode, us | Bun encode, us | Bun decode, us |
|---|---:|---:|---:|---:|---:|
| v1 | 3,702 | 180.81 | 53.09 | 143.85 | 58.80 |
| v2 | 3,592 | 167.88 | 43.67 | 107.43 | 50.28 |
| v3 | 3,592 | 177.32 | 50.41 | 108.47 | 45.50 |
| v4 | 4,275 | 297.80 | 56.70 | 313.18 | 70.49 |
| v5 | 3,547 | 237.10 | 53.44 | 251.72 | 64.63 |
| v6 | 3,604 | 173.38 | 44.76 | 105.54 | 53.74 |

These encode/decode columns are per complete three-packet sequence; producer comparison and input
allocation are outside them. All six generations decode exactly. V6 versus v5 removes 26.9% of
Node encode CPU and 16.2% of Node decode CPU in this run, but v5 remains 57 bytes smaller. The
specialized v2/v3 forms are 12 bytes smaller than v6. As in the bulk table, CPU is diagnostic and
moves between runs; bytes are deterministic.

The 500 object identities do not allocate 500 RPB schemas. Schema admission follows ordered
layout/types, so this fixture reuses one recurring value layout while each actual key remains data.
The remaining wire repetition is the literal `path[0]` string in every changed patch. A future
negotiated RPB/3 can replace recurring key/path strings with a bounded 1,000-entry short-id
dictionary; on these short `S0..S499` keys, a warm estimate is roughly 300–450 fewer bytes across
110 patches plus less UTF-8 encode/decode work. It cannot silently change RPB/2 because old decoders
must keep reading its exact grammar. The other irreducible cost is comparing all 500 values when the
source supplies only full snapshots; a source revision/hash or `setMany` dirty list is required to
remove that scan safely.

### Historical Store Replay v4/v5 benchmark boundary

`npm run bench:store-replay` uses deterministic quote-shaped objects and exercises delivery,
frame recovery and reconnect over real Socket.IO. It measures every compatibility generation both
without universal RPC binary and, where applicable, inside the outer RPB envelope. The transport
counter observes the packed payload immediately before `socket.emit`; `engine packets` below are the
header emit plus its native binary attachments. Event names and Socket.IO, Engine.IO and WebSocket
framing are excluded. The fixed numbers below predate Store v6 and RPB/2; they are retained only as
the historical v4/v5 baseline, not as current v6 results.

Representative 700-record result:

| route | bytes | Socket.IO emits | engine packets |
|---|---:|---:|---:|
| plain legacy-compatible per-patch | 78,072 | 700 | 700 |
| compact per-patch | 64,876 | 701 | 701 |
| callback batch | 65,643 | 11 | 11 |
| Store v1, raw transport | 25,776 | 1 | 1 |
| Store v4, raw transport | 14,651 | 1 | 1 |
| Store v5, raw transport | 13,427 | 3 | 6 |
| Store v4 inside RPB | 13,379 | 1 | 2 |
| Store v5 inside RPB | 13,397 | 1 | 2 |

The first gain is physical batching: callback batching changes 700 sends into 11 without changing
the application values. Store generations then remove repeated patch structure and reduce that to
one logical batch; v5 needs three raw chunks only because its self-contained frames obey the 256-item
limit. The outer RPB envelope aggregates those chunks into one emit plus one binary attachment.
Inside RPB, v4 and v5 differ by only 18 bytes on this workload, so neither should be chosen from this
single flat table alone. V4 can use less codec CPU for flat columns, while v5 is materially faster on
some nested and rich-value shapes because it avoids JSON/native-placeholder work. The benchmark
therefore checks flat, polymorphic, nested, rich and binary values and treats CPU as a relative local
diagnostic, not a performance contract. Store v6 subsequently removed that inner Store encode/copy
by handing ordinary logical patches to the outer RPC value codec. Negotiation deliberately follows
capability version, not a runtime compression guess.

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
