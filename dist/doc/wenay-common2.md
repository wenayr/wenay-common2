# wenay-common2 — BRIEF cheat sheet (notation)

> Root import: `import { ... } from "wenay-common2"`.
> Node runtime: `>=20`.
> Notation: `name(args: types) -> ret  // note`. Types are shown where they decide a correct call (callback shape,
> overloads, return). Short names are **canonical**; removed old names are listed in `NAMING_RENAMES.md`.
> Full surface → **`wenay-common2-rare.md`**. Code style → `CLAUDE.md`. Full RPC guide → `rpc.md`.
> RPC authorization → **[`RPC-AUTH.md`](RPC-AUTH.md)** (canonical; read before writing auth code).
> Installed-project Caddy HTTPS management → **[`HTTPS-CLI.md`](HTTPS-CLI.md)**. Public raw-IP/hostname
> demo, certificate issuance, router ports, and diagnostics → **[`DEMO-HTTPS.md`](DEMO-HTTPS.md)**.

## 🔐 HTTPS manager (server-only)

```ts
import {createNodeHttpsManager} from 'wenay-common2/https'

const httpsManager = createNodeHttpsManager({projectRoot: process.cwd(), onLog: console.log})
await httpsManager.ensure()     // install/find Caddy, validate config, start/reuse, wait for trusted cert
await httpsManager.status()     // owned process + served-certificate metadata
await httpsManager.doctor()     // config/Caddy/backend/identity/runtime checks
await httpsManager.stop()       // preserve Caddy + ACME account + keys + certificates
```

Installed CLI: `npm exec wenay-https -- ensure|status|doctor|stop`. The consuming project supplies
`wenay-https.json`; Caddy owns automatic renewal. Call `ensure` only from trusted server startup or
an authenticated administrative route. Full setup and security boundary → [`HTTPS-CLI.md`](HTTPS-CLI.md).

## ⭐ events — `listen` / `listenStore`
> `import {listen, listenStore, mapListen} from 'wenay-common2'` or the narrow
> `import {listen, listenStore, mapListen} from 'wenay-common2/listen'`.

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

## Console caller links (Node, opt-in)
```ts
import {installConsoleCallerAnnotations, enable, disable} from 'wenay-common2/debug-console'

installConsoleCallerAnnotations()    // idempotently wrap console methods and enable clickable caller links
disable()                            // keep wrappers installed, but pass calls through without annotations
enable()                             // enable again; also installs on first use
enable(false)                        // same transparent mode as disable()
```
Importing the root package or `debug-console` does not modify the global console. A first install in
a browser or while the Node inspector is already attached is a safe no-op. There is deliberately no
uninstall: replacing wrappers later could overwrite wrappers installed by another tool.

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
isEqual(a, b) -> boolean       // deep structural compare; historical loose top-level primitive check + cycles/Date/RegExp/Map/Set/binary views   (alias: deepEqual)
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
  // GLOBAL PATCH: importing the ROOT, './client' or './server' replaces Date.prototype
  // toString/toDateString/toTimeString process-wide with the local 'yyyy-MM-dd HH:mm:ss GMT+H'
  // form. Subpath entrypoints (./rpc ./observe ./replay ./listen ./media ./peer ./ai ...) do NOT
  // reach Time and leave Date alone. toJSON / JSON.stringify / valueOf are untouched.
  // The patched toString parses back through new Date() to SECOND precision in whole-hour zones
  // only; in fractional-offset zones (UTC+5:30, +5:45) it yields Invalid Date. Never persist a
  // date via toString — use toJSON or valueOf.
```

## 🌐 rpc (brief) — transport is ALWAYS caller-supplied (`{emit,on}`); there is NO url / built-in socket
> Existing root imports remain supported; `wenay-common2/rpc` is the focused RPC entrypoint.

```
// SERVER: `object` is the impl tree, `socket` is a {emit,on} transport adapter
createRpcServerAuto({ socket: {emit, on}, object, socketKey: string, auth?, limits?, maxPerListen?, throttle?, opt?, replay?, replayOpts? }) -> { api, control }
  // Application traffic uses the JSON-array RPC wire. Date/Map/Set/RegExp/BigInt use the existing
  // marker projection; ArrayBuffer/DataView/TypedArray leaves remain native transport attachments.
  // RESERVED KEYS: a plain object whose SINGLE key is $_d/$_m/$_s/$_r/$_b/$_f/$_t is the codec's
  //   value, not yours — add a second key to any object of yours that would look like one. Full
  //   contract (payload per key, direction, detection via debug) in doc/wenay-common2-rare.md
  //   under "RPC application wire"; RESERVED_MARKER_KEYS / reservedMarkerKeyOf are exported.
  // opt controls only JSON-wire compact subscription shapes, callback batching, the server->client
  //   authorization-state push (opt.authState, default on; false = Pkt.AUTH never negotiated) and the
  //   HELLO<->MAP correlation id (opt.helloId, default on) that makes each reauth() see ITS OWN answer.
  // opt.callbackBatch (default negotiated-on): losslessly wraps same-microtask callback packets into one send;
  //   {maxItems:64,maxBytes:65536}, or false for exact packet-per-callback transport. Native binary leaves
  //   bypass the JSON batch wrapper and keep their direct transport-attachment path.
  // opt.requestBatch (OPT-IN, default off): extends that envelope to CALL/PIPE and RESP as Pkt.BATCH, so a
  //   burst of concurrent calls costs ONE frame each way instead of one per call; {maxItems:64,maxBytes:65536}
  //   or true. Needs callbackBatch on (one ordered queue per session), and BOTH peers must ask — a peer that
  //   does not ask sees byte-identical unbatched traffic. Measured on experiments/rpc-perf-2026-07 `burst`:
  //   100 frames -> 2 per 50-call burst, throughput 2.27x, CPU/call -72%, bytes -12.1% c2s / -6.0% s2c.
  //   The isolated `small` family is byte-identical and unchanged in p50/p95 — a lone packet is never wrapped.
  // opt.compactRows (default negotiated-on): an array of uniform plain-object records inside a RESULT or a
  //   callback argument travels as its keys once plus rows of values ({"$_t":[shapeId,rows,keys]}), instead of
  //   repeating every key name per record; false = arrays travel as objects, wire as before. Needs compact on.
  //   Applies from 4 records up, only when every element is a plain object with the same keys in the same order,
  //   and never when a value would change meaning by moving into an array (undefined/function/symbol).
  //   Measured on experiments/rpc-perf-2026-07 `large` (1000 CBar records): 127 912 -> 70 983 B/call (-44.5%),
  //   p50 3.14 -> 2.39 ms, throughput +26%, CPU/call unchanged. `small`, `ticks`, `flood`, `burst` are byte-identical.
  // replay: false|'auto' (default)|'force' — facade members that are replay lines (replayListen) are exposed
  //   with BOTH surfaces under the SAME key: legacy plain-Listen path byte-for-byte + line/frameLine/since/keyframe/frame.
  //   Store Replay V2 (`api.replay`, including createReplicatedMap().api) and exposeReplay(...) carry the same
  //   internal replay-wire identity, so RPC auto adds frameLine to them without shape-sniffing or a public marker.
  //   Upgrading listen -> replayListen is a declaration-site-only change; the facade and clients don't move.
  // replayOpts: {pending?, highWater?, lowWater?, pollMs?} — per-connection lag gate for 'frame'-policy subscribers
  //   (pending defaults to socket.io writeBuffer). A gate attaches upstream only on its first real frameLine
  //   consumer, detaches after the last off(), and polls only while that subscribed consumer is over highWater.
  //   Gates close on disconnect automatically. Replay lines are never throttled.
createRpcServer(opts)        // lower-level core (same { socket, object, socketKey }) -> { control }
noStrict(obj)                // mark a dynamic subtree (no schema; required for proxy-backed surfaces)
endCallback(fn)              // mark an RPC stream-callback's end   (alias: rpcEndCallback)
flowCallback(cb, opts?)      // pace an RPC stream-callback (backpressure) -> { push, pending, closed }
  \ Sibling of endCallback: one ENDS a stream, this one PACES it. In a server method:
  \   const flow = flowCallback(cb, {window: 100}); ...; await flow.push(chunk)
  \ push() sends the frame exactly like cb() and resolves when producing more is OK. Two signals:
  \   credit window (Caps.CB_FLOW, on by default): client runtime acks cumulatively (coalesced,
  \     one per ackEvery frames) after each frame's consumer call settles — an async consumer
  \     paces the server by its real speed; flow frames are delivered sequentially;
  \   local watermark fallback (old peers): {pending, highWater, lowWater, pollMs} — the replay
  \     lag-gate vocabulary; default pending probes the socket.io write buffer when available.
  \ Disconnect / endCallback / method settle reject pending pushes (MyError 'E_FLOW_CLOSED').
  \ A local (non-wire) callback passes through: producer code is identical in-process and over RPC.
  \ opt.flowCallback: false disables negotiation. Unwrapped callbacks are byte-identical on the wire.

