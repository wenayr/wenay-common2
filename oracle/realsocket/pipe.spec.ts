// ============================================================
//  oracle/realsocket/pipe.spec.ts — DISPOSABLE real-socket oracle for PIPE chains
//
//  Category "pipe": a method returning a transformation chain that the server
//  walks step-by-step (get/call) over a real WebSocket. Covers:
//    • single-stage chain (.value)
//    • multi-stage chain (>1 call stage: .add().mul().value)
//    • rich-type values flowing THROUGH the pipe (Date/Map/BigInt as call args
//      and as final result)
//    • transparent relay (a pipe method returning another pipe handle —
//      server detects IS_RPC_PIPE and __executeRemainingPipe-continues)
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'

const PORT = 4103

// ===== facade with pipe-able chain methods =====
function makeObject() {
    // makeBox returns a fresh chainable box; every transform returns a new box,
    // so the server walks `.add(..).mul(..).value` as a real pipe.
    function makeBox(n: number): any {
        return {
            value: n,
            add: (m: number) => makeBox(n + m),
            mul: (m: number) => makeBox(n * m),
        }
    }
    return {
        makeBox,
        // rich-type pipe: takes a Date arg, returns a chainable carrying rich data
        makeWhen(d: Date): any {
            return {
                date: d,
                // shift the date forward by ms (rich arg flows through a pipe call stage)
                shift: (ms: number) => makeWhenInner(new Date(d.valueOf() + ms)),
                tags: new Map<string, number>([['a', 1], ['b', 2]]),
                big: 9007199254740993n,
            }
        },
    }

    function makeWhenInner(d: Date): any {
        return {
            date: d,
            shift: (ms: number) => makeWhenInner(new Date(d.valueOf() + ms)),
            tags: new Map<string, number>([['a', 1], ['b', 2]]),
            big: 9007199254740993n,
        }
    }
}

async function main() {
    const {check, done} = makeChecker('pipe')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})
    const P = cli.client.pipe as any // pipe proxy: supports chaining .a().b().value

    await delay(20)

    // --- single-stage chain: method result -> property get ---
    await check('makeBox(10).value', () => P.makeBox(10).value, 10)

    // --- two-stage chain: one call stage then value ---
    await check('makeBox(10).add(5).value', () => P.makeBox(10).add(5).value, 15)

    // --- multi-stage chain (>2 call stages): transparent relay across boxes ---
    await check('makeBox(2).add(3).mul(4).value', () => P.makeBox(2).add(3).mul(4).value, 20)

    // --- order matters: mul before add ---
    await check('makeBox(2).mul(4).add(3).value', () => P.makeBox(2).mul(4).add(3).value, 11)

    // --- awaiting the chain object itself (no trailing .value): rich object out ---
    await check('makeBox(7).add(1) -> {value:8}', async () => {
        const box = await P.makeBox(7).add(1)
        return box.value
    }, 8)

    // --- rich type as a Date arg flowing INTO a pipe + Date out ---
    const base = new Date(1700000000000)
    await check('makeWhen(date).date round-trips Date', () => P.makeWhen(base).date, base)

    // --- rich Date arg + call-stage transform: shift forward by 1000ms ---
    await check('makeWhen(date).shift(1000).date', () => P.makeWhen(base).shift(1000).date, new Date(1700000001000))

    // --- chained shifts: two call stages over a Date ---
    await check('makeWhen(date).shift(1000).shift(500).date',
        () => P.makeWhen(base).shift(1000).shift(500).date,
        new Date(1700000001500))

    // --- Map flowing out through a pipe get ---
    await check('makeWhen(date).tags is Map', () => P.makeWhen(base).tags, new Map([['a', 1], ['b', 2]]))

    // --- BigInt flowing out through a pipe (after a transform stage) ---
    await check('makeWhen(date).shift(1).big is BigInt', () => P.makeWhen(base).shift(1).big, 9007199254740993n)

    clearTimeout(watchdog); cli.close(); await srv.close(); process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
