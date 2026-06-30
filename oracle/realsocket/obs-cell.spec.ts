// REAL-SOCKET obs-cell: createCell streamed THROUGH RPC over a genuine
// socket.io WebSocket. Port 4201.
//
// Adapts observable/test.ts '[rpc] real client+server round-trip' from
// loopback to the REAL socket via _rs. Pattern: keep the cell in OUTER scope,
// expose node.listen() inside makeObject (per-connection facade), subscribe via
// the client proxy `.callback(fn)`, mutate with node.set(...), and assert the
// SERVER-side refcount with node.count().
//
// Covered (category "obs-cell"):
//  • ordered updates stream over the real socket
//  • "cheap until subscribed" — count()==0 before any client subscribes
//  • refcount==1 with one subscriber
//  • unsubscribe stops further ticks AND drops refcount to 0 ("cold again")
//  • a fresh subscribe after cold works again
//  • emitting an EQUAL value does not double-notify (Object.is de-dup, reactive.ts L222)
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell} from '../../observable/reactive'

const PORT = 4201

// node in OUTER scope so the test can mutate it after the client subscribes.
const counter = createCell(0)
// per-connection facade — hand out the stable raw() Listen façade of the cell.
function makeObject() { return {counter: counter.listen()} }

async function main() {
    const {check, done} = makeChecker('obs-cell')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    // "cheap until subscribed": no client has touched the cell yet → no inner Listen.
    await check('cheap until subscribed: refcount 0 before any client', () => counter.count(), 0)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    await delay(50) // let handshake (MAP / declared listens) settle

    // even after a client is connected, an UNSUBSCRIBED cell stays cold.
    await check('still cold after connect, before subscribe (refcount 0)', () => counter.count(), 0)

    // ── one subscriber: ordered updates stream over the real socket ──
    const got: number[] = []
    const sub: any = cli.api.counter.callback((v: number) => got.push(v))
    await delay(80) // subscription round-trip over the wire

    await check('server-side refcount = 1 with one subscriber', () => counter.count(), 1)

    counter.set(1)
    counter.set(2)
    await delay(80) // real WebSocket latency + reactive propagation
    await check('ordered cell updates streamed over real socket', () => got, [1, 2])

    // ── de-dup: setting the SAME value must NOT notify (Object.is, reactive.ts) ──
    const lenBefore = got.length
    const changed = counter.set(2) // equal to current → set() returns false, no emit
    await delay(80)
    await check('equal set() returns false (de-dup at source)', () => changed, false)
    await check('equal value does not double-notify over wire', () => got.length, lenBefore)
    await check('stream still exactly [1,2] after equal set', () => got, [1, 2])

    // ── unsubscribe: stops further ticks AND drops refcount to 0 ("cold again") ──
    sub.unsubscribe?.()
    await delay(120) // removeCallback is fire-and-forget; give it round-trip time
    await check('cold again after unsubscribe (refcount 0)', () => counter.count(), 0)

    counter.set(3)
    await delay(80)
    await check('no events after unsubscribe (still [1,2])', () => got, [1, 2])

    // ── fresh subscribe after cold works again ──
    const got2: number[] = []
    const sub2: any = cli.api.counter.callback((v: number) => got2.push(v))
    await delay(80)
    await check('resubscribe re-warms server-side refcount = 1', () => counter.count(), 1)

    counter.set(4)
    counter.set(5)
    await delay(80)
    await check('fresh subscriber receives post-resubscribe updates [4,5]', () => got2, [4, 5])

    sub2.unsubscribe?.()
    await delay(120)
    await check('cold again after final unsubscribe (refcount 0)', () => counter.count(), 0)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
