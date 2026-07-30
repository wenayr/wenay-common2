# RPC authorization — canonical page

> Read this before writing any RPC auth code. The full RPC guide is [`../rpc.md`](../rpc.md);
> the public surface lists are [`wenay-common2.md`](wenay-common2.md) (brief) and
> [`wenay-common2-rare.md`](wenay-common2-rare.md) (extended). Boundary: this library guarantees
> the transport contract. Identity — passwords, OAuth/OIDC, user stores, policy — lives above it
> ([`INTENT.md`](INTENT.md)).

Authorization is **in-band**: the client presents a token in `Pkt.HELLO`, the server verifies it and
replaces the served object with a facade built for that principal, then answers `Pkt.MAP` whose 5th
element is `authAck`. Token lifetime, expiry and revocation are pushed back as `Pkt.AUTH`.

Three moving parts:

| where | what |
| --- | --- |
| server | `auth: {resolveAuth, gate}` on `createRpcServerAuto` / `createRpcServer`, plus the `control` facet they return (`revoke` / `grant`) |
| wire | `Pkt.HELLO` → `Pkt.MAP` + `authAck` (correlated by `Caps.HELLO_ID`); `Pkt.AUTH` push, negotiated by `Caps.AUTH_STATE` |
| client | `token` option, `auth()`, `reauth()`, `onAuthState()`, `setTokenRenew()`; hub `hubOpts.token` + `authListen()` |

The server attaches the grant's deadline to `authAck` under one reserved key — `ack.$rpc.expiresAt`
— so the renewing side learns when the current token dies without the application inventing a field
for it (Rule 4).

---

## Rule 1 — empty initial facade **and** `gate: true`

These are two different protections and you need both.

`gate: true` rejects `CALL`/`PIPE` before a successful HELLO with a machine-readable
`MyError('Unauthorized', 'E_UNAUTHORIZED')`. It does **not** gate `Pkt.STRICT`: the constructor
`object` is walked at construction and its schema answers any peer that asks for it. Whatever you
leave in `object` is public.

The same object is also the downgrade target: on expiry or revocation the server re-applies it. So
it is exactly your anonymous surface — nothing more.

❌ **Wrong** — the protected surface is the constructor object:

```ts
createRpcServerAuto({
    socket, socketKey: 'main',
    object: {admin: {deleteUser: (id: string) => db.delete(id)}},   // schema leaks before HELLO
    auth: {resolveAuth},                                            // no gate: also CALLABLE before HELLO
})
```

✅ **Right** — the protected surface is the facade `resolveAuth` returns:

```ts
createRpcServerAuto({
    socket, socketKey: 'main',
    object: {},                    // served to a pre-HELLO STRICT, and re-applied on downgrade
    auth: {
        gate: true,                // CALL/PIPE before a successful HELLO -> E_UNAUTHORIZED
        resolveAuth(token) {
            const claims = verifyToken(token)      // throws -> rejection
            return {object: facadeFor(claims), ack: {ok: true, sub: claims.sub}}
        },
    },
})
```

The client reads the rejection by code, never by message:

```ts
await api.func.anything().catch((e) => e.code)   // 'E_UNAUTHORIZED'
```

---

## Rule 2 — the token travels in HELLO, never in the socket handshake query

A query string is copied into server access logs, proxy logs and `Referer`. The RPC token never
needs to be there: `createRpcClient({token})` emits `[Pkt.HELLO, token]` before `Pkt.STRICT`, and
`reauth(token)` re-presents it on the live socket.

❌ **Wrong** — credentials in the URL:

```ts
const hub = createRpcClientHub(
    (token) => io(url, {transports: ['websocket'], query: token ? {token} : {}}),
    (rpc) => ({main: rpc<Api>()}),
)
```

✅ **Right** — the socket factory knows nothing about the token:

```ts
const hub = createRpcClientHub(
    () => io(url, {transports: ['websocket']}),
    (rpc) => ({main: rpc<Api>()}),
    {token: async () => (await fetch('/session/token', {credentials: 'include'})).text()},
)
```

