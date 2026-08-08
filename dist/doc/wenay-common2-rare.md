# wenay-common2 — EXTENDED cheat sheet (notation)

> The full surface. For everyday helpers use **`wenay-common2.md`** (brief). Root import:
> `import { ... } from "wenay-common2"`. Notation: `name(args) -> ret  // note`. Short names are
> canonical. Removed old names are listed in `NAMING_RENAMES.md`.
> Installed-project Caddy HTTPS management → **[`HTTPS-CLI.md`](HTTPS-CLI.md)**. Public raw-IP/hostname
> demo, certificate issuance, router ports, and diagnostics → **[`DEMO-HTTPS.md`](DEMO-HTTPS.md)**.

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
installConsoleCallerAnnotations()                   // Node opt-in; installs wrappers once + enables clickable source links
enable(flag=true) / disable()                       // enable(true) also installs; false/disable keep transparent wrappers
  // imports never mutate console; first browser/attached-inspector install is a no-op; no uninstall by design
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
  //   (consumer picks policy 'queue'|'frame' at subscribe time); Store Replay V2 api.replay / Replicated Map api and
  //   exposeReplay(...) are internally branded replay-wire facades and receive the same frameLine projection.
  //   The gate subscribes upstream only while at least one frameLine consumer exists, and its 25ms default poll
  //   exists only while that active consumer is actually above highWater. The replay `line` stays ungated.
  // Application packets use the JSON-array wire. Date/Map/Set/RegExp/BigInt are projected through
  //   the established marker format; ArrayBuffer/DataView/TypedArray values remain native transport
  //   attachments. CAPS negotiates only compact subscription shapes, callback batching, the server->client
  //   authorization-state push (Caps.AUTH_STATE, opt.authState), the HELLO<->MAP correlation id
  //   (Caps.HELLO_ID, opt.helloId) and row-encoded record arrays (Caps.ROWS, opt.compactRows) — all
  //   default on.
  // opts.compactRows defaults on (Caps.ROWS). ONE bounded shape registry per connection replaces the
  //   per-cbId table, and an array of uniform plain-object records inside a result or a callback
  //   argument becomes {"$_t":[shapeId,rows,keys]} — key names once instead of once per record.
  //   A table always carries its own keys: a form that only referenced a previously declared shape
  //   desynchronizes the moment the receiver drops a packet it cannot use (a RESP for an abandoned
  //   request, a CB for a dead cbId), and it would have saved 63 B out of ~71 000. So the registry's
  //   contribution is the SHARED id space and the shared uniformity judgement, not a second wire
  //   form: a shape an array proved uniform lets the tick path skip the five-repeat threshold and go
  //   straight to Pkt.SHAPE. A table never writes the Pkt.SHAPE table, so no shape id — hostile or
  //   accidental — can make a table decode against another producer's key order.
  //   Encoded only from 4 records up, only when every element is a plain object with the same keys
  //   in the same ORDER (order is preserved end to end), and never when a value would change meaning
  //   by moving from an object into an array: JSON.stringify drops undefined/function/symbol from an
  //   object and writes null for them in an array, so such an array is refused rather than altered.
  //   Decoding is the one attacker-facing surface added: keys are re-validated (string, isSafeKey,
  //   unique, <= maxKeys), rows are counted against maxArrayLen, values keep the depth they would
  //   have had as {…}[], and a row whose width disagrees with its shape is REJECTED, never padded.
  //   Failures raise PayloadLimitError, which the existing sites already handle — a response rejects
  //   that one request, a callback packet is dropped — so nothing escapes as an unhandled error.
  //   Registry lifetime: it belongs to one server instance and dies with it, holds at most 64 shapes
  //   evicted least-recently-used, and its ids are monotonic and never reused; declaration is tracked
  //   per session, so a rebuilt session re-declares. The client's Pkt.SHAPE table is bounded at 256
  //   and cleared on every new server generation.
  // opts.callbackBatch defaults on for new peers: same-microtask callback packets are wrapped
  //   losslessly as Pkt.CB_BATCH (64 items / 64 KiB). RESP, errors and CB_END remain ordering barriers.
  // opts.requestBatch is the ONE negotiated bit that is OFF by default (Caps.REQ_BATCH). It moves the
  //   session's whole ordered stream — CALL/PIPE outbound, RESP/CB_END/CB inbound — into a SECOND
  //   envelope, Pkt.BATCH, with the same microtask flush and the same ceilings ({maxItems:64,maxBytes:65536}).
  //   Because a response then rides the same queue as the callbacks that preceded it, the RESP ordering
  //   barrier above is not merely skipped but unnecessary: order is carried by position in the batch.
  //   Requires callbackBatch (a single queue per session is what makes that true) and is effective only
  //   when BOTH peers advertise it; Pkt.BATCH is a distinct opcode precisely because today's Pkt.CB_BATCH
  //   validator accepts only CB/SHAPE/CBV and would drop an envelope carrying a response. Unchanged inside
  //   it: binary leaves stay direct sends, an oversize packet keeps one-packet semantics and cannot be
  //   overtaken, a one-item batch is never wrapped, the session id stays at index 5 of every item, a
  //   wait:false CALL still gets no RESP, and a consumer throwing on one item never discards its siblings.
  //   Off by default because it re-frames the request path and buys nothing where calls are issued one at
  //   a time — see experiments/rpc-perf-2026-07/RESULTS.md for the measured burst win and the null result
  //   on the isolated `small` family.
  // RETURNS { api, control } (createRpcServerAuto) / { control } (createRpcServer) — see the control facet
  //   below. Additive: callers that ignore the return are unchanged.