// AUTH (in-band): client presents a token in Pkt.HELLO -> server serves that principal's facade.
// CANONICAL PAGE: doc/RPC-AUTH.md — read it before writing auth code (rules + ✅/❌ pairs + limits).
auth: { resolveAuth(token) -> { object?, ack?, expiresAt?, renewBeforeMs? } | Promise<...>, gate?: boolean }
  // gate:true rejects CALL/PIPE before a successful HELLO (MyError code 'E_UNAUTHORIZED'). It does NOT gate
  //   Pkt.STRICT: the constructor `object` schema is served to any peer — keep it EMPTY, put the protected
  //   surface in the facade resolveAuth returns. That same object is also the expiry/revocation fallback.
  // expiresAt (absolute ms; Infinity = none) arms 'expiring' at expiresAt-renewBeforeMs (default 30_000)
  //   and 'expired' at the deadline; any other non-finite value fails CLOSED (immediate downgrade).
  // throw = TRANSIENT rejection, live session untouched; throw a value carrying `revoke: true` = hard
  //   downgrade (Pkt.AUTH 'revoked' + base facade + authAck {ok:false,state,reason}).
  // A privilege DECREASE ends the streams of Listen nodes the new facade no longer declares (clean
  //   RPC_STOP/CB_END). Listen nodes inside noStrict(...) are never walked, so they are never torn down.
  // A grant's deadline rides authAck in ONE reserved sub-object: ack.$rpc = {expiresAt} (exported key
  //   GRANT_FACTS_KEY = '$rpc'). Attached on a COPY, so the application's ack is never clobbered; skipped
  //   for a non-object ack, an ack that already owns '$rpc', or a non-finite deadline -> read it defensively.
control: (returned by createRpcServer/createRpcServerAuto) — the application's grip on THIS connection
  control.revoke(reason?) -> boolean    // cut NOW: the SAME corridor an expiring token takes (Pkt.AUTH state,
  //   stream teardown, base facade, authAck {ok:false,state:'revoked',reason}); only the state name differs.
  control.grant(grant: RpcAuthGrant) -> boolean   // the HELLO success path with no client HELLO: same facade/
  //   ack/deadline/timers, but UNCORRELATED — it settles no pending reauth() and emits no 'renewed'.
  // false means ONLY 'this connection is detached' (nothing was sent), never 'command rejected'. Safe before
  //   any HELLO, twice in a row and after detach. An application revocation is not undone by a resolveAuth
  //   that started before it. Exported derived type for a per-session registry (Map<userId, RpcServerControl>):
  //   RpcServerControl = ReturnType<typeof createRpcServer>['control'].
createTokenCodec({secret, ttlMs? = 15min, hmac?, now?}) -> {issue, verify}   // 'wenay-common2/server/auth' (or /server), node-only
  // one honest default behind resolveAuth: one secret, one pinned algorithm, one expiry.
  // NOT a security product: no JWT, no key rotation, no revocation list, no refresh, no identity provider.

// CLIENT hub: takes TWO functions — a socket factory + a schema builder; it is NOT an {url} or an options bag
createRpcClientHub(
  createSocket: (token: string | null) => socket,             // YOU build the socket, e.g. socket.io io(url, {transports:['websocket']})
    // do NOT put the token in the handshake (query leaks it into access logs/proxies/Referer): RPC
    // presents it in-band via Pkt.HELLO. With hubOpts.token the hub self-starts and this gets null.
  schemaBuilder: (rpc) => ({ key: rpc<Api>('socketKey') }),   // declare each socketKey's typed API
  hubOpts?: { opt?, token? },
    // token: (req: {reason: 'connect'|'notice'|'unauthorized', notice?}) => string|null|Promise<...>
    //   ONE function for the whole token lifecycle; providing it STARTS the hub (never call connect()).
    //   Single-flight: N triggers across N facade clients -> ONE provider call per wave.
    //   Precedence: an explicit connect/setToken token wins for the ONE connection wave it raises (every
    //   facade client of that wave); every LATER wave (transport reconnect, server generation change) and
    //   every renewal trigger ('expiring'/'expired'/'revoked'/'unauthorized') go to the provider. reauth(token)
    //   claims no wave — its handshake is the HELLO it issues itself. A provider yielding nothing is not a
    //   downgrade: the client keeps the token already in force.
) -> hub
hub:     connect(token) -> Promise<clients>  ·  reauth(token)  ·  facade  ·  promise  ·  socket  ·  onConnect/onDisconnect  ·  connectListen/disconnectListen  ·  authListen   // connect: was setToken
         // connect() resolves after the socket 'connect' event and RPC route/auth handshake; for in-proc/loopback (no 'connect') use hub.facade + await hub.promise
         // connect/setToken = HARD rotation (new socket, no inherited subscriptions); reauth = SOFT (live socket, subscriptions preserved)
         // authListen(cb) -> off: additive auth observers; cb gets {key, state, reason?, expiresAt?},
         //   state 'expiring'|'expired'|'revoked' (server) | 'renewed'|'renewFailed' (local, never on the wire).
         //   'renewed' (with expiresAt when the grant declared one) and 'renewFailed' report an AUTOMATIC
         //   renewal only: a manual reauth() resolves with that ack itself, and a server control.grant is
         //   an unsolicited MAP — neither emits an event.
client (on clients[key], NOT on the hub):  func (proxy) · strict (schema-safe) · close() · ready() · init() · subscriptions()
         // auth() -> Promise<authAck|null> · reauth(token) · onAuthState(cb) -> off · setTokenRenew(fn|null)
         //   auth() always answers: authAck, or null for a server WITHOUT auth, or a LOCAL
         //   {ok:false, reason:'RPC client presented no token'} for a client that never presented one.
         //   setTokenRenew is the per-client renewal seam the hub installs its provider into. Without a
         //   renewer the client never renews and never retries. With one, an E_UNAUTHORIZED rejection is
         //   retried EXACTLY ONCE — and only for a waiting func/strict call whose args carried no callback
         //   (space/fire-and-forget, callback-carrying calls, pipe and Listen attempts are never retried).
         // pipe = batch a server chain in one packet · space = fire-and-forget
         // func/space/strict paths have stable identity per client+surface: c.func.a.b === c.func.a.b;
         //   all === func. Identity survives reauth/transient reconnect; connect/setToken creates a new client generation.
         // onConnect/onDisconnect keep their legacy single-slot contract; connectListen(cb)/disconnectListen(cb) are additive and return individual off functions.
         // transient reconnect of the SAME Socket.IO object restores active logical Listen subscriptions once the new handshake is ready.
         // close()/dispose() and connect()/setToken() are terminal for the old generation. Ordinary RPC calls are NEVER
         //   replayed on transport recovery; the single E_UNAUTHORIZED retry above is a principal refresh, not a reconnect.

// minimal wiring (the part no signature can show):
const [tick, ticks] = listen<[number]>()
createRpcServerAuto({ socket, object: { math: { add: (a, b) => a + b, ticks } }, socketKey: 'math' })
const hub = createRpcClientHub(() => io(url), (rpc) => ({ math: rpc<Api>('math') }))
const c = await hub.connect(token)               // c = facade of per-socketKey clients; token goes out in Pkt.HELLO
await c.math.ready();  await c.math.func.add(2, 3)
const off = c.math.func.ticks.on(v => console.log(v))      // canonical stream subscribe; off is callable and awaitable
off()                                                     // unsubscribe; .callback/.removeCallback are legacy compat, don't teach them
c.math.func.ticks.once(v => console.log(v))               // one event, then auto-off
c.math.func.status.on(v => render(v), {current: true})    // when status is a server listenStore: current tuple first, then live
  // Since 2.12.0 the typed lane projects Listen members directly; the old
  // `as unknown as DeepSocketListen<Api>` cast still compiles but is no longer needed.
  // Late local consumers receive the latest tuple observed by the shared physical subscription.
  // That cache is cleared on disconnect/reauth; omitted/false stays live-only, and function-valued option material never crosses the wire.