With `hubOpts.token` the hub starts itself (`connect()` is never called by the application) and
raises its first socket with `null`, so the handshake could not carry a token even if you wanted it
to — the token arrives in HELLO once the provider answers. Without a provider, `hub.connect(token)`
still passes the token to `createSocket` for socket-level needs; using it for RPC auth is redundant
and leaky.

---

## Rule 3 — one facade per principal, not `if (role)` inside every method

A method absent from the schema is stronger than a method that checks: it is never indexed into
`routeMap`, so there is no route to it, and the string-path fallback finds a non-function and
rejects with `Not a function`. A check inside the body is one edit away from being wrong, and it
tells every client that the method exists.

❌ **Wrong** — one facade, per-call checks:

```ts
const facade = {
    admin: {
        deleteUser: (id: string) => {
            if (!currentUser.roles.includes('admin')) throw new Error('forbidden')
            return db.delete(id)
        },
    },
}
```

✅ **Right** — build the facade from the claims, prune with the `role` idiom:

```ts
function facadeFor(claims: TokenClaims) {
    const role = (...roles: string[]) => roles.some((r) => hasRole(claims, r)) ? true : null
    return {
        ping: () => 'pong',
        admin: {
            deleteUser: role('admin') && ((id: string) => db.delete(id)),
        },
    }
}
```

A pruned member is `null`. It serializes into the schema as `'null'`, so
`api.strict.admin?.deleteUser?.(id)` short-circuits to `undefined` without a packet, and a forged
string-path CALL is rejected server-side. `resolveAuth` returns that facade as `object`, and the
server rebuilds `routeMap`, the schema and the Listen declarations for it in one corridor.

---

## Rule 4 — short TTL plus a provider

A token with no deadline never warns and never renews; the only exit is a reconnect. Declare
`expiresAt` on the grant and install one token provider on the hub. Everything between them is
mechanism you do not write.

❌ **Wrong** — unbounded grant, nothing to renew it:

```ts
resolveAuth: (token) => ({object: facadeFor(verify(token)), ack: {ok: true}})   // no expiresAt
// ...and a hub with no provider: the client never renews and never retries
const hub = createRpcClientHub(() => io(url), (rpc) => ({main: rpc<Api>()}))
```

✅ **Right** — server side:

```ts
import {createTokenCodec} from 'wenay-common2/server'

const codec = createTokenCodec({secret: process.env.RPC_SECRET!, ttlMs: 5 * 60_000})
const revoked = new Set<string>()

function resolveAuth(token: unknown) {
    const verdict = codec.verify(token)
    if (!verdict.ok) throw new Error(verdict.reason)                                  // transient rejection
    if (revoked.has(verdict.claims.jti)) {
        throw Object.assign(new Error('revoked'), {revoke: true})                     // hard revocation
    }
    return {
        object: facadeFor(verdict.claims),
        ack: {ok: true, sub: verdict.claims.sub},
        expiresAt: verdict.claims.exp,      // absolute wall-clock ms
        renewBeforeMs: 30_000,              // default 30s, clamped into [0, remaining]
    }
}

createRpcServerAuto({socket, object: {}, socketKey: 'main', auth: {resolveAuth, gate: true}})
```

✅ **Right** — client side, one function for the whole lifecycle:

```ts
const hub = createRpcClientHub(
    () => io(url, {transports: ['websocket']}),
    (rpc) => ({main: rpc<Api>(), side: rpc<Side>()}),
    {token: async ({reason}) => mintSessionToken(reason)},   // reason: 'connect'|'notice'|'unauthorized'
)
hub.authListen(({key, state, reason}) => log(key, state, reason))
```

Without the hub, the same seam on a bare client:

```ts
const c = createRpcClient<Api>({socket, socketKey: 'main', token: current})
c.setTokenRenew(async ({reason, notice}) => await mintSessionToken(reason))
c.onAuthState(({state, reason, expiresAt}) => log(state, reason, expiresAt))
// state: 'expiring' | 'expired' | 'revoked'   (server, on the wire)
//      | 'renewed'  | 'renewFailed'           (local outcome of an AUTOMATIC renewal)
```