createRpcServer(opts)                               // lower-level core
createRpcServerAutoDetect(opts)                          // + legacy/v2 protocol auto-detection (createRpcServerAutoWithProtocolDetection)
createRpcServerInProc(...)                          // in-process fast path (no socket)
// authorization (in-band, Pkt.HELLO) — CANONICAL PAGE: doc/RPC-AUTH.md (rules + ✅/❌ pairs + limits)
opts.auth: RpcServerAuth = { resolveAuth: (token) => RpcAuthGrant | Promise<RpcAuthGrant>, gate?: boolean }
RpcAuthGrant = { object?: any, ack?: any, expiresAt?: number, renewBeforeMs?: number }
  // object  — principal facade to serve; ABSENT = keep the currently served object.
  // ack     — 5th element of Pkt.MAP; default {ok:true}. ack.ok === false is a rejection. When the grant
  //   declares a finite expiresAt the server attaches it under ONE reserved key: ack.$rpc = {expiresAt}
  //   (exported GRANT_FACTS_KEY = '$rpc', wire contract in rpc-protocol.ts). Attached on a COPY — a frozen
  //   or shared application ack is never mutated — and SKIPPED when the ack is not a plain object, already
  //   owns '$rpc' (the application wins) or the deadline is not finite. Optional by contract: the client
  //   reads it defensively (grantDeadline) and a missing/garbage value only means an event without one.
  // expiresAt — ABSOLUTE wall-clock ms. Infinity = no deadline; any OTHER non-finite value fails CLOSED
  //   (immediate downgrade — a caller's `Date.now() + undefined` must not grant an unlimited session).
  //   Waits are chunked at 2_147_483_647 ms re-reading Date.now(), so a >24.8-day deadline is not
  //   clamped to "already expired" and a forward clock jump costs at most one chunk of drift.
  // renewBeforeMs — 'expiring' lead time, default 30_000, clamped into [0, remaining].
  // gate:true — CALL/PIPE before a successful HELLO are rejected with MyError code 'E_UNAUTHORIZED'.
  //   It does NOT gate Pkt.STRICT: the constructor `object` is walked at construction and its schema
  //   answers any peer. Keep that object EMPTY — it is also the expiry/revocation fallback facade.
  // resolveAuth throw = TRANSIENT: principal, routeMap, authed and subscriptions are untouched, the
  //   caller's reauth() just resolves {ok:false,reason}. throw a value carrying `revoke: true`
  //   (Object.assign(new Error('...'), {revoke:true})) = the full downgrade corridor.
  // Downgrade corridor (HELLO success / expiry / revocation all share it): Pkt.AUTH state FIRST (so the
  //   client learns WHY before its streams end) -> rebuild dispatch -> teardown -> Pkt.MAP with
  //   authAck {ok:false,state,reason}. That ack rides every later MAP but is NOT sticky: a successful
  //   HELLO replaces it wholesale, including on a later STRICT-driven MAP.
// control facet — the application's own grip on THIS connection's principal (returned by both factories)
control.revoke(reason?: any) -> boolean · control.grant(grant: RpcAuthGrant) -> boolean
RpcServerControl = ReturnType<typeof createRpcServer>['control']   // for a Map<userId, RpcServerControl> registry
  // WHY: resolveAuth runs only on a HELLO, so `revoke: true` needs the CLIENT to ask. An admin action, a
  //   logout from another device or a fraud signal has no HELLO to ride on. `control` is commands inward
  //   over one connection's authorization — two members, one boundary, flat. Reads (api.subscriptions)
  //   stay where they were; nothing was moved or renamed.
  // revoke IS downgradePrincipal — no second downgrade path: Pkt.AUTH state first, then teardown of the
  //   Listen nodes the base facade no longer declares (RPC_STOP -> CB_END), then Pkt.MAP with
  //   authAck {ok:false,state:'revoked',reason}. Identical to expiry except the state NAME. It always
  //   clears the grant's timers, so a revoked short-lived token produces no later 'expiring'/'expired'.
  // grant IS the HELLO success path (applyGrant) with the correlation id omitted: same facade, ack,
  //   deadline and timers. Deliberately UNCORRELATED — it answers no HELLO, so it can never settle a
  //   pending reauth(), and for the same reason it emits no client-side 'renewed'.
  // false means ONLY 'this connection is detached' (socket+key taken over by a later server, or disposed):
  //   nothing was sent. It is never 'command rejected'.
  // Safe at any moment: before any HELLO (corridor runs on the base facade, nothing armed); twice in a row
  //   (deliberately NOT suppressed — a revocation after an expiry carries a DIFFERENT reason the client
  //   should hear, and the second pass drops nothing); after detach (returns false before touching state).
  // revokeEpoch: resolveAuth is AWAITED, so a grant that STARTED before an application revoke would
  //   otherwise resolve after it and silently restore the principal. Such a grant is dropped — but the
  //   HELLO still gets its answer (the current revocation ack, correlated with its id), so a reauth() in
  //   flight settles instead of hanging. Guards revocation only: two grants racing stay 'last one wins'.
  // Known edges: revoke on a server built WITHOUT auth still runs (its MAP grows 4 -> 5 elements for that
  //   peer — the one path where an auth-less server starts sending an authAck); grant accepts ANY object
  //   with no validation seam before the dispatch rebuild; repeated revoke re-sends Pkt.AUTH + MAP each
  //   time; a transport whose emit THROWS is not swallowed (same as every other send in the file).
hooks.onPrincipalChange?: (ctx: RpcPrincipalChange) => void
RpcPrincipalChange = { keep: ReadonlySet<object>, drop: ReadonlySet<object> }   // Listen node IDENTITIES
  // Teardown evidence is the DECLARED set LOSING a node (`drop`), not "absent from keep": a Listen inside
  //   a noStrict(...) subtree is resolved by string path at CALL time and never walked, so it is in NEITHER
  //   set and keeps its subscribers across every principal change (a routine renewal must not kill it).
  //   createRpcServerAuto consumes this hook (unsubscribeUnreachable) and still relays yours; each dropped
  //   subscriber gets rpcEndCallback (RPC_STOP -> CB_END) BEFORE losing the server subscription, so client
  //   consumers resolve instead of hanging. A source kept by another exposed node is never torn down.