// auth wiring — the whole token lifecycle behind ONE function (the application never calls connect()):
const { control } = createRpcServerAuto({ socket, object: {}, socketKey: 'math', auth: { gate: true, resolveAuth } })  // object EMPTY on purpose
const hub2 = createRpcClientHub(() => io(url), (rpc) => ({ math: rpc<Api>('math') }), { token: mintToken })
hub2.authListen(({ key, state }) => console.log(key, state))   // 'expiring'|'expired'|'revoked'|'renewed'|'renewFailed'
control.revoke('logged out elsewhere')   // server-driven cut, same corridor as expiry (no client HELLO needed)
// rules, ✅/❌ pairs and documented limits → doc/RPC-AUTH.md (read before writing auth code)

// replay upgrade — ONE WORD at the declaration site, everything below follows automatically:
// const [tick, ticks] = listen<[number]>()                                       // before
const [tick, ticks] = replayListen<[number]>({history: 1024, current: 'last'})    // after — same facade, same key
// history = hard cap in events; keepMs = retention target in ms (either bound alone enables the journal)
const [tick2, ticks2] = replayListen<[number]>({history: 50_000, keepMs: 60_000, current: 'last'})
ticks2.journalWindow()   // {entries, oldestSeq, head, ageMs, historyLimit, keepMs, cappedByCount}
// legacy subscribers unchanged (byte-for-byte). Replay consumers now also get:
const sub = replaySubscribe(l.ticks, v => {}, {since: saved, onSeq: s => saved = s})  // catch-up + live; no uncovered loss/dups (a producer frame/keyframe may jump raw seq)
const sub2 = replaySubscribe(c.math.func.ticks, v => {})  // replay members project on func/strict directly — no cast needed
const routed = replayRouteSubscribe(l.ticks, v => {}, {label: 'relay'})
await routed.switch(nextRemoteTicks, {label: 'direct'})  // relay/direct hand-off: old route closes after catch-up
await l.ticks.frame(mySeq)                                // pull at YOUR pace (50ms timer etc.) — server condenses via the line's frame lambda
// full guide + examples → rpc.md; frame model / lag policies → 🎞️ recipe below and rare docs
// authorization (gate, principal facades, token lifecycle, teardown limits) → doc/RPC-AUTH.md
```

## 🎙️ Media capture + relay/direct routes
```
import { Media } from "wenay-common2"        // or: import * as Media from "wenay-common2/media"

Media.createAudioSource({format?: 'int16'|'float32', mode?: 'pcm'|'record', packetMs? = 20, replay?}) -> [emit, listen] & control
Media.createVideoSource({fps? = 3, codec? = 'jpeg', quality?, replay?}) -> [emit, listen] & control  // fps:0 = unpaced maximum
control: start() -> Promise<'idle'|'requesting'|'live'|'denied'|'no-device'|'error'> · stop() · getStats() · setDevice(id) · listDevices() · state
Media.encodeMediaFrame(meta, payload) / Media.decodeMediaFrame(frame)     // one Uint8Array = 40-byte fixed header + raw payload

// viewer/publisher one-liners (the demo stand is built on these):
Media.attachVideoCanvas(line, canvas, {onError?}) -> {stats(), off}       // decode+render any video line; codec/size come from frame headers
Media.attachAudioPlayer(line, {minBufferSec? = 0.08, maxBacklogSec? = 0.35}) -> {enable(), disable(), enabled, stats(), off}   // jitter recovery + live backlog drop
Media.pipeMediaPublish(line, publish, {stamp? = true, onError?}) -> off   // source -> RPC publish fn; stamp lets viewers measure latency

const route = Media.createMediaRoute<[Uint8Array, number]>({
    self, peer,
    mode: 'relay'|'direct'|'best',
    connect: (pair, kind) => kind == 'relay' ? relayConnector(pair) : directConnector(pair),
})
route.resource.line.on((frame, sentAt) => {})       // stable consumer line across route changes
route.events.changed.on(({previous, current}) => {})
await route.control.start()
await route.control.setMode('best')
```
Audio default is PCM frames from `AudioWorklet` where available (`mode:'record'` uses MediaRecorder chunks); 128-sample render quanta are aggregated into 20ms packets before transport. Playback preserves an already-contiguous playhead and rebuilds the 80ms jitter buffer only after a real underrun, reported by `stats().underruns`. Video default is camera snapshots (JPEG, low fps for vision) captured hidden-tab-proof: a worker timer ticks (setInterval is throttled to ~1/s in hidden tabs), `ImageCapture.grabFrame()` reads the track (a hidden `<video>` stops painting), and JPEG encode runs in a worker (main-thread `convertToBlob` stalls ~1s hidden). Worker processing is capability-selected ON by default and falls back to the main thread; `worker:false` is the explicit video opt-out, while `worklet:false` is the audio opt-out. `getStats().execution` reports the path actually selected. Set `fps:0` for an unpaced pump: each completed frame immediately starts the next capture, so throughput is bounded by capture, encode, publish, and browser scheduling rather than a configured FPS. Screen share is the same video source with an injected stream: `createVideoSource({stream: () => navigator.mediaDevices.getDisplayMedia({video: true})})`. Put `listen` into `createRpcServerAuto` like any other Listen; with `replay:true`, the returned listen is a replay line, so RPC auto exposes legacy + replay surfaces under the same key. Backpressure policy: audio is lossless queue; video `replay:true` defaults to keep-latest frame recovery.

Route choice is deliberately per peer, not a source option. `relay` never attempts direct; `direct`
requires the direct connector and exposes no relay-delivered frames on failure; `best` starts on the
server, promotes a healthy direct replay connector, falls back without replacing the consumer line,
and retries direct. Policy hooks can still force relay or shadow relay. Source-level
`transport:'webrtc'` remains deprecated/reserved; use `createMediaRoute` with the existing
`createWebRtcConnector` signaling adapter. Living example: the demo stand (`npm run demo`) streams
camera / mic / screen share between two tabs through a tiny server-side relay of replay lines
(`demo/server.ts` + `demo/client.ts`).

> Camera, microphone, and screen capture from an external address require a browser secure context.
> Use the public certificate workflow in [`DEMO-HTTPS.md`](DEMO-HTTPS.md); plain external HTTP is not sufficient.

## 📦 Resource — file storage intents + AI job lifecycle
> `import { Resource } from 'wenay-common2'` or `import * as Resource from 'wenay-common2/resource'`.

The resource layer is deliberately above transport: byte storage is an injected port (S3/MinIO/HTTP
upload/etc.); per-account Store/replay only carries authorized file metadata and job progress.

```ts
const files = Resource.createFileJobHost({
  storage: {
    beginUpload: ({file}) => signUpload(file),      // opaque `{url, method, ...}`
    confirmUpload: ({file}) => verifyStorage(file),
    download: ({file}) => signDownload(file),
  },
  runner: {
    async run({file, input, report, cancelled}) {
      report({progress: .2, message: 'reading'})
      const result = await ai.process(file, input)
      if (!cancelled()) return {result: {resultId: result.id}}
    },
  },
})

// SERVER: another additive fragment on the EXISTING RPC connection.
const connection = files.connection(account)
object: {...legacyObject, files: connection.fragment}
disconnectListen.on(connection.close)

// CLIENT: a local Store mirror with owner-only visibility by default.
const resource = Resource.createFileJobClient({remote: c.app.func.files})
await resource.ready
const {file, upload} = await resource.startUpload({name, size, mime})
await fetch(upload.url, {method: upload.method ?? 'PUT', body: browserFile})
await resource.confirmUpload(file.id)
await resource.startJob(file.id, {prompt})
resource.store.state.jobs                         // queued/running/ready/failed/cancelled + progress/result
```

`FileJobPolicy` can grant read/write access beyond the owner. Never put bytes, a storage key, or a
reusable download URL in the shared Store; return short-lived instructions from the storage port.

## 🤖 AI — resumable runs over the existing RPC connection
> `import { Ai } from 'wenay-common2'` or `import * as Ai from 'wenay-common2/ai'`.

`Ai.createAiRunHost` is provider-neutral: an application injects the model/tool adapter, while the
library supplies owner-scoped idempotency, Store/replay state, semantic event replay, approval/input
waits, cancellation and ACL projections. It complements `Resource` — pass resource ids, never bytes.

```ts
const ai = Ai.createAiRunHost({runner, capabilities: [{kind: 'assistant'}]})
const conn = ai.connection(account)
object: {...legacyObject, ai: conn.fragment}
disconnectListen.on(conn.close)

