// ============================================================
//  observable2/reactive2.test.ts — oracle for reactive2.ts
//   npx tsx observable2/reactive2.test.ts
// ============================================================

import {reactive, onUpdate, onUpdatePaths, flushReactive, listenUpdate, listenUpdatePaths, toRaw} from './reactive2'

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
        ok(Array.isArray(s.arr), 'wrapped array still passes Array.isArray')
        ok(JSON.stringify(s.arr) == '[{"x":2},{"x":3}]', 'wrapped array JSON stays array-shaped')
    }

    console.log('\n[9b] captured array proxy follows object rebind without array invariant throws')
    {
        const s = reactive<any>({arr: [{x: 1}]}, manual)
        const a = s.arr
        s.arr = {x: 1}
        ok(JSON.stringify(a) == '{"x":1}', 'captured array proxy serializes current object target')
        ok(JSON.stringify(Object.keys(a)) == '["x"]', 'Object.keys on rebound array proxy returns object keys')
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
        pending = null
        const updates = listenUpdate(s.a)
        s.a.b = 2
        ok(pending == null, 'listenUpdate is cold until it has downstream listeners')
        let hits = 0
        const off = updates.on(() => hits++)
        s.a.b = 3
        flush()
        ok(hits == 1, 'listenUpdate fired through addListen')
        off()
        pending = null
        s.a.b = 4
        ok(pending == null, 'listenUpdate returns cold after last listener leaves')
        flush()
        ok(hits == 1, 'listenUpdate off() removed subscriber')
    }

    console.log('\n[14] descriptor writes go to the reactive target')
    {
        const s = reactive<{x: number; y?: number}>({x: 1}, manual)
        let hits = 0
        onUpdate(s, () => hits++)
        Object.defineProperty(s, 'y', {value: 2, enumerable: true, configurable: true, writable: true})
        flush()
        ok(s.y == 2 && Object.keys(s).includes('y'), 'defineProperty creates visible reactive property')
        ok(hits == 1, 'defineProperty notifies subscribers')

        const child = reactive({z: 1}, manual)
        Object.defineProperty(s, 'box' as any, {value: child, enumerable: true, configurable: true, writable: true})
        ok((toRaw(s) as any).box === toRaw(child) && (toRaw(s) as any).box !== child, 'defineProperty stores raw values, not reactive proxies')
    }

    console.log('\n[15] deleted child proxies do not bubble into the live tree')
    {
        const s = reactive<{a?: {x: number}}>({a: {x: 1}}, manual)
        const oldA = s.a!
        let root = 0, child = 0
        onUpdate(s, () => root++)
        onUpdate(oldA, () => child++)
        delete s.a
        flush()
        ok(root == 1 && child == 1 && !('a' in s), 'delete notifies root and deleted child once')
        oldA.x = 2
        flush()
        ok(root == 1 && child == 1, 'mutating captured deleted child is detached')
    }

    console.log('\n[16] duplicate onUpdate callbacks are independent subscriptions')
    {
        const s = reactive({x: 0}, manual)
        let hits = 0
        const cb = () => hits++
        const off1 = onUpdate(s, cb)
        const off2 = onUpdate(s, cb)
        off1()
        s.x = 1
        flush()
        ok(hits == 1, 'second duplicate subscription remains after first off')
        off2()
        s.x = 2
        flush()
        ok(hits == 1, 'second off removes remaining duplicate subscription')
    }

    console.log('\n[17] optional dirty paths are relative to the subscribed node')
    {
        const s = reactive<any>({strategies: {a: {status: false}}, rows: [1]}, manual)
        const got: string[][] = []
        onUpdatePaths(s.strategies, change => got.push(change.paths.map(p => p.join('.')).sort()))
        s.strategies.a.status = true
        flush()
        s.strategies.b = {status: false}
        flush()
        delete s.strategies.a
        flush()
        ok(JSON.stringify(got) == '[["a.status"],["b"],["a"]]', 'object set/add/delete paths: ' + JSON.stringify(got))

        const rootGot: string[][] = []
        onUpdatePaths(s, change => rootGot.push(change.paths.map(p => p.join('.')).sort()))
        s.rows.push(2)
        flush()
        ok(JSON.stringify(rootGot) == '[["rows"]]', 'array mutation dirties the array branch, not splice internals: ' + JSON.stringify(rootGot))
    }

    console.log('\n[18] listenUpdatePaths exposes dirty paths as a cold Listen')
    {
        const s = reactive({a: {b: 1}}, manual)
        pending = null
        const updates = listenUpdatePaths(s.a)
        s.a.b = 2
        ok(pending == null, 'listenUpdatePaths is cold until it has downstream listeners')
        let got = ''
        const off = updates.on(change => { got = change.paths.map(p => p.join('.')).join(',') })
        s.a.b = 3
        flush()
        ok(got == 'b', 'listenUpdatePaths fired with relative dirty path: ' + got)
        off()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
