// ============================================================
//  replay/rpc-auth-lifecycle.test.ts
//
//  Dynamic-token lifecycle over a REAL Socket.IO wire (server + hub client).
//  - gate:true — the anonymous facade before HELLO exposes nothing privileged
//  - a live subscription crosses a provider-driven renewal: no gap, no duplicate,
//    no re-subscribe (zero CALL packets during the renewal window)
//  - expiry without a renewal: 'expiring' then 'expired', the privileged stream
//    ENDS (consumers resolve), the stream the base facade still declares keeps
//    flowing, privileged calls are refused afterwards
//  - revocation mid-session: same shape, reported as 'revoked'
//  - single-flight: four calls unauthorized at once produce ONE provider call
//  - one automatic retry per unauthorized call
//  - real createTokenCodec tokens end-to-end: tampered / foreign-secret refused,
//    and the codec's own `exp` claim drives the server-side deadline
//
//  Ports 3169..3172 (3160..3168 belong to oracle/realsocket).
//  Run: npx tsx replay/rpc-auth-lifecycle.test.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {RpcAuthRenewRequest} from '../src/Common/rcp/rpc-client'
import {createRpcClientHub, RpcHubAuthEvent, RpcTokenProvider} from '../src/Common/rcp/rpc-clientHub'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createTokenCodec} from '../src/server/auth-token'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (condition()) return
        await delay(25)
    }
    throw new Error('timeout: ' + label)
}

