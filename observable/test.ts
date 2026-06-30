// ===========================================================================
// Oracle for observable/reactive.ts — in-process behavior + a REAL RPC
// round-trip (real client + real server over an in-memory loopback, exactly
// like src/Common/rcp/rpc.harness.spec.ts).
//
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/test.ts
// ===========================================================================

import {createCell, createRObject, createRMap, combine, computed, isListenCallback} from './reactive'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'

let fails = 0
function assert(cond: any, msg: string) {
    if (!cond) { fails++; console.log('  FAIL:', msg) }
    else console.log('  ok  :', msg)
}
const J = (v: any) => JSON.stringify(v)
const delay = (ms = 0) => new Promise(r => setTimeout(r, ms))

// loopback transport (JSON-cloned, like a real socket) — copied from the harness
function createLoopback(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)]
}

async function main() {
    // ── cheap until subscribed ──────────────────────────────
    console.log('\n[cell] cheap until subscribed')
    {
        const n = createCell(0)
        assert(n.count() == 0, 'no listeners → count 0')
        n.set(1); n.set(2)
        assert(n.get() == 2, 'reads/writes work with zero listeners')
        assert((n as any).listen().count() == 0, 'materialising the Listen adds no listeners')
    }

    // ── subscribe = new updates only ────────────────────────
    console.log('\n[cell] subscribe is new-updates-only')
    {
        const n = createCell(10)
        const seen: number[] = []
        n.subscribe(v => seen.push(v))
        assert(seen.length == 0, 'no current value on subscribe')
        n.set(11); n.set(11) /* deduped */; n.set(12)
        assert(J(seen) == '[11,12]', 'only changed future values: ' + J(seen))
    }

    // ── conditional callback: opt-in current value ──────────
    console.log('\n[cell] subscribe({current:true})')
    {
        const n = createCell('a')
        const seen: string[] = []
        n.subscribe(v => seen.push(v), {current: true})
        n.set('b')
        assert(J(seen) == '["a","b"]', 'current then updates: ' + J(seen))
    }

    // ── unsubscribe ─────────────────────────────────────────
    console.log('\n[cell] unsubscribe')
    {
        const n = createCell(0)
        const seen: number[] = []
        const off = n.subscribe(v => seen.push(v))
        n.set(1); off(); n.set(2)
        assert(J(seen) == '[1]', 'no events after unsubscribe: ' + J(seen))
        assert(n.count() == 0, 'count back to 0')
    }

    // ── recycle: back to primitive after churn ──────────────
    console.log('\n[cell] recycle returns to primitive')
    {
        const n = createCell(0, {recycle: true})
        const ll = (n as any)
        const off = n.subscribe(() => {})
        assert(ll.listen().count() == 1, 'inner Listen alive while subscribed')
        off()
        // after the last listener leaves, the inner Listen is freed (null)
        assert(n.count() == 0, 'count 0 after unsubscribe')
        // re-subscribing still works (façade recreated the inner)
        const seen: number[] = []
        n.subscribe(v => seen.push(v))
        n.set(5)
        assert(J(seen) == '[5]', 'resubscribe after recycle works: ' + J(seen))
    }

    // ── RObject: per-key + whole ────────────────────────────
    console.log('\n[robject] per-key + whole')
    {
        const o = createRObject({x: 1, y: 2})
        const whole: any[] = []
        const onX: number[] = []
        o.subscribe((k, v) => whole.push([k, v]))
        o.key('x').subscribe(v => onX.push(v))
        o.set('y', 20)
        o.set('x', 10)
        assert(J(onX) == '[10]', 'key("x") sees only x: ' + J(onX))
        assert(J(whole) == '[["y",20],["x",10]]', 'whole sees both: ' + J(whole))
        assert(o.get('x') == 10 && J(o.snapshot()) == '{"x":10,"y":20}', 'reads + snapshot')
    }

    // ── RMap: set / delete ──────────────────────────────────
    console.log('\n[rmap] set + delete')
    {
        const m = createRMap<string, number>([['a', 1]])
        const ev: any[] = []
        m.subscribe((k, v) => ev.push([k, v]))
        m.set('b', 2)
        m.delete('a')
        assert(J(ev) == '[["b",2],["a",null]]', 'set then delete: ' + J(ev))
        assert(m.size == 1, 'size after delete')
    }

    // ── derived: combine / map (pull + lazy push) ───────────
    console.log('\n[derived] combine + map')
    {
        const a = createCell(2)
        const b = createCell(3)
        const sum = combine([a, b], ([x, y]) => x + y)
        // pull works with NO subscription (and no upstream subscription)
        assert(sum.get() == 5, 'get() pulls without subscribing')
        assert(a.count() == 0 && b.count() == 0, 'sources stay cold while derived has no listeners')

        const seen: number[] = []
        const off = sum.subscribe(v => seen.push(v))
        assert(a.count() == 1 && b.count() == 1, 'subscribing derived connects upstream')
        a.set(10)            // 10 + 3 = 13
        b.set(0)             // 10 + 0 = 10
        a.set(10)            // no change → no emit
        assert(J(seen) == '[13,10]', 'recomputed pushes: ' + J(seen))

        off()
        assert(a.count() == 0 && b.count() == 0, 'last listener leaving disconnects upstream')

        // chained map, with current
        const doubled = sum.map(v => v * 2)
        const seen2: number[] = []
        doubled.subscribe(v => seen2.push(v), {current: true})  // current = (10+0)*2 = 20
        a.set(1)             // (1+0)*2 = 2
        assert(J(seen2) == '[20,2]', 'map + current: ' + J(seen2))
    }

    // ── façade shape guard (RPC compatibility contract) ─────
    console.log('\n[rpc] .listen() is funcListenCallbackBase-shaped')
    {
        const n = createCell(0)
        assert(isListenCallback(n.listen()), 'cell.listen() passes isListenCallback')
        const o = createRObject({a: 1})
        assert(isListenCallback(o.listen()), 'robject.listen() passes isListenCallback')
        assert(isListenCallback(o.key('a').listen()), 'robject.key().listen() passes isListenCallback')
        const m = createRMap<string, number>()
        assert(isListenCallback(m.listen()), 'rmap.listen() passes isListenCallback')
        assert(isListenCallback(combine([n], ([v]) => v).listen()), 'combine().listen() passes isListenCallback')
        // even in recycle mode the façade survives & stays valid
        const r = createCell(0, {recycle: true})
        const lst = r.listen()
        r.subscribe(() => {})()  // subscribe + immediately unsubscribe → recycle
        assert(isListenCallback(lst), 'recycle façade still valid after teardown')
    }

    // ── REAL RPC round-trip: reactive source streams over the wire ──
    console.log('\n[rpc] real client+server round-trip over loopback')
    {
        const count = createCell(0)
        const profileName = createCell('alice')
        const [cs, ss] = createLoopback()
        createRpcServerAuto({
            socket: ss,
            object: {count: count.listen(), profile: {name: profileName.listen()}},
            socketKey: 'rpc',
        })
        const c = createRpcClient<any>({socket: cs, socketKey: 'rpc'})
        await delay(0)

        const gotCount: number[] = []
        const gotName: string[] = []
        const sub: any = (c.func as any).count.callback((v: number) => gotCount.push(v))
        ;(c.func as any).profile.name.callback((v: string) => gotName.push(v))
        await delay(10)

        // server-side mutation propagates to the remote subscriber
        count.set(1); count.set(2)
        profileName.set('bob')
        await delay(10)
        assert(J(gotCount) == '[1,2]', 'cell updates streamed to client: ' + J(gotCount))
        assert(J(gotName) == '["bob"]', 'nested cell update streamed: ' + J(gotName))

        // the server now has exactly one live subscriber on the count Listen
        assert(count.count() == 1, 'one wire subscriber on server-side cell')

        // remote unsubscribe frees the server-side listener
        sub.unsubscribe?.()
        await delay(10)
        count.set(3)
        await delay(10)
        assert(J(gotCount) == '[1,2]', 'no events after remote unsubscribe: ' + J(gotCount))
        assert(count.count() == 0, 'server-side cell back to 0 subscribers (cheap again)')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    return fails
}

main().then(f => process.exit(f == 0 ? 0 : 1))