const runs = Ai.createAiRunClient({remote: c.app.func.ai})
runs.events.on(event => {})                         // text.delta / approval / artifact / final events
await runs.ready
const run = await runs.createRun({
  requestId: crypto.randomUUID(),                   // owner-scoped safe retry key
  kind: 'assistant', input: {prompt}, resourceIds: [file.id],
})
await runs.cancelRun(run.id)                         // optional provider abort + late-output guard
runs.store.state.runs[run.id]                       // durable lifecycle/result
```

States: `queued | running | waiting_input | waiting_approval | completed | failed | cancelled`.
The final `result` and artifact descriptors are durable state; streamed `text.delta` events enhance
the live UI. `resolveApproval` and `provideInput` are server-authorized commands. Full contract,
provider boundary and reconnection rules: `doc/AI-RUN-PROTOCOL.md`; oracle: `replay/ai-run.test.ts`.

## 🧩 Artifact — storage-backed interactive output
> `import { Artifact } from 'wenay-common2'` or `import * as Artifact from 'wenay-common2/artifact'`.

Artifacts are small, owner-filtered descriptors for generated files or interactive applications.
`Artifact` never sends HTML/JS bytes, storage keys or signed URLs through Store/replay; storage returns
a short-lived open instruction only after the authorized client asks for it.

```ts
// SERVER: a trusted AI/resource runner wrote bytes to storage and received `storageKey`.
const artifacts = Artifact.createArtifactHost({storage})
const record = artifacts.register({
  owner: account,
  descriptor: {kind: 'report-app', label: 'Report', runtime: 'sandboxed-iframe', mime: 'text/html'},
  storageKey,
  retention: {class: 'ephemeral', expiresAt},
})
object: {...legacyObject, artifacts: artifacts.connection(account).fragment}

// CLIENT: replayed descriptors + a direct, short-lived open instruction.
const client = Artifact.createArtifactClient({remote: c.app.func.artifacts})
await client.ready
const frame = Artifact.createArtifactFrame({
  artifacts: client, frame: iframe, allowedOrigins: ['https://artifacts.example'],
})
await frame.mount(record.id)  // only sandboxed-iframe; sandbox="allow-scripts", no same-origin/parent bridge
```

`revoke(id)` and server-side `reap()` prevent new opens and delegate physical removal to the injected
storage adapter. Persistent retention requires an application database/provider mapping; the host is
not a hidden durable storage engine. Full security, lifecycle and deployment contract:
`doc/ARTIFACT-RUNTIME.md`; oracle: `replay/artifact-runtime.test.ts`; the demo creates and opens a
cross-origin sandboxed counter artifact from an AI run.

```ts
// NODE-TO-NODE transfer (dynamic code, safely): catalog replicates as a store,
// bytes travel lazily by content hash, execution stays in the sandbox.
Artifact.sha256Hex(bytes) -> Promise<hex>           // descriptor.version = content hash of the bytes
Artifact.createArtifactByteCache({fetch, maxBytes?, onEvict?}) -> {get(record), has, peek, stats, clear}
  // get: cache -> single-flight fetch from the source -> sha256 MUST equal descriptor.version
  //   (tampered bytes throw; artifacts without a content-hash version are refused)
Artifact.createArtifactMirror({catalog, policy?, open, revoke?}) -> {connection(account), close}
  // read edge over a mirrored catalog (createStoreFollower<ArtifactStore>): the SAME
  //   {state, open, revoke} fragment shape as the host — clients cannot tell the nodes apart;
  //   open() authorizes locally, then your deps serve bytes (byte cache + local ticket URL);
  //   revoke forwards to the source of truth with the END client's account
```
Demo: `npm run demo:mirror -- http://localhost:3101` follows the exact leader URL printed by
`npm run demo`; omitting the argument keeps the historical `http://localhost:3100` default.
An AI artifact created on either instance opens on the other (catalog via replay, bytes lazily by
hash, each node serves from its own sandbox origin).

## 💬 Conversation — channels, structured messages and facts
> `import { Conversation } from 'wenay-common2'` or
> `import * as Conversation from 'wenay-common2/conversation'`.

`Conversation` is a logical dialogue layer above the existing RPC/Store/replay stack. One physical
connection carries many conversations and child channels; messages contain safe versioned data blocks,
while scoped facts provide explicit, revision-checked context for people and AI workers.

```ts
// SERVER: add one account-filtered fragment beside existing RPC keys.
const conversations = Conversation.createConversationHost({persistence})
const connection = conversations.connection(account)
object: {...legacyObject, conversation: connection.fragment}
disconnectListen.on(connection.close)

// CLIENT: mirror state, issue idempotent commands, derive the selected channel view.
const chat = Conversation.createConversationClient({remote: c.app.func.conversation})
await chat.ready
const created = await chat.createConversation({
  requestId: crypto.randomUUID(), title: 'Workspace', participantIds: ['b'], rootTitle: 'Main',
})
const message = await chat.postMessage({
  requestId: crypto.randomUUID(), conversationId: created.conversation.id, channelId: created.channel.id,
  blocks: [{kind: 'text', version: 1, text: 'Start here'}],
})
const child = await chat.createChannel({
  requestId: crypto.randomUUID(), conversationId: created.conversation.id,
  title: 'Details', parentMessageId: message.id, factMode: 'inherit',
})
chat.channelMessages(child.id)
chat.channelFacts(child.id)
```

Built-in blocks are `text`, `list`, `table`, `fact`, `resource`, `artifact` and `custom`. Unknown custom
types remain declarative data for a safe fallback renderer; executable applications belong to
`Artifact`. Every write has an account-scoped `requestId`; fact writes may include `expectedRevision`.
The optional persistence port atomically commits a semantic event plus private idempotency receipt
before Store visibility. Full ownership, retention and inheritance contract:
`doc/CONVERSATION-RUNTIME.md`; oracle: `replay/conversation-runtime.test.ts`; `npm run demo` shows the
root → child-dialogue → scoped-fact path for two participants.

## 🔗 Contract — dynamic versioned implementation binding
> `import { Contract } from 'wenay-common2'` or
> `import * as Contract from 'wenay-common2/contract'`.

`Contract` keeps a logical component slot stable while compatible local, RPC, worker or downloaded
implementations appear, update, fail or are revoked. It is the contract/lifecycle boundary: the
application loader still owns compilation, package bytes and platform loading; Store/replay and
physical connections stay below the replaceable implementation.

```ts
const offers = Contract.createContractOffers()
const runtime = Contract.createContractRuntime({
    offers: offers.api,
    policy: {
        compatible: (demand, descriptor) => satisfies(descriptor.contractVersion, demand.versionRange),
        acceptSession: async (demand, offer, api) => ({accepted: await healthCheck(api)}),
    },
})

offers.control.upsert({
    id: 'editor.remote',
    priority: 20,
    descriptor: {
        protocol: 1, contractId: 'workspace.editor', contractVersion: '1.2.0',
        implementationId: 'editor', implementationVersion: '2026.07.20+7f3a',
        capabilities: ['save'],
    },
    async open(ctx) {
        const connection = await loader.openEditor(ctx.descriptor)
        return {api: connection.api, onFail: connection.onFail, close: connection.close}
    },
})

await runtime.control.require({
    slotId: 'main.editor', contractId: 'workspace.editor', versionRange: '^1.2',
    generation: 14, authorityId: 'backend-a', authorityEpoch: 3,
    required: true, capabilities: ['save'],
})

const lease = runtime.api.acquire<EditorApi>('main.editor')
try { await lease.api.save() } finally { lease.release() }
```

Exact contract-version equality is the safe default; ranges require an injected compatibility
policy. A candidate opens and passes policy before the active binding changes. Old sessions drain
behind explicit leases; failures try the next candidate. `revokeOffer`/`restoreOffer`, compatible
`rollback`, required/degraded states, `status`, `changed`, `explain` and `history` make every decision
observable. Replayed demand coordinates are idempotent; stale and same-coordinate conflicting demands
are rejected. Full model and integration rules: `doc/CONTRACT-RUNTIME.md`. Oracles:
`observe/contract-runtime.test.ts` and `oracle/realsocket/contract-runtime.spec.ts`; interactive path:
`npm run demo` → **Lab** → **Versioned contract runtime**.