createTokenCodec({secret, ttlMs? = 15*60_000, hmac?, now?}) -> {issue, verify}   // 'wenay-common2/server/auth' (or /server), node-only
  // issue<T extends IssueClaims>(claims: T, {ttlMs?}?) -> `v1.<base64url(payload)>.<base64url(hmac-sha256)>`
  //   `exp` and `jti` are MINTED, never accepted from the caller; throws only on caller error (empty `sub`).
  // verify(token: unknown) -> {ok:true, claims: TokenClaims} | {ok:false, reason: 'malformed'|'signature'|'expired'}
  //   NEVER throws (network garbage is traffic, not an exception); timing-safe mac compare; the version tag
  //   is inside the signed input, so a future v2 mac cannot be replayed as v1. Empty secret throws at construction.
  // Deliberate non-goals: no JWT / no `alg` header (that is the alg:none bug family), no key rotation,
  //   no revocation or deny list, no refresh flow, no identity provider. A short TTL is the only exit.
// clients
createRpcClientHub(opts) + rpc                      // multiplexing client hub: connect(token)/reauth(token)/onConnect/onDisconnect + connectListen/disconnectListen + authListen
  // hubOpts.token?: RpcTokenProvider = (req: RpcAuthRenewRequest) => string|null|undefined|Promise<...>
  //   ONE function for the whole token lifecycle; PROVIDING IT STARTS THE HUB (it raises its own socket with
  //   createSocket(null) — the application never calls connect()). Single-flight over the provider call: N
  //   triggers across N facade clients share ONE call, and the slot is released only after it settles.
  //   PRECEDENCE — an explicit token owns ONE connection wave, not every wave that follows:
  //     • connect(token)/setToken(token) win for the wave they raise (reason 'connect' returns the explicit
  //       token, the provider is not consulted). The wave is identified by connectCount, bumped once per
  //       accepted connection, so EVERY facade client of that wave gets it and no later wave can.
  //     • every LATER wave (transport reconnect on the same socket, server generation change) and every
  //       renewal trigger ('expiring'/'expired'/'revoked'/'unauthorized') go to the provider — a token that
  //       outlived its wave would be re-presented forever, including one the server already revoked, so
  //       every reconnect would start already refused.
  //     • reauth(token) claims NO wave: its own handshake is the HELLO it issues on the live socket, so a
  //       future connection inherits nothing from it.
  //     • a provider yielding nothing is not a downgrade — the facade client keeps the token already in
  //       force, which on the first wave IS the explicit one.
  // hub.authListen(cb) -> off: additive; cb gets RpcHubAuthEvent = RpcAuthEvent & {key} (which facade).
  //   Relayed even WITHOUT a provider — expiry is worth reporting to an application that renews by hand.
  // alias: hub.setToken->connect. onConnect/onDisconnect are legacy single-slot setters; the additive
  //   *Listen registries return per-listener off functions and cannot overwrite each other or internal recovery.
  //   A transient disconnect/reconnect of the SAME Socket.IO object keeps this client generation: after
  //   the new route/auth handshake, each active deduped logical Listen gets exactly one new physical attempt.
  //   Local consumers and their off handles survive; a consumer removed offline is not resurrected.
  //   connect()/setToken() hard-rotates the socket/client generation; close()/dispose() is terminal.
