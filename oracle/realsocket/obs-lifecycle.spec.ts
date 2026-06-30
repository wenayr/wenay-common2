// REAL-SOCKET obs-lifecycle: OBSERVABLE reactive nodes (createCell/RObject/RMap/
// combine/computed) streamed THROUGH RPC over a genuine socket.io WebSocket.
//
// Adapts observable/test.ts '[rpc] real client+server round-trip' from the in-memory
// loopback to the REAL socket via the _rs substrate: node.listen() handles live in the
// per-connection facade (makeObject), the client subscribes via the transparent proxy
// .callback(fn), the test mutates nodes with node.set(...) in OUTER scope, and we assert
// server-side refcount via node.count().
//
// Category: lifecycle over real RPC —
//   • client.dispose() drains the reactive subscription → server node count()==0 ("cheap again")
//   • client.onDisconnect / hub.onDisconnect fire on teardown / rotation
//   • socket disconnect ALSO drains the server-side subscriber (no leftover)
//   • after hub.setToken rotation a fresh subscribe works and connectCount increments
//
// Port 4206 — ours alone.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell, createRObject, createRMap, combine, computed} from '../../observable/reactive'

const PORT = 4206

// ===== reactive nodes in OUTER scope so the test can mutate them AFTER the client
// subscribes. makeObject() (called per-connection) exposes node.listen() handles —
// the same underlying nodes back every connection, so node.count() is the true
// server-side wire-subscriber refcount across the whole process. =====
const counter = createCell(0)
const profile = createRObject({name: 'alice', age: 30})
const roster = createRMap<string, number>([['a', 1]])
const a = createCell(2)
const b = createCell(3)
const sum = combine([a, b], ([x, y]) => x + y)
const doubled = computed(counter, v => v * 2)

function makeObject() {
    return {
        ping: async () => 'pong',
        counter: counter.listen(),
        // nested reactive node — per-key stream off an RObject
        profile: {name: profile.key('name').listen()},
        roster: roster.listen(),
        sum: sum.listen(),
        doubled: doubled.listen(),
    }
}