**End to end.** `renewBeforeMs` before the deadline the server pushes
`[Pkt.AUTH, {state: 'expiring', expiresAt}]`; at the deadline it pushes `'expired'` and re-applies
the constructor object. Every notice reaches `onAuthState` / `authListen` **and** triggers the
renewer. The renewer's token is presented with a soft `reauth()` on the live socket — subscriptions
are not broken. If the renewer yields nothing, or the same token already in force, the client
reports the local state `'renewFailed'` on the auth stream and stops (without the same-token guard
an expired principal would drive an endless expire→renew→expire loop).

### The two local states, and the deadline they carry

`'renewed'` and `'renewFailed'` are added by the client and never travel on the wire. They are the
two outcomes of an **automatic** renewal — a fresh grant the server acknowledged, or nothing minted
— so one stream covers both wire facts and silent local ones:

```ts
c.onAuthState((e) => {
    if (e.state == 'renewed') showDeadline(e.expiresAt)   // may be absent: read it defensively
    if (e.state == 'renewFailed') promptLogin(e.reason)
})
```

**Deliberately silent.** A manual `reauth(token)` emits **no** `'renewed'`: it resolves with that
very ack, deadline included, so an event would duplicate an answer its caller already holds. An
application `control.grant(...)` (Rule 7) emits none either — it reaches the client as an
unsolicited authAck-bearing `Pkt.MAP`, not through the renewal seam. This stream reports what
happens *without being asked*. Widening it later is additive; narrowing would not be.

**Where `expiresAt` comes from.** `authAck` is the application's value, so the server puts its own
facts about the grant in ONE reserved sub-object instead of a loose field:

```ts
// resolveAuth returned  {ack: {ok: true, sub}, expiresAt: 1770000000000}
await c.auth()   //  {ok: true, sub: 'u1', $rpc: {expiresAt: 1770000000000}}
```

The key is `'$rpc'` (exported as `GRANT_FACTS_KEY`). It is attached on a **copy**, so a frozen or
shared application ack is never mutated, and it is **optional by contract** — read it defensively:

- an ack that is not a plain object travels unchanged (`ack: 'a string'` stays a string);
- an application ack that already owns `$rpc` keeps its own value — the application wins;
- a grant with no `expiresAt`, or `Infinity`, attaches nothing;
- an old server never sends it at all.

❌ **Wrong** — treating it as a guaranteed field of your own ack:

```ts
const {sub, $rpc} = await c.auth()
setTimeout(renew, $rpc.expiresAt - Date.now())    // TypeError whenever the grant had no deadline
```

✅ **Right** — optional at every level, and prefer the event that already carries it:

```ts
const at = (await c.auth())?.$rpc?.expiresAt
if (Number.isFinite(at)) showDeadline(at)
c.onAuthState((e) => { if (e.state == 'renewed' && e.expiresAt != undefined) showDeadline(e.expiresAt) })
```

**Single-flight, two levels.** Inside one client, concurrent triggers share one renewal
(`renewInFlight`). Across facade clients, the hub shares one provider call (`tokenInFlight`): two
facades hitting `'expiring'` at the same moment produce exactly **one** provider call. The slot is
released only after it settles, so the next wave asks again instead of reusing a stale answer.

**Precedence — an explicit token owns ONE connection wave, not every wave after it.**

- `connect(token)` / `setToken(token)` win for the wave they raise, and only that one. The wave is
  every facade client of the connection that call accepts, so all of them present the same explicit
  token and the provider is not consulted (`reason == 'connect'` returns it).
- Every **later** wave — a transport reconnect on the same socket, a server generation change —
  goes to the provider. A token pinned for the life of the hub would be re-presented forever,
  including one the server has already revoked, so every reconnect would start already refused.
- `reauth(token)` claims no wave at all: its own handshake is the HELLO it issues on the live
  socket, so a future connection inherits nothing from it.
- Every renewal trigger — `'expiring'`, `'expired'`, `'revoked'`, `'unauthorized'` — always goes to
  the provider: the explicit token has just been refused by the server, so it cannot be the answer.
- A provider that yields nothing is **not** a downgrade: the facade client keeps the token already
  in force, which on the first wave is the explicit one.

❌ **Wrong** — expecting one explicit token to survive a reconnect:

