import {
    createMemoryOfflineStorage,
    createStore,
    createStoreManager,
    exposeStore,
    exposeStoreReplay,
    flushReactive,
    managedStore,
} from '../src/Common/Observe'
import {isNoStrict, noStrict} from '../src/Common/rcp/rpc-dynamic'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const settle = async (state: object) => { await flushReactive(state); await tick(); await tick() }
const json = (v: any) => JSON.stringify(v)

type Market = {
    data: {BTC?: number; ETH?: number}
    meta: {status?: string}
}

type Rows = {
    rows: Record<string, {qty: number}>
}

async function main() {
    console.log('\n[store-manager] plan gates and mirror sync')
    {
        const server = createStore<Market>({data: {BTC: 1, ETH: 2}, meta: {status: 'ok'}}, {drain: 'micro'})
        const remote = exposeStore(server)
        const manager = createStoreManager({
            market: managedStore.mirror({
                remote,
                initial: {data: {}, meta: {}},
                mask: {data: {BTC: true}, meta: {status: true}},
                priority: 10,
                tags: ['route:main', 'bootstrap'],
                sync: {opts: {current: true, drain: 'micro'}},
                storeOpts: {drain: 'micro'},
            }),
            heavyHistory: managedStore.mirror({
                remote,
                initial: {data: {}, meta: {}},
                mask: true,
                priority: 1000,
                tags: ['history'],
                explicitOnly: true,
                large: true,
            }),
        })

        const defaultPlan = manager.plan()
        ok(defaultPlan.length == 1 && defaultPlan[0].key == 'market', 'default plan excludes large explicit-only resources')
        const fullPlan = manager.plan({includeExplicit: true, includeLarge: true})
        ok(fullPlan[0].key == 'heavyHistory', 'full plan can include high-priority explicit resource')

        let rejected = false
        try { await manager.start('heavyHistory') }
        catch { rejected = true }
        ok(rejected, 'explicitOnly resource rejects implicit start')

        const mirror = await manager.start('market')
        ok(mirror.state.data.BTC == 1 && mirror.state.data.ETH === undefined && mirror.state.meta.status == 'ok', 'mirror starts with selected mask only')

        server.state.data.BTC = 5
        server.state.data.ETH = 9
        server.state.meta.status = 'warn'
        await settle(server.state)
        ok(mirror.state.data.BTC == 5 && mirror.state.data.ETH === undefined && mirror.state.meta.status == 'warn', 'mirror keeps syncing selected paths')

        manager.touch('market', 3)
        const usage = manager.usage().get('market')
        ok(usage?.count == 1 && usage.weight == 3, 'touch records usage weight for planning')

        manager.stop('market')
        ok(manager.handles.market.status().state == 'stopped', 'stop updates handle status')
    }

    console.log('\n[store-manager] offline replay resource')
    {
        const backend = createStore<Rows>({rows: {a: {qty: 1}}}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const storage = createMemoryOfflineStorage()
        const manager = createStoreManager({
            rows: managedStore.offline<Rows>({
                remote: exposed.api.replay,
                initial: {rows: {}},
                storage,
                debounceMs: 0,
                storeOpts: {drain: 'micro'},
                tags: ['route:rows'],
            }),
        })

        const store = await manager.start('rows')
        ok(json(store.state) == json(backend.snapshot()), 'offline resource starts from replay keyframe')

        backend.state.rows.b = {qty: 2}
        await settle(backend.state)
        ok(store.state.rows.b.qty == 2, 'offline resource stays connected to replay updates')

        await store.flush()
        const saved = await storage.read<any>('rows')
        ok(saved?.seq != null && saved.snapshot.rows.b.qty == 2, 'offline resource persists snapshot and seq')

        manager.stopAll()
        exposed.close()
        ok(manager.handles.rows.status().state == 'stopped', 'stopAll closes offline resource')
    }

    console.log('\n[store-manager] dynamic account-map lifecycle')
    {
        const sources = new Map<string, ReturnType<typeof createStore<Market>>>()
        const remotes = noStrict(new Proxy({} as Record<string, any>, {
            get(_target, key) {
                if (typeof key != 'string') return undefined
                let source = sources.get(key)
                if (!source) {
                    source = createStore<Market>({data: {BTC: key.length}, meta: {status: 'relay'}}, {drain: 'micro'})
                    sources.set(key, source)
                }
                return exposeStoreReplay(source, {history: 20}).api.replay
            },
        }))
        function accountResource(account: string) {
            return managedStore.replay<Market>({
                remote: remotes[account],
                initial: {data: {}, meta: {}},
                storeOpts: {drain: 'micro'},
            })
        }
        const manager = createStoreManager({
            alice: accountResource('alice'),
            bob: accountResource('bob'),
        })

        ok(isNoStrict(remotes), 'runtime account map is explicitly noStrict, not a fixed schema')
        const alice = await manager.start('alice')
        ok(alice.state.data.BTC == 5 && manager.get('bob') == null, 'start selects one account mirror without materializing its peers')

        const source = sources.get('alice')!
        source.state.meta.status = 'direct'
        await settle(source.state)
        ok(alice.state.meta.status == 'direct', 'selected account mirror follows its replay route')

        manager.stop('alice')
        ok(manager.handles.alice.status().state == 'stopped' && manager.get('alice') != null,
            'stopping a selected account detaches its route while retaining its local mirror for reuse')
        manager.stopAll()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
