// ============================================================
//  oracle/realsocket/auth.spec.ts — DISPOSABLE real-socket test
//  Category "auth": in-band auth over a genuine WebSocket.
//    (1) valid token  → auth() ok, principal methods callable
//    (2) bad / gated   → calls rejected with E_UNAUTHORIZED
//    (3) soft reauth on the LIVE socket → principal swaps (user→admin)
//        WITHOUT dropping a live subscription.
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT = 4105

// One stream node, shared by BOTH principals → the subscription survives a principal
// swap (same socket, same Listen handle). Distinct principals: user (read-only) vs
// admin (read + write) so the swap is observable in method visibility.
const [emit, listen] = createListenPair<number>()
const facades: Record<string, any> = {
    'tok-user': {
        stream: listen,
        whoami: () => 'user',
        read: () => 'public-data',
        pulse: (n: number) => { emit(n); return n },   // drive the stream over the wire
    },
    'tok-admin': {
        stream: listen,
        whoami: () => 'admin',
        read: () => 'public-data',
        write: (x: number) => x * 10,                   // admin-only method
        pulse: (n: number) => { emit(n); return n },
    },
}
function resolveAuth(token: any) {
    const object = facades[token]
    if (!object) throw new Error('bad token')
    return {object, ack: {ok: true, who: object.whoami()}}
}

async function main() {
    const {check, done} = makeChecker('auth')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // gate=true: the EMPTY initial object is protected; the real principal surface only
    // appears after a successful HELLO (resolveAuth → principal facade).
    const srv = await startRealServer({
        port: PORT,
        makeObject: () => ({}),                          // empty until HELLO
        serverOpts: {auth: {resolveAuth, gate: true}},
    })

    // ---- (1) valid token: auth resolves ok, principal methods callable ----
    const cliUser = await startRealClient({port: PORT, token: 'tok-user'})
    const userApi = cliUser.api

    await check('valid token: authAck ok', async () => (await cliUser.client.auth())?.ok, true)
    await check('valid token: authAck who=user', async () => (await cliUser.client.auth())?.who, 'user')
    await check('user principal: read() callable', () => userApi.read(), 'public-data')
    await check('user principal: whoami=user', () => userApi.whoami(), 'user')
    // user facade has NO write → must reject (method absent in principal routeMap)
    await check('user principal: write() rejected (not in facade)',
        () => userApi.write(5).then(() => 'ok', () => 'rejected'), 'rejected')

    // ---- (2) bad token / gated: calls rejected with E_UNAUTHORIZED ----
    const cliBad = await startRealClient({port: PORT, token: 'tok-nope'})
    await check('bad token: authAck ok=false', async () => (await cliBad.client.auth())?.ok, false)
    await check('gated: call rejected code E_UNAUTHORIZED',
        () => (cliBad.api.read() as Promise<any>).catch((e: any) => e?.code), 'E_UNAUTHORIZED')

    // ---- (3) soft reauth on the LIVE socket: user → admin, subscription survives ----
    const got: number[] = []
    const off = cliUser.api.stream.callback((v: number) => got.push(v))
    await delay(50)                                      // let the subscription round-trip
    await userApi.pulse(1)                               // emit BEFORE reauth (as user)
    await delay(50)
    await check('pre-reauth: stream tick received', async () => got.slice(), [1])

    // swap principal on the SAME live socket (no disconnect) via hub.reauth
    const acks = await cliUser.hub.reauth('tok-admin')
    await check('reauth: hub.reauth resolved ok', async () => acks?.[0]?.ok, true)
    await check('reauth: principal swapped who=admin', async () => (await cliUser.client.auth())?.who, 'admin')
    await check('reauth: admin sees write() now', () => cliUser.api.write(4), 40)
    await check('reauth: whoami flipped to admin', () => cliUser.api.whoami(), 'admin')

    await userApi.pulse(2)                               // emit AFTER reauth — same subscription
    await delay(50)
    await check('reauth: subscription survived (live tick after swap)', async () => got.slice(), [1, 2])

    off()
    clearTimeout(watchdog); cliUser.close(); cliBad.close(); await srv.close(); process.exit(done() === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(2) })
