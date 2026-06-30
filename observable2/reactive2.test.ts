// ============================================================
//  observable2/reactive2.test.ts — oracle for reactive2.ts
//   npx tsx observable2/reactive2.test.ts
// ============================================================

import {reactive, onUpdate, flushReactive, listenUpdate} from './reactive2'

type Fn = () => void
let fails = 0
const ok = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL', m) } else console.log('  OK  ', m) }
const sum = (o: any) => Object.values(o).reduce((a: any, b: any) => a + b, 0) as number

let pending: Fn | null = null
const manual = {drain: (f: Fn) => { pending = f }}
const flush = () => { const f = pending; pending = null; if (f) f() }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function main() {
    console.log('\n[1] plain + nested read/write')
    {
        const s = reactive({price: 0, a: {b: {c: 1}}}, manual)
        s.price = 100; s.a.b.c = 5
        ok(s.price == 100 && s.a.b.c == 5, 'reads/writes at any depth, as a normal object')
    }

    console.log('\n[2] cold = cheap (no subscribers -> set schedules nothing)')
    {
        const s = reactive({x: 0}, manual); pending = null
        s.x = 1; s.x = 2
        ok(pending == null && s.x == 2, 'set with zero subscribers does not schedule a drain')
    }

    console.log('\n[3] FACT once per settled batch, on a consistent state')
    {
        const s = reactive<{balances: Record<string, number>}>({balances: {BTC: 1, ETH: 10}}, manual)
        let fires = 0, seen = -1
        onUpdate(s.balances, () => { fires++; seen = sum(s.balances) })
        s.balances['BTC'] = 2; s.balances['SOL'] = 3
        ok(fires == 0, 'nothing fires before the drain')
        flush()
        ok(fires == 1, 'one fact for the whole burst: ' + fires)
        ok(seen == 2 + 10 + 3, 'recomputed on the FINAL consistent state: ' + seen)
    }

    console.log('\n[4] the $500 case: replace the WHOLE map, sum unchanged -> no false alarm')
    {
        const s = reactive<{balances: Record<string, number>}>({balances: {BTC: 100, ETH: 400}}, manual)
        const alarms: number[] = []
        onUpdate(s.balances, () => { const t = sum(s.balances); if (t != 500) alarms.push(t) })
        s.balances = {SOL: 250, DOT: 150, ADA: 100}
        flush()
        ok(alarms.length == 0, 'sum stayed 500 across a wholesale replace: ' + JSON.stringify(alarms))
        ok(sum(s.balances) == 500, 'reads the new consistent collection: ' + sum(s.balances))
    }

    console.log('\n[5] replace a node in the MIDDLE; subscriber on it survives + deep writes re-bind')
    {
        const s = reactive<any>({a: {b: {c: {x: 0}}}}, manual)
        let onB = 0
        onUpdate(s.a.b, () => onB++)
        s.a.b = {c: {x: 1}}
        flush()
        ok(onB == 1 && s.a.b.c.x == 1, 'B-subscriber survived wholesale replace: ' + onB)
        s.a.b.c.x = 2
        flush()
        ok(onB == 2 && s.a.b.c.x == 2, 'deep write into replaced sub-tree fires B again: ' + onB)
    }

    console.log('\n[6] watch root = watch everything; delete fires too')
    {
        const s = reactive<any>({a: {b: 1}, list: {k: 1}}, manual)
        let hits = 0
        onUpdate(s, () => hits++)
        s.a.b = 9
        flush(); const after1 = hits
        delete s.list.k
        flush()
        ok(after1 == 1 && hits == 2, 'root subscriber sees deep set AND delete: ' + hits)
    }

    console.log('\n[7] unsubscribe before flush suppresses callback')
    {
        const s = reactive<any>({a: {x: 1}}, manual)
        let hits = 0
        const off = onUpdate(s.a, () => hits++)
        s.a.x = 2
        off()
        flush()
        ok(hits == 0, 'removed subscriber is not called from an already queued batch')
    }

    console.log('\n[8] mutation inside callback re-queues into a follow-up drain')
    {
        const s = reactive({x: 0}, {drain: 'micro'})
        let hits = 0
        onUpdate(s, () => { hits++; if (hits == 1) s.x = 2 })
        s.x = 1
        await flushReactive(s)
        ok(hits == 2 && s.x == 2, 'cascaded update settles without sync recursion: ' + hits)
    }

    console.log('\n[9] arrays are reactive plain containers')
    {
        const s = reactive<any>({arr: [{x: 1}]}, manual)
        let hits = 0
        onUpdate(s.arr, () => hits++)
        s.arr[0].x = 2
        s.arr.push({x: 3})
        flush()
        ok(hits == 1 && s.arr.length == 2 && s.arr[0].x == 2, 'index write + push coalesce on array: ' + hits)
    }

    console.log('\n[10] Date/Map/class instances are opaque leaves, not proxied')
    {
        class Box { constructor(public x: number) {} inc() { this.x++; return this.x } }
        const d = new Date(1000)
        const m = new Map<string, number>([['a', 1]])
        const b = new Box(1)
        const s = reactive({d, m, b}, manual)
        ok(s.d === d && s.d.getTime() == 1000, 'Date methods keep their native receiver')
        ok(s.m === m && s.m.get('a') == 1, 'Map stays raw')
        ok(s.b === b && s.b.inc() == 2, 'class instance stays raw')
    }

    console.log('\n[11] depth makes deeper objects opaque')
    {
        const s = reactive<any>({a: {b: {x: 1}}}, {...manual, depth: 1})
        let hits = 0
        onUpdate(s.a, () => hits++)
        s.a.b.x = 2
        flush()
        ok(hits == 0, 'deep write below depth is intentionally opaque')
        s.a.b = {x: 3}
        flush()
        ok(hits == 1, 'replace at the wrapped level still fires: ' + hits)
    }

    console.log('\n[12] callback errors do not stop sibling subscribers')
    {
        const s = reactive({x: 0}, manual)
        let sibling = 0
        let uncaught: any = null
        process.once('uncaughtException', e => { uncaught = e })
        onUpdate(s, () => { throw new Error('boom') })
        onUpdate(s, () => { sibling++ })
        s.x = 1
        flush()
        await tick()
        ok(sibling == 1, 'sibling subscriber still ran after another subscriber threw')
        ok(uncaught?.message == 'boom', 'callback error is re-thrown asynchronously')
    }

    console.log('\n[13] listenUpdate exposes updates as project Listen')
    {
        const s = reactive({a: {b: 1}}, manual)
        const updates = listenUpdate(s.a)
        let hits = 0
        const off = updates.addListen(() => hits++)
        s.a.b = 2
        flush()
        ok(hits == 1, 'listenUpdate fired through addListen')
        off()
        s.a.b = 3
        flush()
        ok(hits == 1, 'listenUpdate off() removed subscriber')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