```ts
await hub.connect(sessionToken)        // wave 1: this token
// ...server revokes it, socket drops, Socket.IO reconnects...
// wave 2 is NOT sessionToken — the provider is asked again. Without a provider there is nothing
// to ask, and the client keeps the token it already holds.
```

✅ **Right** — the provider is the durable source; `connect` is only the first push:

```ts
const hub = createRpcClientHub(() => io(url), (rpc) => ({main: rpc<Api>()}), {token: mintSessionToken})
// no connect() at all: the provider starts the hub and answers every wave, including reconnects
```

### `auth()` always answers

A client that presented **no** token (`token` omitted, `reauth(null)` never called) sends only
`Pkt.STRICT`, and a gated server answers a four-element `MAP` with no `authAck` at all. `auth()`
does not hang on that: it resolves locally with

```ts
await c.auth()   //  {ok: false, reason: 'RPC client presented no token'}
```

It invents no server state — from a client that never asked, a gated server and a server without
auth are indistinguishable, so the answer names the **local** cause. A client that did present a
token is still answered only by its own `authAck` (`null` for a server configured without `auth`),
and a `reauth()` in flight is never settled early by this.

### The automatic retry, and what it excludes

An `E_UNAUTHORIZED` rejection triggers **exactly one** extra attempt, after the renewed principal is
presented. "Exactly once" is structural, not a counter: the retry is issued without the retry flag.

✅ retried:

```ts
await api.func.orders.create(payload)     // waiting CALL, no callbacks in args, renewer installed
await api.strict.orders?.create?.(payload)
```

❌ never retried:

```ts
api.space.audit.log('opened')                 // wait == false: no reply channel to learn it failed
await api.func.upload(onProgress)             // args carried a callback: RESP already released those ids
await api.pipe.db.users.find(1).getName()     // PIPE: opaque chain, steps may carry callbacks
webListen(api).alerts.on(render)              // Listen subscription attempts are not retried
```

…and nothing is retried when no renewer is installed (`setTokenRenew` unset, or a hub without
`hubOpts.token`) — that is the previous behavior, byte-for-byte.

---

## Rule 5 — a privilege decrease cuts streams

Facades of different principals deliberately share **one** Listen node per identity, so a re-auth
that keeps a node keeps its subscribers. A re-auth to a **narrower** principal is different: the
nodes the old facade declared and the new one does not are torn down. Each dropped subscriber first
receives the stream end (`RPC_STOP` → `Pkt.CB_END`) and only then loses the server subscription, so
consumers see a clean end instead of hanging.

```ts
const off = webListen(api).alerts.on((a) => render(a))
await off      // resolves at stream end: downgrade, expiry or revocation
```