## 🤝 Peer — accounts see each other's stores (one-call SDK)
> `import { Peer } from "wenay-common2"` or `import * as Peer from "wenay-common2/peer"`.
> The happy-path facade over rpc + store + replay + route coordinator. Legacy-friendly by design:
> the server side is a FRAGMENT spread into your EXISTING `createRpcServerAuto` object, the client
> side rides your existing connection — old keys keep working untouched.
```
// SERVER — next to your legacy object:
const host = Peer.createPeerHost({authorize?, history?})   // authorize(env) = server-side canExposeEndpoint
io.on('connection', socket => {
    const peer = host.connection(accountOf(socket))        // per-account signal port + relay journal
    createRpcServerAuto({socket, socketKey, object: {...legacyObject, peer: peer.fragment}, disconnectListen})
    disconnectListen.on(peer.close)
})
host: connection(account) · relay(account) · accounts() · revoke(pair, accounts, reason?) · close()

// CLIENT — the whole happy path:
const me = Peer.createPeerClient<World>({
    remote: c.app.func.peer,        // deep proxy of the fragment — rest of the connection is yours
    account: 'a',
    initial: {...},                 // own store: write me.store.state — others see it
    rtc?: () => new RTCPeerConnection(cfg),   // omit = relay-only (promoteDirect unavailable)
})
const bob = me.peer('b')            // mirror + route control for another account
await bob.ready                     // keyframe/tail landed
bob.store.state                     // live mirror — reads survive ANY route change
await bob.promoteDirect()           // relay -> WebRTC direct; {ok, state, reason?} result, not a throw
bob.route()                         // 'relay' | 'direct' · bob.reinterposeRelay() · bob.fallback() · bob.block()
me.onRoute(ev => {})                // route transitions for metrics/UI
```
Key property: the relay journal stores the owner's envelopes VERBATIM (owner seq space), so a
relay <-> direct hand-off is a plain seq resume — no uncovered loss or duplicate delivery. Late joiners
get a keyframe folded server-side even while the owner is offline.
Owner bursts use additive `publishBatch` (up to 64 items / about 64 KiB) when the host advertises it;
an old host receives the unchanged `publish(env)` calls. Direct replay channels negotiate the same
bounded live-message batching and an exact binary value protocol through an ordered `hello`/`ready`
handshake. Either old endpoint keeps the historical JSON/base64 one-envelope route. The same replay
datachannel preserves rich mixed values and `Media` `Uint8Array` frames byte-for-byte, so a direct
route can feed existing `Media` Listen/replay consumers; native WebRTC tracks/SFU are optional future
performance adapters, not a second media semantic.

> Public WSS/WebRTC demo setup and certificate verification → [`DEMO-HTTPS.md`](DEMO-HTTPS.md).

Reconnect correctness is self-healing: a publisher gap makes the relay reject the push WITH its last
seq, and the client repairs from that coordinate automatically (`repair: 'tail'` lossless (default)
| `'keyframe'` cheap reset for ephemeral state). Server declares journal semantics
(`createPeerHost({gap: 'resume' | 'sacred'})`); a declared `journal: 'sacred'` TYPE-forbids the cheap
repair. `me.resync()` after a transport reconnect repairs without waiting for the next write;
failures surface via `onPublishError`, never silently. Policy/session material:
`createPeerClient({session, accept, policy})` + host `authorize` — see rare docs for the envelope
contract and the underlying primitives (`createRouteCoordinator`, `createSignalHub`,
`createWebRtcConnector`). Oracle: `replay/peer-sdk.test.ts`.

### Arbitrary peer packets and multi-hop routes
```
const offers = Peer.createPeerPacketOffers<Payload>()
// discovery publishes reusable capabilities; connect() may reopen after failure
offers.control.upsert({
    id: 'a-to-b', peerId: 'b', priority: 7,
    connect: () => ({peerId: 'b', send, messages, ping?, onFail?, close}),
})

const mesh = Peer.createPeerPacketMesh<Payload>({
    meshId: 'package-network', nodeId: 'a', offers: offers.api,
})
mesh.packets.on((payload, meta) => {})       // meta.path is the actual traversed path
await mesh.send('server', payload)           // cheapest live direct or multi-hop route
await mesh.broadcast(['b', 'c'], payload)    // independently routed group delivery
mesh.routes()                                // targetId, nextHopId, offerId, cost, path
```
Nodes exchange bounded, loop-safe path advertisements through the sessions themselves. A packet carries
`packetId`, `originId`, `sequence`, `ttl` and `path`; per-origin duplicate identities, cycles and expired
TTLs are rejected before delivery. `send(...).ok` confirms that the selected next hop accepted the
packet; it is not an end-to-end receipt. An intermediate client forwards the opaque payload, while
`accept(packet, from)` authorizes only the authenticated immediate session peer. Treat `originId` and
`path` as informational unless the payload/session adapter supplies signed provenance; every relay in
an unsigned mesh must be trusted. The mesh owns connection retry, ping cost, route selection and
fallback; the offer adapter owns RPC/WebRTC/worker-specific transport details. Oracle:
`replay/peer-packet-mesh.test.ts`; stand: **Lab → Peer packet mesh**.

### Calls, presence and the media relay (messenger-style, on the same parts)
```
// presence rides in the fragment (host >= 1.0.74): subscribe FIRST, then list()
c.app.func.peer.presence.changes.on(({account, online}) => {})
await c.app.func.peer.presence.list()                       // ['a', 'b', ...] — connected right now

// SERVER — media relay next to the fragment (per-account named lines, policy-gated watch):
const media = Peer.createMediaRelay({
    lines: {cam: 'video', mic: 'audio', screen: 'video'},
    canWatch?: (watcher, owner, line) => bool,   // ACL, checked on paths + every forwarded frame
})
object: {peer: peer.fragment, media: {publish: media.publishOf(account), watch: media.watchOf(account)}}
media.dropAccount(account)   // retire lines + keyspace (e.g. on presence offline); next publish revives

// CLIENT — calls are envelopes over the SAME signal port; media attach stays app code:
const calls = Peer.createCallManager({port: Peer.callPortOf(c.app.func.peer), self: 'a'})
await calls.ready                                           // signal subscription confirmed server-side
calls.rings.on(call => { call.accept() /* or call.decline() */ })
const call = calls.call('b', {kinds: ['cam', 'mic']})       // meta rides opaquely
call.changed.on(state => {})                                // 'active' | 'ended'
await call.ended                                            // 'declined'|'busy'|'offline'|'timeout'|'hangup'|'canceled'
call.hangup()
// while active: publish own frames + attach the peer's lines (Media.attach* viewers)
media.publish('cam', frame, Date.now());  attachVideoCanvas(c.app.func.media.watch.b.cam, canvas)
```
Relay-first is the privacy default (mainstream messengers route calls through their servers too);
`promoteDirect` stays the policy-gated opt-in for the data path. Ring/accept/decline/hangup ride the
existing signal hub — the host `authorize` hook sees them too (single server-side policy point), and
an offline callee fails fast (`'offline'`), no timeout wait. The default incoming gate auto-declines
with `'busy'` during a live call, which also settles simultaneous cross-calls. `video` relay lines
are keep-latest (late joiner pulls `keyframe()` instantly), `audio` is a short lossless queue; frames
ride as `[frame, sentAt]` so viewer latency stats work out of the box. Watch access is an ACL, not a
convention: `watchOf(account)` views run `canWatch` on every new subscribe/keyframe and every live
frame. "Media access follows the call" is a few lines of app code (grant on `'active'`, revoke on
`'ended'`); after revocation an already-open policy view receives no more data. Oracle:
`replay/peer-call.test.ts`.

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
Observe.cloneStoreValue<T>(value) -> T                            // detached clone with the same rich/binary/cycle semantics as Store snapshots
Observe.listenStorePatches(store) -> Listen<[readonly StorePatch[]]> // public settled patch feed: one source array per Store drain

