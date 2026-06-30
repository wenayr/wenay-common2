// ============================================================
//  oracle/realsocket/obs-dedupe.spec.ts — DISPOSABLE real-socket oracle
//
//  CATEGORY "obs-dedupe": refcount + dedupe of a reactive observable node
//  streamed THROUGH RPC over a REAL socket.io WebSocket.
//
//  What we battle-test (adapting observable/test.ts's loopback round-trip
//  to the real socket via _rs):
//   • multiple LOCAL consumers on the SAME client subscribing the SAME node
//     share exactly ONE wire subscription (client.subscriptions() collapses
//     to a single entry whose consumers count = N), and the server-side node
//     sees count()==1 — ONE wire subscriber regardless of local fan-out.
//   • the server's api.subscriptions() (per-connection) reports consumers.
//   • removing a non-last consumer keeps the stream HOT (node stays count 1,
//     updates keep flowing to the survivor).
//   • the wire stop fires only when the LAST consumer leaves → node returns
//     to count()==0 (cold again, cheap-while-unsubscribed restored).
//   • a 2nd client on the same server node is INDEPENDENT: it re-heats the
//     node to count 1, and its teardown brings it back to 0 on its own.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only oracle/realsocket/obs-dedupe.spec.ts
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell} from '../../observable/reactive'

const PORT = 4205

// nodes in OUTER scope so the test can mutate them AFTER the client subscribes.
// makeObject (per-connection) hands each connection node.listen() handles — the
// SAME shared cells, so server-side count() reflects every connected client.
const counter = createCell(0)
function makeObject() { return {counter: counter.listen()} }

async function main() {
    const {check, done} = makeChecker('obs-dedupe')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    // capture each connection's server-side api so we can read its subscriptions()
    const serverApis: any[] = []
    const srv = await startRealServer({port: PORT, makeObject, onServer: (api) => serverApis.push(api)})
    const cli = await startRealClient({port: PORT})
    await delay(30)

    // ── two LOCAL consumers on the SAME client, SAME node ──────────────
    const gotA: number[] = []
    const gotB: number[] = []
    const subA: any = cli.api.counter.callback((v: number) => gotA.push(v))
    const subB: any = cli.api.counter.callback((v: number) => gotB.push(v))
    await delay(40)

    // dedupe on the client: two consumers, ONE wire subscription
    await check('two local consumers → ONE deduped wire subscription', () => cli.client.api.subscriptions().length, 1)
    await check('that single wire sub carries 2 local consumers', () => cli.client.api.subscriptions()[0].consumers, 2)

    // mutate the OUTER-scope node; both local consumers see every update over the real socket
    counter.set(1); counter.set(2)
    await delay(40)
    await check('consumer A streamed both updates over real socket', () => JSON.stringify(gotA), '[1,2]')
    await check('consumer B streamed both updates over real socket', () => JSON.stringify(gotB), '[1,2]')

    // server-side: ONE wire subscriber on the shared node despite 2 local consumers
    await check('server-side node refcount = 1 (one wire subscriber for N local)', () => counter.count(), 1)
    await check('server api.subscriptions() reports 1 live listen node', () => serverApis[0].subscriptions().length, 1)
    await check('server api.subscriptions() consumers = 1 (single wire stream)', () => serverApis[0].subscriptions()[0].consumers, 1)

    // ── drop the NON-last consumer: stream stays HOT ───────────────────
    subA.unsubscribe?.()
    await delay(40)
    await check('node still hot after dropping non-last consumer (count still 1)', () => counter.count(), 1)
    await check('wire sub survives, now 1 consumer', () => cli.client.api.subscriptions()[0].consumers, 1)
    counter.set(3)
    await delay(40)
    await check('survivor B keeps receiving after A left', () => JSON.stringify(gotB), '[1,2,3]')
    await check('A frozen at its last value (no events after unsubscribe)', () => JSON.stringify(gotA), '[1,2]')

    // ── drop the LAST consumer: wire stop fires, node goes cold ────────
    subB.unsubscribe?.()
    await delay(50)
    await check('last consumer left → wire subscription torn down', () => cli.client.api.subscriptions().length, 0)
    await check('node cold again after last consumer (refcount 0)', () => counter.count(), 0)
    counter.set(99)
    await delay(40)
    await check('cold node delivers nothing to former subscribers', () => JSON.stringify(gotB), '[1,2,3]')

    // ── second client is INDEPENDENT on the same shared node ───────────
    const cli2 = await startRealClient({port: PORT})
    await delay(30)
    const got2: number[] = []
    const sub2: any = cli2.api.counter.callback((v: number) => got2.push(v))
    await delay(40)
    await check('2nd client re-heats the shared node to refcount 1', () => counter.count(), 1)
    counter.set(7)
    await delay(40)
    await check('2nd client receives update on the shared node', () => JSON.stringify(got2), '[7]')

    sub2.unsubscribe?.()
    await delay(50)
    await check('2nd client teardown returns shared node to refcount 0', () => counter.count(), 0)

    clearTimeout(watchdog)
    cli.close(); cli2.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