client members: func (proxy) · strict (schema-safe) · schema() · auth() · reauth() · onDisconnect()
                close(reason?, {socketAlive?}) · ready() · init(obj?) · api.subscriptions()
                onAuthState(cb) -> off · setTokenRenew(fn|null)
  // createRpcClient opts.token — presented via Pkt.HELLO in initStrict() (never in the socket handshake).
  //   In-band auth assumes ONE logical client per socket+key (the hub model): two token clients on one
  //   socket would wipe each other's routeCache/authAck on a principal change.
  // auth() -> current authAck; null = server WITHOUT auth (5-element MAP with authAck null). During an
  //   in-flight HELLO it waits for the FRESH ack, not the stale one. After dispose it resolves immediately.
  //   A client that presented NO token never gets an authAck at all (it sends only Pkt.STRICT and a gated
  //   server answers a 4-element MAP), so auth() answers LOCALLY with
  //   {ok:false, reason:'RPC client presented no token'} instead of hanging. It invents no server state:
  //   from a client that never asked, a gated server and a server without auth are indistinguishable, so
  //   the answer names the LOCAL cause. Guarded by authToken == null && !authPending && authStatus
  //   undefined, so a token-bearing client (or one with a HELLO outstanding) is still answered only by its
  //   own ack — a STRICT companion can never resolve a pending HELLO with a premature null.
  // reauth(token) -> soft re-auth on the LIVE socket: subscriptions are not broken (same socket, same
  //   cb-ids); the server re-verifies and sends the new principal's MAP + authAck. Each reauth() settles
  //   on the answer to its OWN HELLO (Caps.HELLO_ID), so an unsolicited downgrade MAP never resolves it
  //   with a stale ack. WARNING: still never run concurrent reauths — the server keeps ONE principal per
  //   socket+key, so racing tokens end in whichever HELLO it resolved last; wait for each. To change
  //   stream VISIBILITY on the client, reconnect (connect/setToken), not reauth.
  // onAuthState(cb) -> off (callable + thenable, awaits client teardown). Silent unless Caps.AUTH_STATE is
  //   negotiated. RpcAuthEvent = Omit<RpcAuthNotice,'state'> & {state: tAuthEventState};
  //   tAuthEventState = tAuthState | 'renewFailed' | 'renewed'. Both extra states are LOCAL and never travel
  //   on the wire — one stream covers wire facts and silent local ones.
  //   'renewFailed' — an installed renewer produced nothing, or the token already in force.
  //   'renewed'     — an AUTOMATIC renewal got an ack that is not {ok:false}; carries expiresAt when the
  //     new grant declared one (read from ack.$rpc.expiresAt, defensively: absent key/garbage -> the event
  //     WITHOUT expiresAt, never no event).
  //   BOUNDARY (deliberate): this stream reports what happens WITHOUT being asked. A manual reauth() emits
  //     NOTHING — it resolves with that very ack, deadline included, so an event would duplicate an answer
  //     its caller already holds. An application control.grant emits nothing either: it reaches the client
  //     as an unsolicited authAck-bearing MAP, not through the renewal seam. Widening later is additive.
  // setTokenRenew(renew: RpcTokenRenew | null) — the renewal seam the hub installs its provider into.
  //   RpcTokenRenew = (req: RpcAuthRenewRequest) => any; RpcAuthRenewRequest = {reason, notice?} with
  //   reason 'connect' (before a fresh HELLO) | 'notice' (a Pkt.AUTH push) | 'unauthorized' (a rejected call).
  //   Client-level single-flight over the whole renewal action. Same-token guard: re-presenting the token
  //   already in force is NOT a renewal (it would drive an endless expire->renew->expire loop) and reports
  //   'renewFailed'. Without a renewer the client never renews and never retries — previous behavior.
  // Unauthorized retry: an E_UNAUTHORIZED rejection is retried EXACTLY ONCE after the renewed principal is
  //   presented. "Once" is structural, not a counter (the retry is issued without the flag), and the retry
  //   lives INSIDE the call attempt so the caller keeps ONE promise (a derived .catch promise would be
  //   invisible to transport-generation abandonment and could crash Node on a drop). NEVER retried:
  //   wait==false (space/fire-and-forget — no reply channel), any call whose args carried a callback (the
  //   RESP already released those ids), PIPE (opaque chain, steps may carry callbacks) and Listen attempts.
  // init()/ready(): the handshake guard runs FIRST, so the documented sequential pattern (hub handshake,
  //   then the application's own ready()) mints ONE token and sends ONE HELLO per connection — the renewal
  //   is skipped entirely when the schema is already known and the presented token acknowledged, and is
  //   re-checked after a renewal (a renewal on a live socket presents the token itself). A genuine re-init
  //   after a transport drop or a server generation change still runs in full. Two CONCURRENT init() calls
  //   still send two HELLOs (both see the same "not handshaked" state); the provider is not consulted twice
  //   even then. Without a renewer the behavior is byte-for-byte as before.
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
RESERVED_MARKER_KEYS · reservedMarkerKeyOf(value)
  // The reserved key space: a plain object whose SINGLE key is $_d/$_m/$_s/$_r/$_b/$_f/$_t is the
  // codec's value, not the application's. Full contract under "RPC application wire" below.
RpcLimits (opt, per server/client): maxDepth 32 · maxKeys 1000 · maxArgs 64 · maxArrayLen 10k
  · maxStringLen 1M · maxCallbacks 100 · maxPathLen 16 · maxBinaryLen 8MB (bytes per binary leaf)
  // Server inputs and client results/callbacks are checked at the JSON application boundary.