// network shape: backend exposes snapshots + changed Listen; frontend mirrors selected masks locally
Observe.exposeStore(store, {push?: true | {maxItems?, maxBytes?}}?) -> { get(mask?), set(path,value), replace(path,value), changed, changedPaths, patches?, patchesBatch?, changedData? }
Observe.createStoreMirror(remote, initial, opts?) -> store & { sync(mask, opts?) -> Promise<off>; syncPatches(mask, opts?) -> Promise<off>; syncChangedData(mask, opts?) -> Promise<off> }
// changedPaths is optional optimization: mirror pulls mask ∩ dirty paths; fallback is changed -> get(mask).
// Optional push-data mode: exposeStore(store,{push:true}) + syncPatches/syncChangedData; new mirrors prefer
// patchesBatch (bounded physical envelopes, default 256 items / 64 KiB of packed RPC data including binary attachments)
// and automatically fall back to legacy patches. A large sampled drain may split into several callbacks.
// Mirrors subscribe before their initial get(), so a concurrent source mutation cannot fall through the gap.

// High-level keyed collection over the same Store Replay stack (normal values in app code; compact tuples stay internal)
Observe.createReplicatedMap<V, K extends string = string>({keyOf, initial?, store?, delivery: 'latest'|'lossless', replay?})
  -> {api, control: {set, setMany, delete, deleteMany, replaceAll, get, has, snapshot, flush, close}}
Observe.followReplicatedMap<V, K>(remote, {onBatch?, onStatus?, onError?, staleMs?, drain?, checkpoint?, policy?})
  -> {get, has, snapshot, onKey, batches, keys, ready, status, statusChanges, seq(), replayMode(), delivery(), checkpoint(), isStale, close, debug: {store}}
  // `latest`: duplicate keys in one producer operation collapse to their final value; reconnect may reset by keyframe.
  // `latest.replaceAll(fullSnapshot)` compares every key but clones, mutates and publishes only semantic changes.
  // Fresh object identity does not force a write. If the source already knows its dirty keys, setMany(changes)
  // skips the full-snapshot comparison and remains the cheapest producer path.
  // `lossless`: every accepted set operation stays ordered inside its physical batch; gaps/line changes fail loudly.
  // An injected store is latest-only; its root is a plain keyed object with enumerable string data properties,
  // and every top-level key must equal keyOf(value). The facade validates before publish.
  // debug.store is an ADVANCED writable escape hatch for diagnostics; application writes violate follower ownership.
  // checkpoint() binds snapshot + lineId + delivery/replayMode/seq, so a naked tail can never create a partial map.
  // Store Replay V2 is the only batch wire and travels through the JSON-array RPC lane.

// Sequenced sync (replay line): seq-numbered patch stream — keyframe catch-up, reconnect by seq (tail, not snapshot)
Observe.exposeStoreReplay(store, {history? = 1024, keepMs?, maxItems?, maxBytes?, maxDelayMs?, patchSource?}) -> { api /* spread into the RPC server object */, replay, batchStats, flushPending, close }
  // history = hard cap in ENVELOPES, so its depth in wall-clock time follows the write rate.
  // keepMs = retention target in milliseconds: what a reconnect window is actually expressed in.
  //   Set it when the requirement is "a client returning within N seconds must cost a journal tail,
  //   not a keyframe" — a short window is what turns a reconnect into a full snapshot, and on a slow
  //   link that snapshot is itself what starves the heartbeat (experiments/slow-network-2026-08).
  //   history still wins as the hard cap; with only keepMs set the count is unbounded and memory is
  //   rate x keepMs. replay.journalWindow() reports the window actually retained and whether the
  //   count cap cut a keepMs target short.
  // api.replay is the sole Store Replay V2 facade. There is no legacy single-patch route or negotiation.
  // Store-owned Replay refines safe array-slot replacements to exact index patches without changing
  // public changedPaths/listenStorePatches. Length changes and whole-array replacement stay whole-array patches.
  // maxItems/maxBytes may split one source drain; maxDelayMs>0 may merge adjacent drains.
  // Each resulting bounded V2 envelope owns one seq.
  // A patch whose value itself is undefined remains represented by the V2 patch opcode.
Observe.syncStoreReplay(mirror, remote /*{line, since, keyframe, frame?} of api.replay*/, {since?, onSeq?, validateBatch?, onBatch?}) -> off
  // an RPC proxy waits for MAP before starting the V2 line; plain in-process remotes stay synchronous
  // validateBatch runs after decode and before mutation. onBatch runs once AFTER one physical envelope is applied;
  // an onBatch throw is terminal, does not roll Store state back, and does not advance the replay seq.
  // off.ready (catch-up done) · off.mode ('v2') · off.seq()
  // lagging/late client NEVER gets a backlog: evicted seq -> ONE fresh keyframe + live
  // freshness is an option, not consumer boilerplate: {staleMs, onStale} flags a silent line / stale keyframe (edge-triggered both ways; 🎞️ in rare docs)
// Very slow link, merge semantics (top-level value is absolute, last write per key wins):
// fill progressively instead of ever sending a keyframe.
const lazy = Observe.exposeStoreLazyLine(store, {chunkBytes: 32 * 1024, windowBytes: 512 * 1024, tombstoneKeepMs: 600_000, lineId})
const fill = Observe.syncStoreLazyLine(mirror, lazy.api, {cursor: savedCursor, onCursor: persist})
await fill.filled                                    // promise: every key delivered at least once
  // THERE IS NO SNAPSHOT — not of values, not even of a key list. Progress is one cursor the
  // SUBSCRIBER holds, {lineId, key, revision} = "I have every key up to `key`, as of `revision`,
  // on line `lineId`". lineId is what makes the claim checkable: a revision only means something
  // inside one host lifetime, so a cursor from a restarted host is refused instead of trusted.
  // A refused cursor comes back as {stale: true}; the subscriber then restarts the pass AND
  // sweeps every mirror key the fresh pass never mentioned, because the host can no longer prove
  // which keys were deleted while it was away. Resetting only the cursor would keep ghosts.
  // A read that runs out of budget part way through what the subscriber was owed carries the
  // part it DID reconcile as cursor.catchUp {key, revision}; the next read continues from there
  // instead of redoing it. `filled` stays false while any of that is outstanding.
  // The host keeps no per-subscriber state, so a reconnect RESUMES the fill instead of
  // restarting it; persist the cursor through onCursor and hand it back to continue.
  // Values are read AT SEND TIME: a key rewritten beyond the cursor costs zero extra bytes and
  // still lands newest; a key changed behind the cursor is re-sent. That is all convergence
  // needs — no frozen snapshot, no second copy, no restart when the Store changes mid-transfer.
  // A deleted key behind the cursor travels as a tombstone; tombstoneKeepMs bounds how long
  // that stays provable, and a cursor older than the last prune is refused with {stale: true}.
  // Pull-based: readBytes is the rate control, so a background fill cannot queue ahead of an
  // urgent line. Keep it ABOVE the link's bandwidth-delay product or the link idles between
  // reads (measured: a 16 KiB budget on a 128 KiB/s x 160 ms link was latency-bound).
  // Measured on 20 000 keys at ~1 Mbit/s: first paint 718 ms vs 11 579 ms for a keyframe, 6 %
  // fewer bytes, 1.33x slower full convergence (experiments/store-lazy-2026-08). On a few
  // hundred keys it is at best parity — a small keyframe is already cheap.
  // The mirror shows a MIX of fresh and stale keys while the first pass runs: that is the
  // trade. For an all-or-nothing transfer use createStoreReplayView instead.
  // keys: [...] makes the line SELECTED: only those top-level keys travel, unselected churn
  // costs nothing (no clone, no revision bump), and the cursor gains selectionId — publishing a
  // different set makes old cursors {stale: true} and the subscriber reconciles by pass + sweep.
  // One store can carry several lazy lines (full + per-partition selections) side by side.
  // view: {lineId, selectionId, keys(), snapshot()}. Tombstones also expire on read, so a quiet
  // line does not retain them; a root-swap patch from a custom source tombstones vanished keys.