async function main() {
    const {check, done} = makeChecker('obs-lifecycle')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    const srv = await startRealServer({port: PORT, makeObject})

    // ============================================================
    // PART 1 — client.dispose() drains the reactive subscription
    // ============================================================
    const cli = await startRealClient({port: PORT})

    // sanity: plain call round-trips over the real socket
    await check('CALL ping round-trips over real socket', () => cli.api.ping(), 'pong')

    // subscribe to several reactive streams via the transparent proxy
    const gotCounter: number[] = []
    const gotName: string[] = []
    const gotRoster: any[] = []
    const gotSum: number[] = []
    const gotDoubled: number[] = []

    const subCounter: any = cli.api.counter.callback((v: number) => gotCounter.push(v))
    cli.api.profile.name.callback((v: string) => gotName.push(v))
    cli.api.roster.callback((k: string, v: any) => gotRoster.push([k, v]))
    cli.api.sum.callback((v: number) => gotSum.push(v))
    cli.api.doubled.callback((v: number) => gotDoubled.push(v))

    await delay(80) // let all subscriptions round-trip to the server over the wire

    // server-side refcount: the client holds TWO listeners on `counter` — one direct
    // (api.counter) and one transitive via `doubled = computed(counter)` which, once its
    // own wire subscriber appears, connects upstream to counter. So count() == 2 here.
    await check('server-side cell refcount = 2 (direct + via computed)', () => counter.count(), 2)
    await check('combine connected upstream sources (a.count==1)', () => a.count(), 1)

    // mutate the OUTER-scope nodes — updates must stream back over the real socket
    counter.set(1); counter.set(2)
    profile.set('name', 'bob')
    profile.set('age', 31)          // different key → must NOT reach the name stream
    roster.set('b', 2); roster.delete('a')
    a.set(10)                       // 10 + 3 = 13
    b.set(0)                        // 10 + 0 = 10
    await delay(80) // reactive propagation + WebSocket latency back to the client

    await check('cell updates streamed over real socket', () => JSON.stringify(gotCounter), '[1,2]')
    await check('nested RObject key stream (only its key)', () => JSON.stringify(gotName), '["bob"]')
    await check('RMap set+delete streamed', () => JSON.stringify(gotRoster), '[["b",2],["a",null]]')
    await check('combine recomputed + streamed', () => JSON.stringify(gotSum), '[13,10]')
    await check('computed (counter*2) streamed', () => JSON.stringify(gotDoubled), '[2,4]')

    // ----- remote unsubscribe of ONE node frees only that server-side listener -----
    subCounter.unsubscribe?.()
    await delay(80)
    counter.set(3) // must NOT reach the (unsubscribed) DIRECT consumer
    await delay(60)
    // direct counter sub gone → refcount drops by one, but `doubled`(computed) still
    // holds its transitive listener on counter, so count() == 1 (not 0 yet).
    await check('counter refcount = 1 after direct unsubscribe (computed still holds)', () => counter.count(), 1)
    await check('no events on the unsubscribed direct counter consumer', () => JSON.stringify(gotCounter), '[1,2]')
    // ...but `doubled` IS still subscribed, so it observed counter.set(3) → 6
    await check('computed still live: counter*2 stream saw the new value', () => JSON.stringify(gotDoubled), '[2,4,6]')

    // ----- client.dispose() drains ALL remaining reactive subscriptions -----
    let cliDisconnectReason: string | null = null
    cli.client.onDisconnect((r: string) => { cliDisconnectReason = r })

    await check('live wire subscriptions before dispose (>0)', () => cli.client.api.subscriptions().length > 0, true)

    cli.client.dispose('test dispose')
    await delay(80)

    await check('client.onDisconnect fired with reason', () => cliDisconnectReason, 'test dispose')
    await check('no live wire subscriptions after dispose', () => cli.client.api.subscriptions().length, 0)
    await check('RObject name node cheap again after dispose', () => profile.key('name').count(), 0)
    await check('counter fully cold after dispose (direct + computed gone)', () => counter.count(), 0)
    await check('combine sources disconnected after dispose (a.count==0)', () => a.count(), 0)
    await check('combine sources disconnected after dispose (b.count==0)', () => b.count(), 0)

    cli.close()
    await delay(40)

    // ============================================================
    // PART 2 — socket DISCONNECT also drains the server-side subscriber
    // ============================================================
    const cli2 = await startRealClient({port: PORT})
    cli2.api.counter.callback((v: number) => {})
    await delay(80)
    await check('fresh client re-subscribe: server-side refcount = 1 again', () => counter.count(), 1)

    // hard socket disconnect (no graceful dispose) — server must notice and drain
    cli2.close()
    await delay(150) // server-side disconnect event + reactive teardown

    await check('socket disconnect drains server-side subscriber (count 0)', () => counter.count(), 0)
    await check('no leftover subscriber on any node after disconnect', () =>
        counter.count() + profile.key('name').count() + sum.count() + a.count() + b.count(), 0)

    // ============================================================
    // PART 3 — hub.setToken rotation: fresh subscribe works, connectCount++
    // ============================================================
    const cli3 = await startRealClient({port: PORT})
    let hubDisconnectReason: string | null = null
    cli3.hub.onDisconnect((r: string) => { hubDisconnectReason = r })

    await check('connectCount after initial connect', () => cli3.hub.connectCount(), 1)

    // subscribe on the FIRST connection
    const gotPre: number[] = []
    cli3.api.counter.callback((v: number) => gotPre.push(v))
    await delay(80)
    counter.set(100)
    await delay(80)
    await check('pre-rotation subscribe receives update', () => JSON.stringify(gotPre), '[100]')
    await check('server-side refcount = 1 on pre-rotation connection', () => counter.count(), 1)

    // HARD rotation: tears down old subs (socketAlive:false), fires hub onDisconnect,
    // opens a fresh socket and reconnects (connectCount++).
    await cli3.hub.setToken('rotated-token')
    await delay(150)

    await check('hub.onDisconnect fired on rotation', () => hubDisconnectReason, 'token rotated')
    await check('connectCount incremented to 2 after rotation', () => cli3.hub.connectCount(), 2)
    await check('old subscription torn down → server refcount 0 after rotation', () => counter.count(), 0)

    // a FRESH subscribe on the rotated (new) connection works end-to-end
    const freshApi = (cli3.hub.facade as any).api.func
    const gotPost: number[] = []
    freshApi.counter.callback((v: number) => gotPost.push(v))
    await delay(80)
    counter.set(200); counter.set(201)
    await delay(80)
    await check('fresh subscribe after rotation works over real socket', () => JSON.stringify(gotPost), '[200,201]')
    await check('server-side refcount = 1 on the fresh post-rotation subscription', () => counter.count(), 1)

    cli3.close()
    await delay(120)
    await check('final teardown: no leftover server-side subscriber', () => counter.count(), 0)

    clearTimeout(watchdog)
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