// modes: func (proxy) · strict (schema-safe) · pipe (whole chain in one packet) · space (fire-and-forget)
// legacy (oldCommonsServer.ts, @deprecated forwarders onto oldCommonsServerMini — identical wire):
//   funcPromiseServer->promiseServer · funcForWebSocket->wsWrapper · funcScreenerClient2->createClientProxy
//   CreatAPIFacadeServerOld->createAPIFacadeServer ; CreatAPIFacadeClientOld & funcPromiseServer2 kept as-is
```

### RPC application wire

CALL, RESP, PIPE, callback, error and control packets use backward-readable JSON arrays.
Date, Map, Set, RegExp and BigInt use the `rpc-walk` marker projection. ArrayBuffer and
ArrayBufferView values remain native transport attachments, so large media/data leaves are not
expanded into JSON number dictionaries. CAPS negotiates COMPACT, CB_BATCH, AUTH_STATE, HELLO_ID,
REQ_BATCH and ROWS.

#### Reserved keys — the one contract an application must respect

The marker projection is a **reserved key space**, and it is the only place where application
data can be mistaken for the codec's own types. The rule is exact:

> A **plain object whose single own key** is one of `$_d` `$_m` `$_s` `$_r` `$_b` `$_f` `$_t`
> belongs to the codec. An application must not produce one.

| Key | Payload the codec accepts | Restored as | Where |
|---|---|---|---|
| `$_d` | a number, or `null` (an Invalid Date) | `Date` | args, results, callbacks |
| `$_m` | an array of `[key, value]` pairs | `Map` | args, results, callbacks |
| `$_s` | an array | `Set` | args, results, callbacks |
| `$_r` | `{source: string, flags: string}` that `new RegExp` accepts | `RegExp` | args, results, callbacks |
| `$_b` | a string of `-?[0-9]+` | `BigInt` | args, results, callbacks |
| `$_f` | a finite number | a **callback handle** bound to that id | arguments only |
| `$_t` | `[shapeId ≥ 0, rows[], keys[]]` | the record array of a row table | results and callbacks, and only when `Caps.ROWS` is negotiated |

Anything else under one of those keys is **not** the codec's and comes back as the ordinary
object the wire carried — recognition is exactly as narrow as the payload each serializer
emits, so `{"$_b": "hello"}`, `{"$_m": 5}` or `{"$_r": 5}` survive as objects instead of
throwing out of the decoder or turning into a wrong value. `$_f` is the one exception: a
non-numeric id is a forged callback and still raises `PayloadLimitError`.

To stay safe an application needs one of these, and nothing else works:

- give the object a **second key** — `{"$_d": 5, name: "x"}` round-trips untouched, and always did;
- do not use these keys at all.

Nesting does **not** help: the walker reaches every level, so `{value: {"$_d": 5}}` still has a
reserved object inside it. `RESERVED_MARKER_KEYS` and `reservedMarkerKeyOf(value)` are exported
from the package for applications that want to assert this on their own data.

Two further consequences of the codec stopping at a reserved key, symmetric on both sides:
the payload under such a key is **not walked**, so a `Date`/`Map`/`Set`/`RegExp`/`BigInt`
nested inside it is not marked on the way out and does not come back; and the
`__proto__`/`constructor`/`prototype` key filter is not applied inside it either.

There is no escaping and no negotiation: escaping a colliding object would change the bytes,
would therefore need its own capability bit, and against a peer without the bit it replaces one
silent corruption with a different one. What exists instead is **encode-side detection**, which
is the only side where the question is decidable — going out, a plain object under a reserved
key is by construction not one of ours, while coming in the two are indistinguishable. With
`debug: true` on `createRpcServer`/`createRpcServerAuto`, or `client.api.log(true)`, every
outgoing collision is reported as `[RPC OUT] reserved key $_x …`. With debug off the check costs
one register test on a branch only colliding values enter.

#### Row encoding (`Caps.ROWS`)

`Caps.ROWS` (`opt.compactRows`, default **on**) adds one value marker and no opcode: an array of
uniform plain-object records becomes `{"$_t": [shapeId, rows, keys]}` wherever a result or callback
argument is packed. `$_t` is deliberately NOT in the walker's marker set, so a peer without the bit
recurses into such an object exactly as before and its wire is unchanged down to the byte. Shape ids
come from one bounded per-connection registry shared with the `Pkt.SHAPE`/`Pkt.CBV` tick path, which
is what lets a shape an array proved uniform skip the tick threshold — but a table always carries its
own keys and never writes the tick table, so the two directions share a judgement, not a decoder
state. Measured on `large`: 127 912 → 70 983 B per 1000-record call, −44.5 %, with `small`, `ticks`,
`flood` and `burst` byte-identical.

#### Batch envelopes

There are two batch envelopes and they never share a queue. `Pkt.CB_BATCH` (`Caps.CB_BATCH`, default
on) carries live `CB`/`SHAPE`/`CBV`. `Pkt.BATCH` (`Caps.REQ_BATCH`, `opt.requestBatch`, default
**off**) carries a whole session's ordered application stream: `CALL`/`PIPE` outbound,
`RESP`/`CB_END`/`CB` inbound. It is a distinct opcode on purpose — the shipped `Pkt.CB_BATCH`
validator accepts only `CB`/`SHAPE`/`CBV` and would silently drop an envelope carrying a response,
whereas an unknown opcode falls through every existing switch on both sides. Each item keeps its own
session id at index 5, so unwrapping the envelope yields exactly the packets separate frames would
have delivered, in the same order. That is also why the response ordering barrier disappears when the
bit is negotiated rather than merely being skipped: order is carried by position in the batch.

### RPC authorization wire

> Canonical page with rules, ✅/❌ pairs and the documented limits: **[`RPC-AUTH.md`](RPC-AUTH.md)**.

Authorization is in-band. The client sends `[Pkt.HELLO, token, id?]` before `Pkt.STRICT`; the server
verifies it, optionally replaces the served object with that principal's facade, and answers a
**five**-element `Pkt.MAP` whose 5th element is `authAck`. A server configured without `auth` still
answers HELLO with a five-element MAP carrying `authAck = null`, so a token-bearing client can tell
a HELLO reply from a plain four-element STRICT reply instead of hanging. Old peers never send HELLO
and see the previous wire byte-for-byte.

Token lifetime is pushed back as `[Pkt.AUTH, {state, reason?, expiresAt?}]` with
`tAuthState = 'expiring' | 'expired' | 'revoked'`, negotiated by `Caps.AUTH_STATE = 1 << 2`
(`RpcOpt.authState`, default on). It is deliberately a **control packet and not a Listen node**: such
a node would live inside the principal's facade and vanish exactly when the state has to be reported.
The push is per socket+key, not per session — any negotiated peer on that key enables it — and it is
emitted as a broadcast, so a raw co-tenant peer on the same socket+key sees the bytes. That is not a
disclosure: authorization is per socket+key by construction (one `authAck`, one principal, one
`authed` flag), and unknown opcodes are ignored by construction. Anonymous (uncorrelated) `Pkt.CAPS`
therefore keeps `AUTH_STATE` alongside `COMPACT`, while `CB_BATCH` stays excluded — a control packet
about this connection's authorization is not a re-framing of another client's callback packets.

A HELLO is correlated with the MAP that answers it (`Caps.HELLO_ID = 1 << 3`, `RpcOpt.helloId`,
default on): the client puts an id in HELLO's 3rd element and the server echoes it in the answering
MAP's 6th. Only a reply carries one, so an **unsolicited** MAP — a STRICT push or an expiry/revocation
downgrade — can never settle a pending `reauth()` with a stale `{ok: false, state: 'expired'}`.
No id in, no id out: an uncorrelated peer sees the previous wire byte-for-byte, and there the next
authAck-bearing MAP answers the oldest outstanding HELLO, exactly as before. Still do not run
concurrent `reauth()`s: correlation guarantees each one sees its own answer, but the server keeps
ONE principal per socket+key, so racing tokens end in whichever HELLO the server resolved last.

The grant's **deadline** rides inside the existing 5th element rather than a new one. `authAck` is the
application's value — any shape, read field by field by its own consumers — so the server's own facts
about the grant go under ONE `$`-prefixed reserved key, `ack.$rpc = {expiresAt}` (exported as
`GRANT_FACTS_KEY`; an application ack does not carry `$rpc` by accident, and one namespace covers
every future server-attached grant fact instead of N loose ones). It is attached on a **copy**, so a
frozen or shared ack is never mutated, and it is skipped entirely when the ack is not a plain object,
when the ack already owns `$rpc` (the application wins) or when the deadline is not finite (`Infinity`
would travel as `null`). Hence optional by contract: the client reads it defensively and a
missing/garbage value yields a `'renewed'` event *without* `expiresAt` rather than no event. **No wire
change** — `rpc-protocol.ts` gained the key constant, not a packet or a Caps bit.

Server-driven revocation adds no wire vocabulary either: `control.revoke` reuses the downgrade
corridor verbatim and `control.grant` reuses the HELLO success path with the correlation id omitted,
so an application grant is deliberately an *unsolicited* authAck-bearing MAP (it answers no HELLO and
can settle no pending `reauth()`).

### HTTP facade server: static GET/POST mirror

`createHttpFacadeServer` is exported from `wenay-common2/server/http` and the compatibility
`wenay-common2/server` facade. It receives a caller-owned Express app and
walks the supplied object once at server setup. Every nested enumerable string-keyed function becomes a route whose
URL segments match its object path:

```ts
import express from 'express'
import {createHttpFacadeServer} from 'wenay-common2/server/http'

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
getStats().execution: 'main'|'worker'|'audio-worklet'|'media-recorder'
```
Audio source:
- default `mode:'pcm'`, `format:'int16'`, raw PCM payload; uses `AudioWorklet` when available and falls back to `ScriptProcessor` only when the browser cannot run a worklet.
- AudioWorklet's 128-sample render quanta are aggregated into `packetMs` (default 20ms) PCM frames
  before Listen/RPC publication, reducing packet and playback-node pressure without changing samples.
- `mode:'record'` uses `MediaRecorder` chunks (`webm-opus`) for record/upload flows, not live STT.
- `getStats().rms` gives a VU-meter signal; permission denied/no device returns typed state, not a thrown public failure.

Video source:
- default snapshots, not a 30fps video stream: JPEG, `fps` default 3, `quality` default 0.82; `fps:0` runs an unpaced capture-after-encode pump for throughput measurement.
- each frame carries absolute image bytes, so `replay:true` can safely keep the latest frame for lag recovery.
- capture is hidden-tab-proof by default (Chrome throttles hidden tabs three ways, each stage has its own escape): the tick comes from a Blob-worker timer (in-page `setInterval` drops to ~1/s), the frame comes from `ImageCapture.grabFrame()` when available (a hidden `<video>` stops painting; `<video>->canvas` stays as the fallback), and JPEG encode runs in a worker over a transferred `ImageBitmap`, returning a transferred `ArrayBuffer` — never a structured-cloned frame (main-thread `convertToBlob` is gated to ~1s per call when hidden). Worker use is capability-selected and enabled by default; CSP/missing APIs fall back to main. `worker:false` opts out of all three into the plain in-page path.
- one explicit dimension (`width` or `height`) scales the other proportionally from the track resolution, downscale-only; pass both to force an exact size. `grabFrame`'s ~50ms serial latency caps the pipeline around ~15-20fps regardless of `fps`.

Viewer helpers (`media-view`): the consumer side of any media line (local pair or RPC surface).
- `attachVideoCanvas(line, canvas, {createBitmap?, onError?})` — per-frame codec/size come from the 40-byte header, canvas resizes to follow; decode overload is busy-skipped (keep-latest, `stats().frames` vs `stats().drawn` shows the gap); `createBitmap` injects a custom decoder (tests, OffscreenCanvas pipelines).
- `attachAudioPlayer(line, {minBufferSec? = 0.08, maxBacklogSec? = 0.35, audioContext?, onError?})` — pcm16/float32 through a sequential playhead. A still-future playhead remains contiguous even when its headroom drops below `minBufferSec`; only a real underrun rebuilds the jitter buffer (`stats().underruns`). A backlog past `maxBacklogSec` is dropped and rebased (`stats().dropped`). `enable()` must come from a user gesture (browser autoplay rules); `audioContext` injects a factory for tests/custom routing.
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

Per-peer route facade:
```ts
Media.createMediaRoute<Z>({
    self, peer,
    mode?: 'relay'|'direct'|'best',             // default relay
    connect: (pair, kind) => RouteConnector<Z>,
    policy?, shadow?, catchUpTimeoutMs?,
    directRetryMs?: number|false,               // best default 5000
}) -> {
    control: {start, setMode, reconsider, close},
    resource: {line},
    events: {changed},
    view: {status, mode, route, metrics},
}
```
- `relay` creates only the server connector. `direct` opens no relay data connector and never emits
  relay-delivered frames; a failed promotion leaves `view.route()` null. WebRTC signaling may still
  ride the existing server control channel.
- `best` exposes relay immediately, promotes direct after replay catch-up, falls back through the
  same `resource.line`, and retries transport failures. Policy denial is not retried.
- Connectors are the existing route contract. `createWebRtcConnector` supplies the ordered binary
  DataChannel direct path and the application supplies its relay connector. Server policy remains
  authoritative through `RoutePolicy`; `mustShadowRelay` retains an audit copy.
- Capture and routing are separate because one camera/microphone source may have several viewers
  with different routes. The old source-level `transport` option is deprecated and only `'socket'`
  starts; it is not a hidden per-peer selector.

Encoding choices:
- current replay payloads use PCM16/float32 or MediaRecorder Opus for audio and independent
  JPEG/PNG/WebP images for video;
- native WebRTC tracks negotiate browser RTP codecs (commonly Opus plus VP8/VP9/H.264/AV1);
- WebCodecs can produce Opus/AAC and VP8/VP9/H.264/H.265/AV1 where
  `AudioEncoder.isConfigSupported`/`VideoEncoder.isConfigSupported` confirms support, but inter-frame
  video needs a versioned chunk contract carrying keyframe, decoder config, timestamp and duration.
  Those chunks must not be disguised as the current independent-image frame format.

Oracles: `npx tsx replay/media-socket.test.ts` checks header decode, worker selection, plain Listen
shape, `replay:true`, typed no-device state in Node, and real Socket.IO binary delivery;
`npx tsx replay/media-route.test.ts` checks all three route modes, fallback, retry, and strict direct.

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
> Focused Node entrypoints: `wenay-common2/server/fs`, `/server/auth`, `/server/http`, and
> `/server/webhook`; `wenay-common2/server` remains the compatibility facade.

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
- `listenStorePatches(store)` is the public settled source behind push: one absolute patch array per natural Store drain. A bounded `patchesBatch` transport may split that source array.
- Store-owned Replay privately refines safe array-slot replacement/growth facts to exact index patches in the same physical drain envelope. Public `changedPaths`/`listenStorePatches` retain the whole-array boundary. An observed `length` mutation or whole-array property replacement falls back to one complete-array patch; injected `patchSource` and Replicated Map retain their declared source semantics.
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
> Public surface: the replay sections below; executable behavior: `replay/` oracles importing the canonical `src/` modules.
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
exposeReplay(replay)  <->  replaySubscribe(remote, cb, {since?, onSeq?, staleMs?, onStale?, skewMs?, now?, policy?, hint?, catchUp?, gapPolicy?, prepareCatchUp?, recoverGap?}) -> off   // wire pair over the EXISTING rpc: line = plain Listen, since/keyframe/frame = plain methods
  // NORMAL PATH: createRpcServerAuto exposes replay listens automatically (see rpc section) — exposeReplay stays
  //   as the manual/custom-transport path. replaySubscribe prefers `frame` when the server has it (one round trip,
  //   server picks tail/mini-frame/keyframe; sacred throw -> onError), uses since/keyframe when frame is unavailable.
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
  // prepareCatchUp({initial,since,signal}) is an advanced async identity/bootstrap gate. {reset:true} requests a
  //   fresh keyframe; {since,ts?} declares an external snapshot already applied while the live line was queued.
  //   recoverGap receives the same AbortSignal after a missing tail and, with catchUp:'tail', may install a bounded
  //   replacement {since,ts?} before keyframe/error fallback. Hooks must stop external mutation when signal aborts.
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
followReplicatedMap(remote, {delivery?, checkpoint?, onBatch?, onStatus?, staleMs?, ...}) -> followed map
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
  // RECONNECT: descriptor/lineId is re-read before catch-up. Lossless requires a Replicated Map descriptor.
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
exposeStoreReplay(store, {maxItems?, maxBytes?, maxDelayMs?, patchSource?, ...})  <->  syncStoreReplay(mirror, remote, {validateBatch?, onBatch?, ...}) // layer B: V2 patch batches; keyframe = root patch
  // StoreReplayPatchSource = {on(cb: (patches: readonly StorePatch[]) => void) -> off}.
  // api.replay is the sole V2 surface. There is no optional capability, legacy line or fallback coordinate.
  //   A Store-owned source may turn safe same-drain array slot replacements into exact index patches before
  //   sampling. Structural length changes and whole-array replacement preserve the complete-array fallback.
  //   validateBatch(patches, mirror) runs after decode and before ANY Store mutation. Throwing is terminal, reports
  //   onError and leaves seq unchanged. onBatch runs after one physical envelope is applied; its throw is also terminal
  //   and leaves seq unchanged, but does not roll the already-applied Store state back.
  //   patchSource is an advanced absolute-fact feed: Store state must already reflect its complete emitted patch array.
  //   Application code sees StorePatch objects. V2 uses flat [key,value]/[key] set/delete tuples
  //   and [path,value]/[path] for nested/root patches. The direct api.replay facade is the V2 wire:
  //   there are no numbered generation members below it.
  //   Store V2 travels through the JSON-array RPC lane without another Store codec.
  //   A natural Store drain enters as one source array. maxItems/maxBytes may split it into several physical envelopes;
  //   maxDelayMs>0 may merge adjacent source arrays. onBatch is once per resulting envelope, not per original drain.
  //   Batch frame flattens retained envelopes, keeps the last state-changing patch per exact path, and preserves
  //   delete -> recreate ordering.
  //   {maxItems:256,maxBytes:65536,maxDelayMs:0} defaults: maxItems is hard. Before publication maxBytes is
  //   checked on the complete V2 JSON-array envelope, including full UTF-8 and binary attachments. One indivisible
  //   patch may exceed the configured target. Invalid values fail before the V2 journal/head/fan-out.
  //   maxDelayMs:0
  //   preserves the natural drain with no extra latency. Set maxDelayMs>0 only to combine adjacent drain windows.
  //   replay/batchStats/flushPending stay local for inspection. Journal precommit is before head/fan-out;
  //   failed compact chunks and a non-transactional adapter's uncommitted suffix remain retryable without duplicates.
  //   Oracles: replay/store-replay-batch.test.ts and replay/store-replay-batch-socket.test.ts.
createStoreReplayView(store, {
  keys, lineId?, describe?, patchSource?,
  history?, maxItems?, maxBytes?, maxDelayMs?,
  snapshot?: {chunkBytes?, windowBytes?, maxItems?, maxSessions?, ttlMs?}
}) -> {
  resource: {describe, replay, snapshot: {open, read, close}},
  events: {replay},
  view: {lineId, selectionId, keys(), stats()},
  close
}
syncStoreReplayView(mirror, remote, {
  cursor?: {lineId,selectionId,seq}, snapshotWindowBytes?, snapshotRetries?,
  onSnapshotProgress?, validateBatch?, onBatch?, ...ReplaySubscribeOpts
}) -> off & {ready, mode, viewMode, seq(), cursor(), isStale(), lastTs()}
  // VIEW SHAPE: V1 is a static, server-authorized set of top-level string keys. It is not a
  //   remotely supplied predicate and it exposes no write methods. Changing authorization/keys creates another
  //   view/lineId. Reuse one view instance for clients with the same selection. All views of one Store share
  //   one exact-path watcher; each changed value is detached once for the union of interested views, after
  //   unselected dirty paths have been discarded. A simultaneously exposed full Replay keeps its own full feed.
  // COST: a view materializes no child Store and retains no full selected snapshot. It owns a normalized Set,
  //   one filtered V2 journal and bounded active cursor state. An unselected patch is one Set lookup and creates
  //   no view event/seq/wire fan-out. Root replacement is projected to selected set/delete facts.
  // SNAPSHOT: open captures the view head. read sends ordinary V2 patch batches through callback packets, yields
  //   a macrotask between chunks, and returns only after one configured byte window. That response is cumulative
  //   credit for the next window; there is no ACK per chunk and no unbounded Socket.IO enqueue. Plain JSON/binary
  //   patch sizes are counted directly without building a disposable packed graph, JSON string or UTF-8 buffer;
  //   rich/custom values fall back to the canonical RPC metric.
  // ATOMICITY: the client assembles callback chunks into an owned, non-reactive root. The visible Store remains
  //   unchanged until the final response, then receives one root replacement. replaySubscribe attached the live
  //   line first; tail > baseSeq closes the fuzzy key-by-key scan race. History eviction discards the scratch
  //   root and retries (default 3) instead of exposing a partial snapshot.
  // CURSOR: persist lineId, selectionId and seq together through sync.cursor(). Same-line/same-selection
  //   reconnect uses the cheap V2 tail without opening a snapshot. A different line or authorization
  //   selection forces a bounded fresh snapshot and removes keys no longer selected.
  // LIMITS: defaults are 512 KiB chunk, 1 MiB window, 256 patches/chunk, 32 sessions and 30 s TTL. The server
  //   clamps a client's requested window. One top-level value remains indivisible and may exceed the target;
  //   large strings/blobs/media belong in Bytestream/storage resources. General cyclic graph fragmentation is
  //   deliberately not smuggled into Store Replay V2.
  // COMPATIBILITY: resource.replay remains the ordinary V2 facade, so an older client can still use its
  //   monolithic keyframe. The bounded path is syncStoreReplayView. A frameLine gate that loses all retained
  //   history may still build the selected monolithic keyframe for an old/slow recovery; size the view history
  //   for the expected live lag until gate-aware snapshot windows become a transport capability.
  // Oracles: replay/store-replay-view.test.ts, replay/store-replay-view-socket.test.ts and
  //   replay/replay-external-snapshot.test.ts.
syncStoreReplayRoute(mirror, remote, {validateBatch?, onBatch?, ...}) -> off & {ready, switch(nextRemote, opts), seq(), label(), active(), mode}
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
  // Only replayMode:'v2' coordinates resume; older persisted coordinates reset by keyframe.
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
  // keyOf (@deprecated — declare `frame` on the LINE instead; held-map path kept working for generic replay calls):
  //   while lagged keep the LAST envelope per key, drain -> tail of those (ascending seq) instead of a full keyframe;
  //   events must be ABSOLUTE per key; keyOf -> null or over maxKeys (1024) degrades to keyframe recovery
ReplayStorage = {putEvent, putEvents?, putKeyframe, getKeyframe({seq?|ts?}?) -> ReplayEvent | undefined, getEvents(from, to)}   // layer C: putEvents is atomic all-or-throw; createMemoryReplayStorage(caps?) = reference impl
archiveReplay(replay, {storage, everyEvents? = 64, everyMs?}) -> {close, stats}          // event log + keyframe cadence (every N events OR T ms of line-ts, whichever first; frames only ON events)
openHistory(storage, live?) -> {at({seq?|ts?}?), subscribe(cb, {since?|ts?, onSeq?}) -> off}   // seek + playback, SAME subscriber interface; with live: archive -> live journal -> live handover
  // seamless rewind->live: create the line with getSince reading the same storage («memory outside»); else the gap closes with a keyframe jump (still consistent)
storeReplayAt(storage, {seq?|ts?}?) -> snapshot | undefined                              // store time machine over archived V2 patch batches
```

### Store Replay V2 wire

The `api.replay` member is the sole V2 facade. Its envelope is
`[2, seq, ts, patches]`; flat `[key,value]` / `[key]` tuples represent top-level set/delete,
and `[path,value]` / `[path]` represent nested or root patches. Application code still receives
ordinary `StorePatch` values.

The JSON-array RPC lane transports the logical V2 value without a second Store-specific codec or
numbered batch member or legacy fallback. `createRpcServerAuto({replayOpts:{highWater,...}})` recognizes
this facade by internal identity and projects `frameLine`; a consumer selecting `policy:'frame'` therefore
stops adding V2 updates to its Socket.IO queue above highWater and recovers by `frame(lastSent)` after drain.
Merely connecting or receiving the RPC schema creates no upstream replay subscription and no polling timer.

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
