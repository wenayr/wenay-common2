// ============================================================
//  oracle/realsocket/obs-rich.spec.ts — DISPOSABLE battle-test
//
//  CATEGORY "obs-rich": rich-type reactive state streamed THROUGH RPC
//  over a REAL socket.io WebSocket. Cells / RObject holding Date, Map,
//  Set, BigInt — assert each round-trips intact to the remote subscriber
//  across the real socket (integration of observable state + rpc-walk's
//  rich-type pack/unpack). Mutate and assert the NEW rich value streams.
//
//    node node_modules/ts-node/dist/bin.js --transpile-only oracle/realsocket/obs-rich.spec.ts
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createCell, createRObject} from '../../observable/reactive'

const PORT = 4204

// ── concrete rich values (nodes in OUTER scope so we can mutate post-subscribe) ──
const D0 = new Date('2021-01-02T03:04:05.000Z')
const D1 = new Date('2022-12-31T23:59:59.000Z')

const cellDate = createCell<Date>(D0)
const cellMap = createCell<Map<string, number>>(new Map([['a', 1], ['b', 2]]))
const cellSet = createCell<Set<number>>(new Set([10, 20]))
const cellBig = createCell<bigint>(123456789012345678901234567890n)
// nested: Map whose VALUES are themselves rich (Date) — exercises deep walk
const cellNested = createCell<Map<string, Date>>(new Map([['k', D0]]))
// an RObject carrying a mix of rich types per key
const profile = createRObject<{when: Date, tags: Set<string>, big: bigint}>({
    when: D0,
    tags: new Set(['x']),
    big: 7n,
})

function makeObject() {
    return {
        cellDate: cellDate.listen(),
        cellMap: cellMap.listen(),
        cellSet: cellSet.listen(),
        cellBig: cellBig.listen(),
        cellNested: cellNested.listen(),
        profile: {
            when: profile.key('when').listen(),
            tags: profile.key('tags').listen(),
            big: profile.key('big').listen(),
        },
    }
}

async function main() {
    const {check, done} = makeChecker('obs-rich')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})

    // collectors per stream
    const gotDate: Date[] = []
    const gotMap: Map<string, number>[] = []
    const gotSet: Set<number>[] = []
    const gotBig: bigint[] = []
    const gotNested: Map<string, Date>[] = []
    const gotWhen: Date[] = []
    const gotTags: Set<string>[] = []
    const gotBigKey: bigint[] = []

    const subs: any[] = []
    subs.push(cli.api.cellDate.callback((v: Date) => gotDate.push(v)))
    subs.push(cli.api.cellMap.callback((v: Map<string, number>) => gotMap.push(v)))
    subs.push(cli.api.cellSet.callback((v: Set<number>) => gotSet.push(v)))
    subs.push(cli.api.cellBig.callback((v: bigint) => gotBig.push(v)))
    subs.push(cli.api.cellNested.callback((v: Map<string, Date>) => gotNested.push(v)))
    subs.push(cli.api.profile.when.callback((v: Date) => gotWhen.push(v)))
    subs.push(cli.api.profile.tags.callback((v: Set<string>) => gotTags.push(v)))
    subs.push(cli.api.profile.big.callback((v: bigint) => gotBigKey.push(v)))

    // give the real socket time to register every server-side subscription
    await delay(60)

    // ── mutate (server side) → new rich values must stream to the remote subscriber ──
    cellDate.set(D1)
    cellMap.set(new Map([['c', 3], ['d', 4]]))
    cellSet.set(new Set([99, 100, 101]))
    cellBig.set(999999999999999999999999999999n)
    cellNested.set(new Map([['k', D1], ['m', D0]]))
    profile.set('when', D1)
    profile.set('tags', new Set(['y', 'z']))
    profile.set('big', 42n)

    // real WebSocket latency + reactive propagation — be generous
    await delay(120)

    // ── 1) Date round-trips intact ──
    await check('Date streams intact over real socket', () => gotDate[0], D1)
    // ── 2) Map (string→number) round-trips intact ──
    await check('Map streams intact over real socket', () => gotMap[0], new Map([['c', 3], ['d', 4]]))
    // ── 3) Set round-trips intact ──
    await check('Set streams intact over real socket', () => gotSet[0], new Set([99, 100, 101]))
    // ── 4) BigInt round-trips intact ──
    await check('BigInt streams intact over real socket', () => gotBig[0], 999999999999999999999999999999n)
    // ── 5) nested Map<string,Date> — deep rich walk round-trips ──
    await check('nested Map<string,Date> streams intact', () => gotNested[0], new Map([['k', D1], ['m', D0]]))
    // ── 6) RObject per-key Date round-trips ──
    await check('RObject key(Date) streams intact', () => gotWhen[0], D1)
    // ── 7) RObject per-key Set round-trips ──
    await check('RObject key(Set) streams intact', () => gotTags[0], new Set(['y', 'z']))
    // ── 8) RObject per-key BigInt round-trips ──
    await check('RObject key(BigInt) streams intact', () => gotBigKey[0], 42n)

    // ── 9) server-side refcount: each live wire subscriber counts as 1 ──
    await check('server-side cellDate refcount = 1', () => cellDate.count(), 1)
    await check('server-side cellMap refcount = 1', () => cellMap.count(), 1)

    // ── 10) mutate AGAIN → a SECOND rich value streams (proves it is live, not a snapshot) ──
    cellSet.set(new Set([7]))
    await delay(80)
    await check('second Set mutation streams the new value', () => gotSet[1], new Set([7]))
    await check('exactly two Set emissions received', () => gotSet.length, 2)

    // ── 11) remote unsubscribe frees the server-side listener (cold again) ──
    for (const s of subs) s.unsubscribe?.()
    await delay(80)
    await check('cellDate cold again after unsubscribe (refcount 0)', () => cellDate.count(), 0)
    await check('cellSet cold again after unsubscribe (refcount 0)', () => cellSet.count(), 0)

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