// Large selective Store: one authoritative Store, no materialized child Store per client.
const quotesView = Observe.createStoreReplayView(quotes, {
  keys: authorizedSymbols,                 // static/server-authorized top-level string keys
  lineId: 'quotes:account-scope:v1',
  history: 4096,
  snapshot: {chunkBytes: 512 * 1024, windowBytes: 1024 * 1024}
})
// Expose `quotesView.resource`; clients with the same selection should share this one view instance.
const selectedMirror = Observe.createStore<Record<string, Quote>>({})
const selectedSync = Observe.syncStoreReplayView(selectedMirror, api.quotesView, {
  cursor: persistedCursor                 // {lineId,selectionId,seq}; omit for the first snapshot
})
await selectedSync.ready
persist(selectedSync.cursor())
  // The view retains only a normalized key Set, one filtered V2 journal and bounded snapshot cursors.
  // Views share one exact-path Store watcher and detach only the union of selected changed values.
  // Unselected changes produce no clone, view seq or client fan-out. Initial data is sampled key by key:
  // callback chunks are separated by a task turn, while each RPC read response grants the next bounded window.
  // Plain Store values are sized without materializing a second packed/JSON/UTF-8 copy.
  // Defaults: about 512 KiB/chunk, 1 MiB/window, 256 patches/chunk, 32 cursors, 30 s cursor TTL.
  // The mirror remains unchanged while chunks arrive, then swaps once and applies the retained V2 tail.
  // One selected top-level value is indivisible in V1; keep giant blobs/media on a byte-stream resource.
quotesView.close()

Observe.syncStoreReplayRoute(mirror, remote, {label?, validateBatch?, onBatch?}) -> off & {switch(nextRemote, opts), ready, seq(), label(), active(), mode}
  // relay/direct promotion and re-interposition: replacement route catches up by seq before the old route closes
  // route validation/callback ordering matches syncStoreReplay; every route uses the V2 seq-space
Observe.createStoreFollower<T>({remote, initial?, expose?, staleMs?}) -> {store, status, api, replay, ready, isStale, close}
  // server-side mirror instance (leader -> follower -> its own clients): syncStoreReplay INTO a local store
  //   + cascade exposeStoreReplay OVER it — `api` goes into the follower's RPC object like any store line
  // status = a tiny reactive store {upstream: 'catching-up'|'live'|'offline'|'closed', seq, replayMode, error} — the
  //   follower never writes into the mirrored store itself (it must stay byte-equal to the leader)
  // commands are NOT applied locally: forward them to the leader with the END client's (account, requestId)
  //   so idempotency receipts and ordering stay on the single leader (demo: DEMO_MIRROR_OF, doc/target plan)
  // follower.promote() -> {store, replay, epoch}: manual failover — mirroring stops, epoch grows by 1,
  //   the cascade journal LIVES ON, so this node's subscribers keep their line without a re-keyframe;
  //   build the command authority OVER the same store (the demo workboard host adopts it via deps.store)
Observe.createStoreReplicaOffers(initial?) -> {control: {upsert, remove, replace, clear}, api: {list, changes}}
Observe.createStoreReplicaSet<T>({storeId, originId, nodeId, lineId?, store?, initial?, offers?, leadership?, route?})
  -> {control, api, close}
  // self-assembling Store above transports: each StoreReplicaOffer is a reusable connect capability;
  //   its session exposes {descriptor, changed?, replay, ping?} and close/onFail — RPC, WebRTC, a worker,
  //   or an in-process edge all use the same small boundary
  // api.fragment = the descriptor + cascading replay line to expose through RPC or another transport;
  //   client replicas may participate with leadership.eligible:false and still serve downstream copies
  // route choice = freshest route to the selected authority, then cumulative measured latency + priority;
  //   hysteresis avoids jitter flaps, path rejects cycles, syncStoreReplayRoute keeps hand-off gap-free
  // leadership: epoch/leader/authority-line fork choice by default; autoPromoteMs is opt-in availability mode;
  //   inject elect/accept/compare for quorum certificates or leases. canWrite() is the command admission guard
  // divergent writable partitions are never merged silently: the losing leader adopts the winning keyframe
  //   and emits conflicts with localOnly/authorityOnly/same-key pairs for application recovery
Observe.diffKeyedState(local, authority) -> {localOnly, authorityOnly, conflicts}
  // split-brain tail after a failover rejoin: localOnly = re-apply candidates (mempool analogy),
  //   conflicts = both sides changed one record (the epoch already chose the winner; the pair is preserved)
Observe.syncStoreReplayEach<T>(remote, (key, value, ctx) => {}, opts?) -> off & {store, ready, mode, seq(), isStale(), lastTs()}
  // one-call remote fold: mirror store + syncStoreReplay + store.each() — the callback fires per CHANGED
  //   top-level key; first delivery = keyframe EXPANDED per key; (key, undefined) = key deleted
  // opts = all replaySubscribe opts (since/onSeq/policy/staleMs/onStale/onError...) + {drain?, initial?}
  // off() tears down BOTH the store sub and the wire sub; direct reads via off.store.state.KEY
  // reconnect: syncStoreReplayEach(remote, cb, {since: prev.seq(), initial: prev.store.snapshot()})
  //   — the tail lands ON TOP of the previous state (a fresh empty mirror would not converge)
// Built-in AI/Conversation/Artifact/FileJob state fragments use Store Replay V2 and reconcile account
// projections by changed record id, so an unrelated tenant produces no view patches.
// Their clients expose stateMode(), which is always 'v2' in 2.x.
// Living check: `npm run demo` → Store shows `replay v2` beside its live seq.
// Offline persisted mirror (snapshot mode): local cache first, then replay catch-up by seq
Observe.createOfflineStore({key, remote?, initial, storage, version?, debounceMs?, syncOpts?}) -> Promise<store & {ready, flush(), close(), status(), statusListen, reconnect(remote)}>
Observe.persistStore(store, {key, storage, seq?, debounceMs?}) -> {flush, forceFlush, close, setSeq, seq, status, statusListen}
Observe.createMemoryOfflineStorage(initial?) -> OfflineStorage
  // persists {version, seq, replayMode:'v2', snapshot, savedAt}; older coordinates force a safe keyframe
  // mode:'topLevel' is reserved; first implemented mode is snapshot

// Declarative resource manager above mirror/replay/offline: app chooses what to start, not the store core
Observe.managedStore.mirror({remote, initial, mask, tags?, priority?, explicitOnly?, large?, sync?})
Observe.managedStore.replay({remote, initial, tags?, priority?, explicitOnly?, large?, syncOpts?})
Observe.managedStore.offline({remote?, initial, storage, storageKey?, tags?, priority?, explicitOnly?, large?, syncOpts?})
Observe.createStoreManager(resources) -> {plan(opts?), start(key, opts?), startPlanned(opts?), stop(key), stopAll(), get(key), touch(key, weight?), usage(), statusListen, handles}
  // plan excludes explicitOnly/large by default; {includeExplicit, includeLarge} opts opt them in
// Slow-client conflation: recipe section 🎞️ below. Full generic surface (any event line, history/time-travel) -> Replay namespace, 🎞️ in rare docs.
// Public Store paths keep array mutation at the whole-array branch; Store-owned Replay may privately refine safe slots.
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

// usual keyed feed: the facade owns Store, replay journal, mirror, seq, reconnect and cleanup
type Quote = {s: string; c: string}
const quotes = Observe.createReplicatedMap<Quote>({
    keyOf(quote) { return quote.s },
    initial: seedQuotes,
    delivery: 'latest',
})
const offFeed = quoteFeed.on(quotes.control.setMany)     // one producer operation; wire bounds may split its physical envelopes

// expose `quotes.api` on the server; the client needs one follow call
const followedQuotes = Observe.followReplicatedMap(api.quotes, {
    onBatch(change) {
        updateTable(change.set.map(function quoteToRow([symbol, quote]) {
            return {symbol, price: +quote.c}
        }))
        for (const symbol of change.delete) removeRow(symbol)
    },
})
await followedQuotes.ready
followedQuotes.get('BTCUSDT')
followedQuotes.snapshot()
const offBtc = followedQuotes.onKey('BTCUSDT', onQuote, {current: true})
const checkpoint = followedQuotes.checkpoint()          // persist atomically; pass back as {checkpoint}
offBtc()
followedQuotes.close()
offFeed()
quotes.control.close()

