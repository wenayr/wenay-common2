import {createStore, createStoreMirror, exposeStore} from './store'
import {flushReactive} from './reactive'

type Market = {
    data: { BTC?: number; ETH?: number; SOL?: number }
    meta: { status?: string }
}

let fails = 0
const ok = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL', m) } else console.log('  OK  ', m) }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

async function main() {
    console.log('\n[store] primitive node current/on/once')
    {
        const store = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}}, {drain: 'micro'})
        let current = 0
        store.node.data.BTC.on(v => { current = v ?? 0 }, {current: true})
        ok(current == 1, 'primitive leaf on(current) reads value')
        const seen: any[] = []
        store.node.data.BTC.once(v => seen.push(v), {current: true})
        store.state.data.BTC = 3
        await flushReactive(store.state)
        ok(JSON.stringify(seen) == '[1]', 'primitive once(current) uses current store value')
    }

    console.log('\n[store] path survives branch replacement')
    {
        const store = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {}}, {drain: 'micro'})
        const got: any[] = []
        store.node.data.BTC.on(v => got.push(v))
        store.state.data = {BTC: 10, SOL: 5}
        await flushReactive(store.state)
        store.state.data.BTC = 11
        await flushReactive(store.state)
        ok(JSON.stringify(got) == '[10,11]', 'leaf subscription follows same path after whole branch replace: ' + JSON.stringify(got))
    }

    console.log('\n[store] branch drain and current')
    {
        const store = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {}}, {drain: 'micro'})
        const got: any[] = []
        store.node.data.on(v => got.push({...v}), {current: true, drain: 'micro'})
        store.state.data.BTC = 3
        store.state.data.ETH = 4
        await flushReactive(store.state)
        await tick()
        ok(got.length == 2 && got[0].BTC == 1 && got[1].BTC == 3 && got[1].ETH == 4, 'branch current + drained snapshot')
    }

    console.log('\n[store] typed mask selection and routes')
    {
        const store = createStore<Market>({data: {BTC: 1, ETH: 2, SOL: 3}, meta: {status: 'ok'}}, {drain: 'micro'})
        const sel = store.update({data: {BTC: true, ETH: true}, meta: {status: true}}, {current: true})
        const snaps: any[] = []
        const each: string[] = []
        sel.on(v => snaps.push(v))
        sel.onEach((v, ctx) => each.push(ctx.pathString + '=' + v))
        store.state.data.BTC = 10
        store.state.meta.status = 'warn'
        await flushReactive(store.state)
        await tick()
        ok(snaps.length == 2 && snaps[0].data.BTC == 1 && snaps[1].data.BTC == 10 && snaps[1].meta.status == 'warn', 'selection sends current + one coalesced update')
        ok(each.includes('data.BTC=10') && each.includes('meta.status=warn'), 'onEach exposes route strings: ' + JSON.stringify(each))
    }

    console.log('\n[store] exposeStore + createStoreMirror sync')
    {
        const server = createStore<Market>({data: {BTC: 1, ETH: 2, SOL: 3}, meta: {status: 'ok'}}, {drain: 'micro'})
        const api = exposeStore(server)
        const mirror = createStoreMirror<Market>(api as any, {data: {}, meta: {}}, {drain: 'micro'})
        await mirror.sync({data: {BTC: true}, meta: {status: true}}, {current: true, drain: 'micro'})
        ok(mirror.state.data.BTC == 1 && mirror.state.data.ETH === undefined && mirror.state.meta.status == 'ok', 'initial masked mirror snapshot')
        let btc = 0
        mirror.node.data.BTC.on(v => { btc = v ?? 0 }, {current: true})
        server.state.data.BTC = 9
        server.state.data.ETH = 20
        server.state.meta.status = 'warn'
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.data.BTC == 9 && mirror.state.data.ETH === undefined && mirror.state.meta.status == 'warn', 'mirror updates only selected paths')
        ok(btc == 9, 'mirror local node subscription fires from sync')
    }

    console.log('\n[store] changedPaths lets mirror pull only dirty selected paths')
    {
        const server = createStore<any>({strategies: {a: {status: false}}, meta: {status: 'ok'}}, {drain: 'micro'})
        const exposed = exposeStore(server) as any
        const masks: any[] = []
        const api = {...exposed, get: (mask?: any) => { masks.push(mask); return exposed.get(mask) }}
        const mirror = createStoreMirror<any>(api, {strategies: {}, meta: {}}, {drain: 'micro'})
        await mirror.sync({strategies: true, meta: {status: true}}, {current: true, drain: 'micro'})
        masks.length = 0

        server.state.strategies.a.status = true
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.strategies.a.status === true, 'deep strategy update reaches mirror')
        ok(JSON.stringify(masks[masks.length - 1]) == '{"strategies":{"a":{"status":true}}}', 'deep update pulled dirty path only: ' + JSON.stringify(masks[masks.length - 1]))

        server.state.strategies.b = {status: true}
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.strategies.b.status === true, 'added strategy reaches mirror')
        ok(JSON.stringify(masks[masks.length - 1]) == '{"strategies":{"b":true}}', 'add pulled added branch only: ' + JSON.stringify(masks[masks.length - 1]))

        delete server.state.strategies.b
        await flushReactive(server.state)
        await tick(); await tick()
        ok(!('b' in mirror.state.strategies), 'removed strategy is deleted from mirror')
        ok(JSON.stringify(masks[masks.length - 1]) == '{"strategies":{"b":true}}', 'delete pulled removed branch only: ' + JSON.stringify(masks[masks.length - 1]))

        server.state.meta.status = 'warn'
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.meta.status == 'warn', 'non-strategy selected path still syncs')
        ok(JSON.stringify(masks[masks.length - 1]) == '{"meta":{"status":true}}', 'meta update pulled selected leaf only: ' + JSON.stringify(masks[masks.length - 1]))
    }

    console.log('\n[store] optional push patches sync')
    {
        const server = createStore<Market>({data: {BTC: 1, ETH: 2, SOL: 3}, meta: {status: 'ok'}}, {drain: 'micro'})
        const exposed = exposeStore(server, {push: true}) as any
        const pulls: any[] = []
        const api = {...exposed, get: (mask?: any) => { pulls.push(mask); return exposed.get(mask) }}
        const mirror = createStoreMirror<Market>(api, {data: {}, meta: {}}, {drain: 'micro'})
        await mirror.syncPatches({data: {BTC: true}, meta: {status: true}}, {current: true, drain: 'micro'})
        ok(mirror.state.data.BTC == 1 && mirror.state.data.ETH === undefined && mirror.state.meta.status == 'ok', 'patch sync initial masked snapshot')
        pulls.length = 0

        server.state.data = {BTC: 7, ETH: 8, SOL: 9}
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.data.BTC == 7 && mirror.state.data.ETH === undefined && mirror.state.data.SOL === undefined, 'patch branch replace applies only selected leaves')
        ok(pulls.length == 0, 'patch sync does not pull after push event')

        delete server.state.meta.status
        await flushReactive(server.state)
        await tick(); await tick()
        ok(!('status' in mirror.state.meta), 'patch delete removes selected leaf')
    }

    console.log('\n[store] optional changedData sync')
    {
        const server = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}}, {drain: 'micro'})
        const exposed = exposeStore(server, {push: true}) as any
        const pulls: any[] = []
        const api = {...exposed, get: (mask?: any) => { pulls.push(mask); return exposed.get(mask) }}
        const mirror = createStoreMirror<Market>(api, {data: {}, meta: {}}, {drain: 'micro'})
        await mirror.syncChangedData({data: {BTC: true}}, {current: true, drain: 'micro'})
        pulls.length = 0

        server.state.data = {BTC: 5, ETH: 10}
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.data.BTC == 5 && mirror.state.data.ETH === undefined, 'changedData branch replace respects selected mask')
        ok(pulls.length == 0, 'changedData sync does not pull after push event')

        server.state.data.BTC = 6
        server.state.meta.status = 'warn'
        await flushReactive(server.state)
        await tick(); await tick()
        ok(mirror.state.data.BTC == 6 && mirror.state.meta.status === undefined, 'changedData ignores unselected dirty paths')
    }
    console.log('\n[store] node identity handles dotted keys, symbols, and once(current)')
    {
        const store = createStore<any>({data: {BTC: 1}}, {drain: 'micro'})
        const symA = Symbol('x')
        const symB = Symbol('x')
        ok(store.node.at('a.b') !== store.node.at('a').at('b'), 'internal node cache separates dotted key from nested path')
        ok(store.node.at(symA) !== store.node.at(symB), 'internal node cache separates distinct symbols with same description')

        let hits = 0
        const off = store.update({data: {BTC: true}}, {current: true}).once(() => hits++, {current: true})
        store.state.data.BTC = 2
        await flushReactive(store.state)
        await tick()
        off()
        ok(hits == 1, 'selection.once(current) fires once and unsubscribes')
    }

    console.log('\n[store] snapshot: circular Map/Set and shared references')
    {
        const m = new Map<any, any>()
        m.set('self', m)
        const s = new Set<any>()
        s.add(s)
        const shared = new Map<any, any>([['x', 1]])
        const store = createStore<any>({m, s, a: {shared}, b: {shared}}, {drain: 'micro'})
        const snap = store.snapshot()
        ok(snap.m instanceof Map && snap.m.get('self') === snap.m, 'self-containing Map snapshots as a cycle, no infinite recursion')
        ok(snap.s instanceof Set && snap.s.has(snap.s), 'self-containing Set snapshots as a cycle')
        ok(snap.a.shared === snap.b.shared && snap.a.shared.get('x') == 1, 'shared Map keeps ONE copy identity in the snapshot')
        ok(snap.m !== m && snap.a.shared !== shared, 'snapshot copies, does not alias the originals')
    }

    console.log('\n[store] mirror sync error path: failed pull reports, chain survives')
    {
        const settle = async () => { for (let i = 0; i < 5; i++) await tick() }
        const server = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}}, {drain: 'micro'})
        const exposed = exposeStore(server) as any
        let failNext = false
        const api = {...exposed, get: (mask?: any) => {
            if (failNext) throw new Error('pull boom')
            return exposed.get(mask)
        }}
        const mirror = createStoreMirror<Market>(api, {data: {}, meta: {}}, {drain: 'micro'})
        const errors: any[] = []
        const stop = await mirror.sync({data: {BTC: true}}, {current: true, drain: 'micro', onError: e => errors.push(e)})
        ok(mirror.state.data.BTC == 1, 'initial pull ok')

        failNext = true
        server.state.data.BTC = 2
        await flushReactive(server.state)
        await settle()
        ok(errors.length == 1 && String(errors[0]).includes('pull boom'), 'failed re-pull lands in onError, not as an unhandled rejection')

        failNext = false
        server.state.data.BTC = 3
        await flushReactive(server.state)
        await settle()
        ok(mirror.state.data.BTC == 3, 'sync chain survives the failure and catches up on the next change')
        stop()

        failNext = true
        let threw = false
        try { await mirror.sync({data: {BTC: true}}, {current: true}) } catch { threw = true }
        ok(threw, 'initial pull failure rejects the awaited sync() itself')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