// A hung await is the one failure an oracle cannot report, so every wire await is bounded.
async function withTimeout<T>(awaitable: PromiseLike<T>, label: string, timeoutMs = 5_000) {
    let timer: any
    try {
        return await Promise.race([
            awaitable,
            new Promise<never>(function rejectAfterTimeout(_, reject) {
                timer = setTimeout(function authLifecycleTimeout() { reject(new Error('timeout: ' + label)) }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

// The gate rejection is machine-readable (MyError code), never a message match. An answered
// call reports 'ANSWERED', so a silently succeeding privileged call cannot read as a refusal.
const refusalOf = (call: PromiseLike<any>) => Promise.resolve(call).then(
    function callAnswered() { return 'ANSWERED' },
    function callRefused(error: any) { return String(error?.code ?? error?.message ?? error) },
)

async function okRefused(call: PromiseLike<any>, message: string) {
    const code = await withTimeout(refusalOf(call), message)
    ok(code == 'E_UNAUTHORIZED', `${message} (${code})`)
}

// Poll the current authAck: a renewal lands as a NEW ack on the same live socket.
async function waitForAck(label: string, client: {auth: () => Promise<any>}, isFresh: (ack: any) => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const ack = await withTimeout(client.auth(), label)
        if (isFresh(ack)) return ack
        await delay(25)
    }
    throw new Error('timeout: ' + label)
}

// ============================================================
// facades: ONE Listen identity per stream, two principals
// ============================================================
// `feed` is declared by BOTH facades, `secrets` only by the member one. A downgrade must
// therefore cut exactly `secrets` and leave `feed` alone — an EMPTY base object could not
// tell selective teardown from "tear everything down". Nothing on the base facade is
// privileged, and gate:true keeps it uncallable before HELLO anyway.
function makeFacades() {
    const [emitFeed, feed] = createListenPair<[number]>()
    const [emitSecret, secrets] = createListenPair<[number]>()
    const anon = {feed}
    const member = {feed, secrets, whoami: () => 'member', balance: () => 42}
    return {emitFeed, emitSecret, feed, secrets, anon, member}
}

type Facade = ReturnType<typeof makeFacades>['member']

// ============================================================
// grant book: the application half of resolveAuth
// ============================================================
function createGrantBook() {
    const grants = new Map<string, {sub: string, expiresAt: number, revoked: boolean}>()
    let issued = 0
    function mint(sub: string, ttlMs: number) {
        const token = `${sub}-${++issued}`
        grants.set(token, {sub, expiresAt: Date.now() + ttlMs, revoked: false})
        return token
    }
    function revoke(token: string) {
        const grant = grants.get(token)
        if (grant) grant.revoked = true
    }
    return {mint, revoke, get: (token: string) => grants.get(token)}
}

// resolveAuth is the server's only auth seam: one grant carries the principal facade, the
// ack and the absolute deadline. Revocation is the ONE rejection that kills a live session,
// so it is signalled by a thrown value carrying revoke === true; any other throw stays
// transient and leaves the session exactly as it was.
function makeResolveAuth(book: ReturnType<typeof createGrantBook>, object: object, renewBeforeMs: number, seen: string[]) {
    return function resolveAuth(token: any) {
        seen.push(String(token))
        const grant = book.get(String(token))
        if (!grant) throw new Error('unknown token')
        if (grant.revoked) throw Object.assign(new Error('token revoked by issuer'), {revoke: true})
        return {object, ack: {ok: true, sub: grant.sub, token}, expiresAt: grant.expiresAt, renewBeforeMs}
    }
}

// ============================================================
// real Socket.IO server + real hub client
// ============================================================
const SOCKET_KEY = 'rpc-auth-lifecycle'

async function startServer(deps: {port: number, object: object, resolveAuth: (token: any) => any}) {
    const inbound = {calls: 0}
    let latest: any = null
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
    ioServer.on('connection', function exposeAuthFacade(socket) {
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', function noteSocketDisconnect() { disconnect() })
        // A SECOND listener on the same key — an independent inbound counter, so the adapter
        // the RPC server receives stays byte-for-byte the socket's own.
        socket.on(SOCKET_KEY, function countInboundCall(data: any) {
            if (Array.isArray(data) && data[0] == Pkt.CALL) inbound.calls++
        })
        const server = createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: SOCKET_KEY,
            object: deps.object,
            disconnectListen,
            auth: {resolveAuth: deps.resolveAuth, gate: true},
        })
        latest = server.api
    })
    await new Promise<void>(function listenForConnections(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(deps.port, '127.0.0.1', resolve)
    })
    return {
        inbound,
        subscriptions: () => latest?.subscriptions() ?? [],
        close: () => new Promise<void>(function closeServer(resolve) {
            ioServer.close()
            httpServer.close(function serverClosed() { resolve() })
        }),
    }
}

async function startClient(deps: {port: number, token?: string | null, provider?: RpcTokenProvider}) {
    const hub = createRpcClientHub(
        function connectAuthSocket() {
            return io(`http://127.0.0.1:${deps.port}`, {transports: ['websocket'], forceNew: true})
        },
        remote => ({app: remote<Facade>(SOCKET_KEY)}) as const,
        deps.provider ? {token: deps.provider} : undefined,
    )
    const states: RpcHubAuthEvent[] = []
    hub.authListen(function recordAuthState(event) { states.push(event) })
    // A token provider owns the whole lifecycle and raises its own socket; without one the
    // token is presented explicitly, exactly as an application that never renews would.
    const clients = deps.provider ? await hub.promise : await hub.setToken(deps.token ?? null)
    // The hub resolves only after every facade client's initStrict, so with a provider the
    // schema is already known here (a second ready() would now be free — the handshake guard
    // runs BEFORE the renewal, so it mints no extra token). Without a provider the explicit
    // token still needs its own handshake, which is what this call is for.
    if (!deps.provider) await clients.app.readyStrict()
    return {
        hub,
        client: clients.app,
        api: clients.app.func,
        states,
        /** States the SERVER pushed. The two client-local outcomes of an automatic renewal —
         *  'renewed' and 'renewFailed' — never travel on the wire and are filtered out here;
         *  they are asserted on their own where they matter. */
        wireStates: () => states
            .filter(event => event.state != 'renewFailed' && event.state != 'renewed')
            .map(event => event.state),
        /** The client-local renewal outcomes, in order. */
        localStates: () => states
            .filter(event => event.state == 'renewFailed' || event.state == 'renewed')
            .map(event => event.state),
        close: () => hub.socket?.disconnect?.(),
    }
}

// ============================================================
// grant + gate contract + renewal on a live subscription
// ============================================================
const PORT_GRANT = 3169
const GRANT_SHORT_MS = 3_000
const GRANT_WARN_MS = 1_500
const GRANT_LONG_MS = 30_000

async function grantAndRenewal() {
    console.log('\n[rpc-auth-lifecycle] short-lived grant, gate contract, renewal on a live stream')
    const world = makeFacades()
    const book = createGrantBook()
    const seen: string[] = []
    const server = await startServer({
        port: PORT_GRANT,
        object: world.anon,
        resolveAuth: makeResolveAuth(book, world.member, GRANT_WARN_MS, seen),
    })
    // The FIRST token is deliberately short: the whole point is that the provider replaces it
    // in time. Every later one is long, so the session settles after exactly one renewal.
    const ttlPlan = [GRANT_SHORT_MS]
    let providerCalls = 0
    async function provideToken() {
        providerCalls++
        return book.mint('member', ttlPlan.shift() ?? GRANT_LONG_MS)
    }
    const anon = await startClient({port: PORT_GRANT})
    const member = await startClient({port: PORT_GRANT, provider: provideToken})
    const secretTicks: number[] = []
    const feedTicks: number[] = []
    const subscriberCounts: number[] = []
    let secretsEnded = false
    let metronome: any = null

    try {
        // ---- gate:true — nothing privileged before HELLO ----
        const anonSchema = Object.keys(anon.client.schema() ?? {})
        ok(anonSchema.includes('feed') && !anonSchema.includes('secrets')
            && !anonSchema.includes('balance') && !anonSchema.includes('whoami'),
        `anonymous schema is the base facade only (${json(anonSchema)})`)
        await okRefused(anon.api.balance(),
            'gate: a privileged call before HELLO is refused with E_UNAUTHORIZED')
        await okRefused(anon.api.secrets.callback(function neverCalled() {}),
            'gate: the privileged stream cannot even be subscribed anonymously')

        // ---- the short-lived token grants the privileged facade ----
        const firstAck = await withTimeout(member.client.auth(), 'first authAck')
        ok(firstAck?.ok == true && firstAck.sub == 'member' && firstAck.token == seen[0],
            `a valid token grants the member principal (${json(firstAck)})`)
        const memberSchema = Object.keys(member.client.schema() ?? {})
        ok(memberSchema.includes('secrets') && memberSchema.includes('balance'),
            `the principal schema carries the privileged surface (${json(memberSchema)})`)
        ok(await withTimeout(member.api.balance(), 'balance') == 42,
            'a privileged call answers under the granted token')
        ok(await withTimeout(member.api.whoami(), 'whoami') == 'member',
            'the served facade is the principal one, not the base object')

        // ---- a live subscription across the renewal ----
        const secretsSub = member.api.secrets.callback(function collectSecret(value: number) { secretTicks.push(value) })
        secretsSub.then(function noteSecretsEnd() { secretsEnded = true })
        member.api.feed.callback(function collectFeed(value: number) { feedTicks.push(value) })
        await waitFor('both subscriptions installed', () => world.secrets.count() == 1 && world.feed.count() == 1)
        world.emitSecret(1)
        world.emitFeed(1)
        await waitFor('live before the renewal', () => secretTicks.includes(1) && feedTicks.includes(1))

        // Nothing may cross the wire FROM the client while the token is replaced: this counter
        // is the evidence that the surviving subscription was never re-issued.
        const callsBeforeRenewal = server.inbound.calls
        let emitted = 1
        metronome = setInterval(function emitAcrossRenewal() {
            world.emitSecret(++emitted)
            subscriberCounts.push(world.secrets.count())
        }, 20)
        await waitFor('server resolved a second token', () => seen.length >= 2)
        const renewedAck = await waitForAck('renewed authAck', member.client, ack => ack?.token == seen[1])
        const beat = emitted
        await waitFor('stream still beating after the renewal', () => emitted >= beat + 10)
        clearInterval(metronome)
        metronome = null
        await waitFor('metronome drained', () => secretTicks.length >= emitted)

        ok(json(member.wireStates()) == json(['expiring']),
            `only the 'expiring' warning reached the consumer (${json(member.states.map(event => event.state))})`)
        ok(json(member.localStates()) == json(['renewed']),
            `the silent renewal reported itself once as 'renewed' (${json(member.states.map(event => event.state))})`)
        const renewedEvent = member.states.find(event => event.state == 'renewed')
        ok(renewedEvent?.expiresAt == renewedAck?.$rpc?.expiresAt && renewedEvent?.expiresAt != undefined,
            `'renewed' carried the NEW deadline the server put in ack.$rpc (${json(renewedEvent)})`)
        ok(providerCalls == 2,
            `provider consulted once at connect and once on 'expiring' (${providerCalls})`)
        ok(renewedAck?.ok == true && seen[1] != seen[0],
            `the renewal presented a NEW token on the SAME socket (${json(renewedAck)})`)
        const contiguous = secretTicks.length == emitted
            && secretTicks.every((value, index) => value == index + 1)
        ok(contiguous,
            `subscription crossed the renewal with no gap and no duplicate (${secretTicks.length}/${emitted})`)
        ok(!secretsEnded, 'no CB_END: a renewed principal keeps the stream it already reaches')
        ok(subscriberCounts.length > 0 && subscriberCounts.every(count => count == 1),
            `server-side subscriber count stayed 1 through the renewal (${json([...new Set(subscriberCounts)])})`)
        ok(server.inbound.calls == callsBeforeRenewal,
            `no CALL crossed the wire during the renewal — no re-subscribe (${server.inbound.calls - callsBeforeRenewal})`)
        ok(await withTimeout(member.api.balance(), 'balance after renewal') == 42,
            'the privileged call still answers under the renewed token')
    } finally {
        if (metronome) clearInterval(metronome)
        anon.close()
        member.close()
        await delay(20)
        await server.close()
    }
}

// ============================================================
// expiry without a renewal, single-flight, one automatic retry
// ============================================================
const PORT_EXPIRY = 3170
const EXPIRY_SHORT_MS = 1_200
const EXPIRY_WARN_MS = 500
const EXPIRY_LONG_MS = 30_000

async function expiryAndRetry() {
    console.log('\n[rpc-auth-lifecycle] expiry without a renewal, single-flight, one retry')
    const world = makeFacades()
    const book = createGrantBook()
    const seen: string[] = []
    const server = await startServer({
        port: PORT_EXPIRY,
        object: world.anon,
        resolveAuth: makeResolveAuth(book, world.member, EXPIRY_WARN_MS, seen),
    })
    // The vault is what the provider is able to hand out RIGHT NOW: empty across the expiry,
    // refilled before the unauthorized wave, so the two halves are observed separately.
    let vault: string | null = book.mint('member', EXPIRY_SHORT_MS)
    let providerCalls = 0
    async function provideToken() {
        providerCalls++
        return vault
    }
    const member = await startClient({port: PORT_EXPIRY, provider: provideToken})
    const secretTicks: number[] = []
    const feedTicks: number[] = []
    let secretsEnded = false

    try {
        vault = null // from here on the application has nothing fresh to present
        const secretsSub = member.api.secrets.callback(function collectSecret(value: number) { secretTicks.push(value) })
        secretsSub.then(function noteSecretsEnd() { secretsEnded = true })
        member.api.feed.callback(function collectFeed(value: number) { feedTicks.push(value) })
        await waitFor('both subscriptions installed', () => world.secrets.count() == 1 && world.feed.count() == 1)
        world.emitSecret(1)
        world.emitFeed(1)
        await waitFor('live before the expiry', () => secretTicks.includes(1) && feedTicks.includes(1))

        // ---- the deadline passes with no renewal available ----
        await withTimeout(secretsSub, 'privileged stream end', 8_000)
        ok(secretsEnded, 'expiry ends the privileged stream: the consumer resolves, nothing hangs')
        ok(json(member.wireStates()) == json(['expiring', 'expired']),
            `'expiring' then 'expired' reached the consumer (${json(member.states.map(event => event.state))})`)
        ok(member.states.some(event => event.state == 'renewFailed'),
            'a provider with nothing to give is reported locally as renewFailed')
        ok(world.secrets.count() == 0 && world.feed.count() == 1,
            `teardown is selective: unreachable node cut, base-facade node kept (${world.secrets.count()}/${world.feed.count()})`)
        world.emitFeed(2)
        await waitFor('base-facade stream survives the downgrade', () => feedTicks.includes(2))
        ok(true, 'the stream the downgraded principal still declares keeps flowing')
        await okRefused(member.api.balance(),
            'privileged calls are refused once the principal is downgraded')

        // ---- single-flight + ONE automatic retry per unauthorized call ----
        vault = book.mint('member', EXPIRY_LONG_MS)
        const callsBeforeWave = providerCalls
        const helloBeforeWave = seen.length
        const wave = await withTimeout(Promise.all([
            member.api.balance(),
            member.api.balance(),
            member.api.whoami(),
            member.api.balance(),
        ]), 'unauthorized wave', 8_000)
        ok(json(wave) == json([42, 42, 'member', 42]),
            `every refused call succeeded after its ONE automatic retry (${json(wave)})`)
        ok(providerCalls - callsBeforeWave == 1,
            `four calls in flight produced exactly ONE provider call (${providerCalls - callsBeforeWave})`)
        ok(seen.length - helloBeforeWave == 1,
            `single-flight presented exactly ONE fresh token (${seen.length - helloBeforeWave} HELLO)`)
        const restored = await withTimeout(member.client.auth(), 'ack after the retry')
        ok(restored?.ok == true && restored.token == seen[seen.length - 1],
            `the retried principal is authorized again (${json(restored)})`)
    } finally {
        member.close()
        await delay(20)
        await server.close()
    }
}

// ============================================================
// revocation mid-session
// ============================================================
const PORT_REVOKE = 3171
const REVOKE_SHORT_MS = 1_200
const REVOKE_WARN_MS = 500
const REVOKE_LONG_MS = 30_000

async function revocationMidSession() {
    console.log('\n[rpc-auth-lifecycle] revocation mid-session')
    const world = makeFacades()
    const book = createGrantBook()
    const seen: string[] = []
    const server = await startServer({
        port: PORT_REVOKE,
        object: world.anon,
        resolveAuth: makeResolveAuth(book, world.member, REVOKE_WARN_MS, seen),
    })
    let providerCalls = 0
    async function provideToken(request: RpcAuthRenewRequest) {
        providerCalls++
        if (request.reason == 'connect') return book.mint('member', REVOKE_SHORT_MS)
        // The issuer withdrew this principal while the session was live, so the freshly minted
        // token is refused with revoke === true — the one rejection that kills a live session.
        const token = book.mint('member', REVOKE_LONG_MS)
        book.revoke(token)
        return token
    }
    const member = await startClient({port: PORT_REVOKE, provider: provideToken})
    const secretTicks: number[] = []
    const feedTicks: number[] = []
    let secretsEnded = false

    try {
        const secretsSub = member.api.secrets.callback(function collectSecret(value: number) { secretTicks.push(value) })
        secretsSub.then(function noteSecretsEnd() { secretsEnded = true })
        member.api.feed.callback(function collectFeed(value: number) { feedTicks.push(value) })
        await waitFor('both subscriptions installed', () => world.secrets.count() == 1 && world.feed.count() == 1)
        world.emitSecret(1)
        world.emitFeed(1)
        await waitFor('live before the revocation', () => secretTicks.includes(1) && feedTicks.includes(1))

        await withTimeout(secretsSub, 'privileged stream end', 8_000)
        ok(secretsEnded, 'revocation ends the privileged stream: the consumer resolves, nothing hangs')
        ok(json(member.wireStates()) == json(['expiring', 'revoked']),
            `the downgrade is reported as 'revoked', not 'expired' (${json(member.states.map(event => event.state))})`)
        ok(providerCalls == 2,
            `the 'revoked' push joined the in-flight renewal — ONE provider call per wave (${providerCalls})`)
        const ack = await withTimeout(member.client.auth(), 'ack after the revocation')
        ok(ack?.ok == false && ack.state == 'revoked' && ack.reason == 'token revoked by issuer',
            `authAck carries state and reason of the revocation (${json(ack)})`)
        ok(world.secrets.count() == 0 && world.feed.count() == 1,
            `revocation tears down only what the base facade cannot reach (${world.secrets.count()}/${world.feed.count()})`)
        world.emitFeed(2)
        await waitFor('base-facade stream survives the revocation', () => feedTicks.includes(2))
        ok(true, 'the stream the downgraded principal still declares keeps flowing')
        await okRefused(member.api.balance(),
            'privileged calls are refused after the revocation')
    } finally {
        member.close()
        await delay(20)
        await server.close()
    }
}

// ============================================================
// real createTokenCodec tokens end-to-end
// ============================================================
const PORT_CODEC = 3172
const CODEC_TTL_MS = 30_000
const CODEC_SHORT_MS = 1_200
const CODEC_WARN_MS = 500

// Privilege escalation attempt: rewrite the claims, keep the issuer's mac.
function tamperClaims(token: string, patch: Record<string, unknown>) {
    const [version, payload, mac] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const forged = Buffer.from(JSON.stringify({...claims, ...patch}), 'utf8').toString('base64url')
    return `${version}.${forged}.${mac}`
}

async function realTokenCodec() {
    console.log('\n[rpc-auth-lifecycle] real createTokenCodec tokens end-to-end')
    const codec = createTokenCodec({secret: 'oracle-lifecycle-secret', ttlMs: CODEC_TTL_MS})
    const foreign = createTokenCodec({secret: 'another-deployment-secret', ttlMs: CODEC_TTL_MS})
    const world = makeFacades()
    const seen: string[] = []
    function resolveAuth(token: any) {
        seen.push(String(token))
        const verdict = codec.verify(token)
        if (!verdict.ok) throw new Error('token ' + verdict.reason)
        // The codec's own `exp` claim IS the server-side deadline — no second source of truth.
        return {
            object: world.member,
            ack: {ok: true, sub: verdict.claims.sub},
            expiresAt: verdict.claims.exp,
            renewBeforeMs: CODEC_WARN_MS,
        }
    }
    const genuine = codec.issue({sub: 'alice'})
    const escalated = tamperClaims(genuine, {sub: 'root'})
    const foreignToken = foreign.issue({sub: 'alice'})

    // ---- in-proc: the primitive before the layer above it ----
    ok(codec.verify(genuine).ok == true, 'codec verifies the token it issued')
    const tamperedVerdict = codec.verify(escalated)
    ok(tamperedVerdict.ok == false && tamperedVerdict.reason == 'signature',
        `a rewritten claim does not survive the mac (${json(tamperedVerdict)})`)
    const foreignVerdict = codec.verify(foreignToken)
    ok(foreignVerdict.ok == false && foreignVerdict.reason == 'signature',
        `a foreign secret does not verify (${json(foreignVerdict)})`)

    const server = await startServer({port: PORT_CODEC, object: world.anon, resolveAuth})
    try {
        // ---- a genuine token over the wire ----
        const good = await startClient({port: PORT_CODEC, token: genuine})
        try {
            const ack = await withTimeout(good.client.auth(), 'codec authAck')
            ok(ack?.ok == true && ack.sub == 'alice',
                `a genuine codec token grants its own subject (${json(ack)})`)
            ok(await withTimeout(good.api.balance(), 'balance') == 42,
                'a genuine codec token reaches the privileged facade')
        } finally {
            good.close()
            await delay(20)
        }

        // ---- refused tokens ----
        for (const [label, token] of [['tampered', escalated], ['foreign-secret', foreignToken]] as const) {
            const bad = await startClient({port: PORT_CODEC, token})
            try {
                const ack = await withTimeout(bad.client.auth(), 'refused authAck')
                ok(ack?.ok == false && ack.reason == 'token signature',
                    `a ${label} token is refused in-band (${json(ack)})`)
                await okRefused(bad.api.balance(),
                    `a ${label} token reaches no privileged method`)
                const schema = Object.keys(bad.client.schema() ?? {})
                ok(schema.includes('feed') && !schema.includes('secrets'),
                    `a ${label} token leaves the anonymous schema in place (${json(schema)})`)
            } finally {
                bad.close()
                await delay(20)
            }
        }

        // ---- claims.exp drives the server deadline ----
        const shortLived = codec.issue({sub: 'bob'}, {ttlMs: CODEC_SHORT_MS})
        async function provideShortLived(request: RpcAuthRenewRequest) {
            return request.reason == 'connect' ? shortLived : null
        }
        const bob = await startClient({port: PORT_CODEC, provider: provideShortLived})
        const ticks: number[] = []
        let ended = false
        try {
            const sub = bob.api.secrets.callback(function collectSecret(value: number) { ticks.push(value) })
            sub.then(function noteEnd() { ended = true })
            await waitFor('subscription installed', () => world.secrets.count() == 1)
            world.emitSecret(1)
            await waitFor('live under the codec token', () => ticks.includes(1))
            await withTimeout(sub, 'codec token expiry', 8_000)
            ok(ended, 'the codec `exp` claim drives the server deadline: the stream ends on expiry')
            ok(json(bob.wireStates()) == json(['expiring', 'expired']),
                `codec token expiry is reported end-to-end (${json(bob.states.map(event => event.state))})`)
            await okRefused(bob.api.balance(),
                'an expired codec token reaches no privileged method')
            ok(seen.length == 4 && seen[3] == shortLived,
                `every HELLO carried a real codec token (${seen.length} presented)`)
        } finally {
            bob.close()
        }
    } finally {
        await delay(20)
        await server.close()
    }
}

async function main() {
    await grantAndRenewal()
    await expiryAndRetry()
    await revocationMidSession()
    await realTokenCodec()
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportAuthLifecycleFailure(error) { console.error(error); process.exit(1) })