**The honest limit: `noStrict` subtrees are never walked.** Teardown evidence is the *declared* set
losing a node, not "absent from the new facade". A Listen inside `noStrict(...)` is resolved by
string path at CALL time and is never walked by the schema builder, so it lands in neither `keep`
nor `drop` and keeps its subscribers across **every** principal change — including a downgrade.
(The same rule is why a routine renewal or a privilege *increase* does not silently kill a dynamic
facade's streams.)

❌ **Wrong** — a stream that must be revocable, hidden in a dynamic subtree:

```ts
function facadeFor(claims: TokenClaims) {
    return {
        who: () => claims.sub,
        live: noStrict({alerts: alertsListen}),   // never walked -> never torn down on downgrade
    }
}
```

✅ **Right** — keep a revocable node declared:

```ts
function facadeFor(claims: TokenClaims) {
    const role = (...roles: string[]) => roles.some((r) => hasRole(claims, r)) ? true : null
    return {
        who: () => claims.sub,
        alerts: role('admin') && alertsListen,    // declared -> walked -> in drop on downgrade
        live: noStrict(dynamicReadOnlySurface),   // fine for things that need no revocation
    }
}
```

If a node must be revocable, keep it out of `noStrict`.

The teardown seam is public on the lower-level server: `hooks.onPrincipalChange(ctx)` receives
`RpcPrincipalChange = {keep, drop}` (sets of Listen node identities). `createRpcServerAuto` already
consumes it and still relays yours.

---

## Rule 6 — only `revoke: true` drops a live session

Every throw out of `resolveAuth` is treated as a **transient** failure by default: the live session
keeps its principal, its `routeMap` and its subscriptions, and the caller's `reauth()` simply
resolves `{ok: false, reason}`. That is what you want when your identity provider blinks.

An explicit revocation is the one rejection that kills the session: it takes the full downgrade path
(`Pkt.AUTH` `'revoked'` → stream teardown → base facade → `authAck {ok: false, state, reason}`).

❌ **Wrong** — expecting a plain throw to revoke:

```ts
resolveAuth(token) {
    if (isBanned(token)) throw new Error('banned')    // transient: the old principal keeps running
    ...
}
```

✅ **Right**:

```ts
resolveAuth(token) {
    if (isBanned(token)) throw Object.assign(new Error('banned'), {revoke: true})
    if (!identityProvider.reachable()) throw new Error('identity provider down')   // deliberately transient
    ...
}
```

---

## Rule 7 — revoke from the server, do not bounce through the client

`resolveAuth` only runs on a HELLO, so `revoke: true` (Rule 6) needs the client to ask. An admin
action, a logout from another device or a fraud signal has no HELLO to ride on. For those,
`createRpcServer` and `createRpcServerAuto` **return** a `control` facet — commands inward over this
one connection's principal:

```ts
control.revoke(reason?: any): boolean         // cut NOW, with the application's reason
control.grant(grant: RpcAuthGrant): boolean   // apply a principal without a client HELLO
```

`false` means only **"this connection is gone"** (the socket+key was taken over by a later server,
or the server was detached) — nothing was sent. It is not a rejection of the command.

Keep them per session, exactly as an `io.on('connection')` handler already keeps everything else:

```ts
import {createRpcServerAuto, type RpcServerControl} from 'wenay-common2'

const sessions = new Map<string, RpcServerControl>()

io.on('connection', (socket) => {
    const {api, control} = createRpcServerAuto({socket, object: {}, socketKey: 'main', auth})
    let userId: string | null = null
    socket.on('disconnect', () => { if (userId) sessions.delete(userId) })
    // …learn userId from your own resolveAuth, then: sessions.set(userId, control)
})

// elsewhere — an admin route, a fraud worker, a "log out everywhere" button:
for (const control of sessions.values()) control.revoke('password changed')
```

`RpcServerControl = ReturnType<typeof createRpcServer>['control']` — derived from the factory, so a
registry like the one above stays typed without a handwritten interface.

❌ **Wrong** — asking the client to revoke itself:

```ts
// server pushes "please re-auth", client calls reauth(), resolveAuth finally throws revoke: true
notifyClientToReauth(socket)     // a compromised or hung client simply never asks
```

✅ **Right** — the server cuts it, and the corridor is the same one expiry takes:

```ts
control.revoke('session revoked by admin')
```

**Same corridor as expiry, by construction.** `revoke` *is* `downgradePrincipal` — there is no second
downgrade path. The client observes exactly what an expired token produces: `Pkt.AUTH` first (so it
learns *why* before its streams end), then the Listen nodes the base facade no longer declares are
torn down with `RPC_STOP` → `CB_END`, then a `Pkt.MAP` with `authAck {ok: false, state, reason}` and
the constructor object's schema. Gated calls reject with `E_UNAUTHORIZED` again. **Only the state
name differs**: `'revoked'` instead of `'expired'`.

**`grant` is the HELLO success path without the question.** Step-up finished elsewhere, admin
impersonation, a token your app server renewed itself — facade, `ack`, `expiresAt` and the timers
behave exactly as if a HELLO had carried it. It is deliberately **uncorrelated**: it answers no
HELLO, so it can never settle someone's pending `reauth()` — and for the same reason it emits no
`'renewed'` on the client's auth stream (Rule 4).

**Safe at any moment.** Before any HELLO (the corridor runs on the base facade, nothing is armed);
twice in a row (deliberately not suppressed — a revocation after an expiry carries a *different*
reason the client should hear, and the second pass drops no stream because there is nothing left to
drop); after detach (both return `false` before touching anything). `revoke` always clears the
grant's timers, so a revoked short-lived token produces no later `'expiring'`/`'expired'`.

**A revocation is not undone by an in-flight token check.** `resolveAuth` is awaited, so a grant
that *started* before your `revoke` would otherwise resolve after it and silently restore the
principal. It is dropped instead — but the HELLO still receives its answer (the current revocation
ack, correlated with its own id), so a `reauth()` in flight settles rather than hanging. Only
revocation guards this way: two grants racing each other stay "last one resolved wins", which is
what HELLO has always meant.

---

## Rule 8 — `createTokenCodec` is a default, not a security product

`createTokenCodec` (server-only, `wenay-common2/server`) exists so in-band auth has one honest
working default for docs, demo and tests: one secret, one pinned algorithm (HMAC-SHA256 behind a
`v1` format tag), one expiry. Non-goals, on purpose:

- **no JWT** — the format is `v1.<base64url(payload)>.<base64url(mac)>`; there is no `alg` header
  and no algorithm negotiation (that is the `alg:none` family of bugs);
- **no key rotation** — one secret, no key registry;
- **no revocation / deny list, no refresh flow**; a short TTL is the only exit;
- **no identity provider** — passwords, OAuth/OIDC and user stores stay in the application.

❌ **Wrong** — expecting features it does not have:

```ts
codec.verify(tokenFromAuth0)      // not a JWT parser
codec.rotateSecret(next)          // does not exist
codec.revoke(jti)                 // does not exist
```

✅ **Right** — short TTL, and revocation is your list, enforced in `resolveAuth`:

```ts
const codec = createTokenCodec({secret: process.env.RPC_SECRET!, ttlMs: 5 * 60_000})
const token = codec.issue({sub: user.id, roles: user.roles})   // exp and jti are MINTED, never accepted
const verdict = codec.verify(token)
//  {ok: true, claims: {sub, exp, jti, ...yours}}  |  {ok: false, reason: 'malformed'|'signature'|'expired'}
```

`issue` throws only on caller error (missing `sub`); `verify` never throws — garbage arriving from
the network is traffic, not an exception. Construction fails immediately on an empty secret.

Your deny list gates the *next* HELLO. To cut sessions that are already live, add the entry and then
walk your `RpcServerControl` registry (Rule 7) — the codec has no reach into an open connection.

---

## Reference — exact signatures

Server (`wenay-common2`):

```ts
createRpcServerAuto({socket, object, socketKey, auth?, hooks?, limits?, opt?, ...}) -> {api, control}
createRpcServer({socket, object, socketKey, auth?, hooks?, limits?, opt?, debug?}) -> {control}

control.revoke(reason?: any) -> boolean          // downgrade NOW; false = connection detached
control.grant(grant: RpcAuthGrant) -> boolean    // HELLO success path, uncorrelated; false = detached
type RpcServerControl = ReturnType<typeof createRpcServer>['control']

type RpcServerAuth = {
    resolveAuth: (token: any) => RpcAuthGrant | Promise<RpcAuthGrant>
    gate?: boolean
}
type RpcAuthGrant = {
    object?: any            // principal facade; absent = keep the currently served object
    ack?: any               // 5th element of Pkt.MAP; default {ok: true}
    expiresAt?: number      // absolute ms deadline; Infinity = none
    renewBeforeMs?: number  // 'expiring' lead time, default 30_000
}
type RpcPrincipalChange = {keep: ReadonlySet<object>; drop: ReadonlySet<object>}
// PromiseServerHooks.onPrincipalChange?: (ctx: RpcPrincipalChange) => void
```

Client (`wenay-common2`):

```ts
createRpcClient<T>({socket, socketKey, token?, limit?, limits?, dedupeListen?, opt?})

client.auth() -> Promise<any>                    // current authAck; null = server without auth;
                                                 // {ok:false, reason:'RPC client presented no token'} = never asked
client.reauth(token: any) -> Promise<any>        // soft re-auth on the LIVE socket; resolves new authAck
client.onAuthState(cb: (e: RpcAuthEvent) => void) -> off
client.setTokenRenew(renew: RpcTokenRenew | null) -> void

type tAuthEventState = tAuthState | 'renewFailed' | 'renewed'  // both LOCAL, never on the wire
type RpcAuthEvent = Omit<RpcAuthNotice, 'state'> & {state: tAuthEventState}
type tAuthRenewReason = 'connect' | 'notice' | 'unauthorized'
type RpcAuthRenewRequest = {reason: tAuthRenewReason; notice?: RpcAuthEvent}
type RpcTokenRenew = (request: RpcAuthRenewRequest) => any    // fresh token, or null/undefined
```

`'renewed'` carries `expiresAt` when the new grant declared one. Emitted only by an AUTOMATIC
renewal — a manual `reauth()` and a server `control.grant` deliberately emit nothing.

Hub (`wenay-common2`):

```ts
createRpcClientHub(createSocket, schemaBuilder, hubOpts?: {opt?: RpcOpt; token?: RpcTokenProvider})

type RpcTokenProvider = (request: RpcAuthRenewRequest)
    => string | null | undefined | Promise<string | null | undefined>
type RpcHubAuthEvent = RpcAuthEvent & {key: string}          // which facade reported it

hub.authListen(cb: (e: RpcHubAuthEvent) => void) -> off      // additive; off removes only this listener
hub.connect(token) / hub.setToken(token)                     // HARD rotation: new socket, no inherited subs
hub.reauth(token)                                            // SOFT: live socket, subscriptions preserved
```

Protocol (`wenay-common2`):

```ts
Pkt.HELLO = 7 · Pkt.MAP = 3 · Pkt.AUTH = 12
Caps.AUTH_STATE = 1 << 2                 // negotiated; a peer that never advertises it never receives Pkt.AUTH
Caps.HELLO_ID  = 1 << 3                  // HELLO id (3rd element) echoed by the answering MAP (6th element)
RpcOpt.authState?: boolean               // default on; false = never negotiated, wire as before
RpcOpt.helloId?: boolean                 // default on; false = uncorrelated wire, reauth() settles on the next ack

// [Pkt.HELLO, token, id?]  ->  [Pkt.MAP, routeMap, schema, listenPaths, authAck, helloId?]
//   only a REPLY carries the echo, so an unsolicited MAP is never mistaken for one.
// [Pkt.AUTH, {state, reason?, expiresAt?}]   // server push, per socket+key

type tAuthState = 'expiring' | 'expired' | 'revoked'
type RpcAuthNotice = {state: tAuthState; reason?: any; expiresAt?: number}

GRANT_FACTS_KEY = '$rpc'                 // reserved sub-object of authAck: ack.$rpc = {expiresAt}
//   Server facts about the current grant, attached on a COPY of the application's ack. Skipped when
//   the ack is not a plain object, already owns the key, or the deadline is not finite. Optional by
//   contract — read it defensively. No wire change: it rides inside the existing 5th MAP element.
```

Token codec (`wenay-common2/server`, node-only):

```ts
createTokenCodec({secret: string; ttlMs?: number; hmac?; now?}) -> {issue, verify}
issue<T extends IssueClaims>(claims: T, options?: {ttlMs?: number}) -> string
verify(token: unknown) -> {ok: true; claims: TokenClaims} | {ok: false; reason: tTokenFailure}

type TokenClaims = {sub: string; exp: number; jti: string} & {[claim: string]: unknown}
type IssueClaims = {sub: string}
type tTokenFailure = 'malformed' | 'signature' | 'expired'
```

---

## Limits documented on purpose

These are known and deliberate. Design around them rather than assuming they will change.

- **`noStrict` subtrees are never torn down.** A Listen inside `noStrict(...)` is invisible to the
  schema walk, so it is in neither `keep` nor `drop` and survives every principal change. Keep a
  revocable node declared (Rule 5).
- **Concurrent `reauth()`s still race — even though replies are now correlated.** `Caps.HELLO_ID`
  makes each `reauth()` settle on the answer to its *own* HELLO (the id rides HELLO's 3rd element
  and comes back in the answering MAP's 6th), so an unsolicited MAP — a STRICT push or an expiry
  downgrade landing mid-flight — no longer resolves a pending `reauth()` with a stale
  `{ok: false, state: 'expired'}`. What that does **not** change: the server keeps ONE principal per
  socket+key, so racing tokens still end in whichever HELLO the server resolved last. Wait for each.
  Against a peer that does not negotiate `HELLO_ID` (or with `opt.helloId: false`) the older rule
  applies — the next authAck-bearing MAP answers the oldest outstanding HELLO.
- **One logical client per socket+key.** In-band auth assumes the hub model. Two token clients on
  one socket would wipe each other's `routeCache` / `authAck` on a principal change. The HELLO echo
  follows the same assumption: the server echoes an id to any peer that sent one, gated on its own
  caps rather than on that peer's advertised bitset (HELLO carries no session correlation), so on a
  shared socket+key a co-tenant may see a six-element `Pkt.MAP`. It reads `msg[4]` and ignores the
  rest, which is the already-covered "client ignores extra `Pkt.MAP` elements" case.
- **`Pkt.AUTH` is emitted to the whole socket+key.** Authorization is per socket+key by
  construction (one `authAck`, one principal), so a co-tenant peer on that key is already subject to
  the same principal, but it does see the bytes. Unknown opcodes are ignored by construction.
- **`authAck` after a downgrade is `{ok: false, state, reason}`** and rides every later `Pkt.MAP`.
  It is not sticky: a successful HELLO replaces it wholesale.
- **`expiresAt` fails closed.** `Infinity` means "no deadline"; any other non-finite value (a
  caller's `Date.now() + undefined`) downgrades immediately rather than granting an unlimited
  session. Deadlines beyond ~24.8 days are waited out in chunks, re-reading the clock at each
  boundary, so a forward jump costs at most one chunk of drift.
- **PIPE is never retried** on `E_UNAUTHORIZED`; only waiting, callback-free `CALL`s are.
- **`control.revoke` works even on a server built without `auth`.** The contract is "cut this
  connection", so the base facade is re-applied and `authAck` becomes `{ok: false, state: 'revoked'}`
  — the one path where a server that never had authorization starts sending an `authAck`, growing
  that peer's `Pkt.MAP` from four elements to five.
- **`control.grant` accepts any object.** It is an application command, so there is no validation
  seam between it and the dispatch rebuild; granting a huge or proxy-backed object rebuilds dispatch
  synchronously. Same exposure as a HELLO grant, now reachable without a client.
- **`control` commands are not deduplicated.** Repeated `revoke` re-sends `Pkt.AUTH` + `Pkt.MAP`
  every time; a loop over a session registry that revokes twice sends twice.
- **A transport whose `emit` throws is not caught.** `control.revoke` propagates it, exactly like
  every timer-driven downgrade and every `RESP` in the same file. "Socket died" is the inert case
  (detached server → `false`), not a throwing `emit`.
- **`revokeEpoch` guards revocation only.** Two application grants, or a `control.grant` racing a
  HELLO, stay "last one resolved wins".
- **Concurrent `init()` / `ready()` still send two HELLOs.** Both calls see the same
  "not handshaked" state. The provider is not consulted twice even then (renewal and the hub's
  provider call are both single-flight). The documented pattern is sequential.
- **A `resolveAuth` that never settles wedges renewals** on that connection: the in-flight slot is
  released only by the real reply. Detach and transport teardown cover the other silent paths.
- **Identity is not in this library.** `resolveAuth` is where your policy runs;
  `createTokenCodec` is a default you may replace outright.

## Executable truth

The auth semantics above are pinned by the harness — `npm run test:rpc`
(`src/Common/rcp/rpc.harness.spec.ts`), stages:

| stage | what it pins |
| --- | --- |
| *Stage 1: in-band auth* | HELLO / `authAck` / `gate` / `reauth` |
| *Stage 2: динамические токены* | `Pkt.AUTH`, expiry, revocation |
| *Stage 2+: провайдер токенов* | single-flight, soft renewal, the one retry |
| *Stage 3: харденинг динамических токенов* | `noStrict`, ack, timers, clock |
| *Stage 4: корреляция HELLO ↔ MAP* | each `reauth()` settles on its own answer |
| *Stage 5: сервер сам рвёт сессию* | `control.revoke` / `control.grant`, `ack.$rpc` |
| *Stage 6: клиент* | one explicit-token wave, one `init`, anonymous `auth()`, `'renewed'` |

If a claim on this page and the harness disagree, the harness is right and this page is a bug.