// the same per-key contract over the wire — ONE call (mirror store + syncStoreReplay + each)
const exposed = Observe.exposeStoreReplay(rows, {history: 1024})
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
Replica-set oracle: `npx tsx observe/store-replica-set.test.ts`;
real two-hop Socket.IO/RPC wire: `oracle/realsocket/store-replica-set.spec.ts`; interactive network:
`npm run demo` → **Lab** → **Self-assembling Store replica set** (live offer/session/selected-route graph).

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
})   // current+frame = compact + keyframe fallback · current only = exact tail + keyframe · frame only = compact while retained, loud on eviction · neither = sacred exact queue
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
const sub = Replay.replaySubscribe(deep.quotes, cb, {since: saved, policy: 'frame'}) // server may skip live envelopes; drain -> state-equivalent mini-frame
const sub2 = Replay.replaySubscribe(deep.quotes, cb2, {since: saved})                // 'queue' (default): ungated live; catch-up may still use producer frame/keyframe
// own pace (e.g. 50ms skips + condensation): pull on YOUR timer — hint picks the rule, server condenses:
//   every(50, async () => { for (const ev of await deep.quotes.frame(mySeq, hint)) apply(ev); })
// store mirror: Observe.syncStoreReplay(mirror, deep.replay, {since: prev.seq(), policy: 'frame'}) — same gate contract
// delivery contract: FIRST delivery = snapshot/tail start (same event type), then strictly-newer,
// seq-ascending and deduped. Raw seq jumps are legal only when a producer frame/keyframe covers them;
// a sacred retained tail is exact, while sacred eviction closes with onError instead of continuing past a hole.
```
Rules that make it correct (violating any of these silently breaks convergence):
- **The line declares its recovery sources.** `current` (keyframe: SAMPLED from truth, never computed
  from deltas; `'last'` = last envelope for single-entity lines) and/or `frame` (condenser). Without
  `current`, eviction is terminal even when a condenser exists: a true sacred queue (neither source)
  replays the retained tail exactly, and `frame()` THROWS once that tail is gone. A lagging
  `'frame'`-policy sacred subscriber gets a stream end, never silent loss.
- **A `frame` result must be state-equivalent to the tail it replaces** (per the line's own semantics).
  "Can't condense THIS tail" is legal and simple: return the tail as-is. Refuse-loudly is `throw`.
  Multiple condensation standards live INSIDE the lambda, dispatched by the client-supplied `hint`
  (opaque to the transport): `frame(tail, hint)`.
- **Events must be ABSOLUTE per their entity** for last-per-entity condensing (store patches are).
- Gate drops never hole the journal — it is written BEFORE any gate. Queue-policy live delivery is
  ungated; reconnect catch-up may use the producer's state-equivalent mini-frame. An evicted state
  line falls back to a keyframe (visible raw seq jump); an evicted sacred line fails terminally.
- `pending()` and the watermarks share units (bytes, packets, frames — anything, but the same).

Manual path (pre-rev2, still works, `keyOf` @deprecated): build the gate yourself with
`Replay.conflateReplay(exposed.replay, {pending, highWater, keyOf})` and spread `gated.api` into the
facade — details in rare docs. New code should declare `frame` on the line instead.

Wire-level proof/oracles: `npx tsx replay/rpc-auto.test.ts` (real Socket.IO: auto-exposure, legacy
parity, frame equivalence, gate lag sim), plus `replay/conflate-socket.test.ts`, `replay/conflate.test.ts`,
`replay/coalesce.test.ts`. Full generic surface (history/time-travel, archive) → 🎞️ in rare docs.

## 💾 durability, flight recorder, node health
```
import { Observe, Replay, createNodeIdMinter } from "wenay-common2"
import { openFsReplayStorage } from "wenay-common2/server/fs"

// The persistence PORT is Replay.ReplayStorage {putEvent, putEvents?, putKeyframe,
// getKeyframe -> ReplayEvent | undefined, getEvents}:
// createMemoryReplayStorage (reference), openFsReplayStorage(file) (node, JSONL append-log,
// .compact() = atomic [latest keyframe + tail] rewrite), or your DB adapter behind the same lambdas.
// Retention is ADAPTER policy, always OPT-IN: memory takes {maxEvents?, maxKeyframes?}; the fs
// adapter takes {maxBytes?} — absent = append-only forever; present = the log is pruned at a
// KEYFRAME boundary to ~3/4 of the budget, keeping the LONGEST suffix that fits, so the budget
// buys "how long can a client be away and still get its exact tail". A reader older than the cut
// gets a keyframe reset (the wire semantics an evicted seq already has). The lossless floor
// [latest keyframe + tail] is never cut into: size().overBudget reports it instead.
// NB the reference fs adapter mirrors the file in RAM (it IS the seek index): budget the two together.

openFsSpillJournal(file, {history, maxBytes, codec?}) -> {line: {getSince, onJournal}, size, close}
  // the THIRD retention mode, between "bounded RAM ring" and the always-on durable journal:
  // recent history lives in a RAM ring (`history` events), the disk is written ONLY on eviction —
  // steady state with every consumer inside the window costs ZERO SSD writes. The spilled prefix
  // extends "how long can a client be away and still get its exact tail" up to `maxBytes`
  // (two rotated JSONL segments — prune drops the older segment, never rewrites; the disk part
  // is NOT mirrored in RAM, reads open the file only on a cache-miss getSince).
  // Wire it as the line's memory-outside: exposeStoreReplay(store, {...spill.line}) or
  // replayListen(base, {current, ...spill.line}). Deliberately NOT restart-durable (open()
  // starts a fresh lifetime — a dead process's RAM suffix leaves an unfillable gap; restarts
  // are createDurableStoreReplay's job) and best-effort on disk trouble: a failed spill shrinks
  // the window to RAM (size().spillErrors counts), old readers degrade to the keyframe reset
  // the wire already knows — never to a broken tail. Oracle: replay/fs-spill-journal.test.ts

Observe.createDurableStoreReplay<T>({storage, initial?, everyEvents? = 64, everyMs?, drain?, expose?})
    -> {store, api, replay, restored: {seq, fromArchive}, stats, retry, close}
  // the line SURVIVES a process restart: state hydrates from [keyframe + deltas], seq numbering
  // continues (firstSeq), a mirror reconnecting with its old seq gets the exact persisted tail
  // (no keyframe reset), every new patch + cadence keyframes go back into storage. A capable adapter receives
  // one atomic all-or-throw putEvents(...) per natural Store drain before head/fan-out. A failed batch is retained;
  // retry() persists/publishes it once. The FS adapter writes one `b` JSONL record and discards a torn trailing record on open.
  // Leadership/epoch stay upper-layer (follower/replica-set). Oracle: oracle/realsocket/store-durable.spec.ts

// flight recorder — record any replay line, play it back at any pace
Replay.createJsonlReplayWriter(write: (line: string) => void) -> ReplayStorage  // write-only sink for archiveReplay
Replay.loadJsonlReplay(lines | text) -> ReplayStorage                           // recording -> seekable archive
Observe.playbackStoreReplay<T>(storage, {speed? = 1 | Infinity, maxStepMs?, drain?, expose?})
    -> {store, api, replay, range: {from, to}, done: Promise, close}
  // re-emits the recorded patch line as an ORDINARY head — mirrors consume it like live;
  // playback batching is opt-in through expose.batch; recording coordinates remain unchanged
  // random access stays Observe.storeReplayAt(storage, {seq|ts}). Oracle: replay/record-playback.test.ts

// node health — stats() of local primitives aggregated into ONE mirrorable store
Observe.createNodeHealth({node, intervalMs?, now?, drain?})
    -> {store, register(name, probe: () => plainData) -> off, refresh(name?), close}
  // a throwing probe records {error} without breaking the rest; publish with exposeStoreReplay —
  // monitoring of the replication IS replication. Oracle: observe/node-health.test.ts

// post-failover id safety + artifact catalog adopt
createNodeIdMinter({node, start?}) -> {next(kind? = 'id'), adopt(ids) -> ownSeen, current, node}
  // `${kind}-${node}-${n}`: namespaces disjoint by construction (node without '-');
  // adopt() rescans inherited state so a promoted/restarted node never re-issues a taken id
createArtifactHost({store: promotedFollower.store, storage: {open, adoptKey?}, ...})
  // adopt a promoted mirror's catalog: the artifact-N id line continues, adoptKey(artifact)
  // recovers private keys (content-hash version -> local byte cache).
  // Oracle: oracle/regression/artifact-adopt.spec.ts

// line descriptor — additive source hints on the wire
Observe.exposeStoreReplay(store, {describe: {schema: 'v2', originId: 'n1'}})   // serves remote.describe()
Replay.readReplayDescriptor(remote) -> Promise<object | null>                  // null on older servers
```
