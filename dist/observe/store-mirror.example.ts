// Run:
//   npx tsx observe/store-mirror.example.ts

import {createStore, createStoreMirror, exposeStore} from './store'
import {flushReactive} from './reactive'

type SymbolRef = {exchange: string; category: string; symbol: string}
type Strategy = {
    name: string
    strategyName: string
    symbols: SymbolRef[]
    params: any
    paramsRun: any
    status: boolean
    show: boolean
}
type StrategyStore = {strategies: Record<string, Strategy>}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const keys = (store: StrategyStore) => Object.keys(store.strategies).sort().join(',') || '-'

async function settle(state: object) {
    await flushReactive(state)
    await tick()
    await tick()
}

async function main() {
    // Backend: ordinary mutable control state.
    const backend = createStore<StrategyStore>({strategies: {}}, {drain: 'micro'})

    // API shape: get/set/replace + changed + changedPaths.
    // Over RPC the frontend receives the same shape from the SDK client.
    const exposed = exposeStore(backend)
    const api = {
        ...exposed,
        get(mask?: any) {
            console.log('pull', JSON.stringify(mask))
            return exposed.get(mask)
        },
    }

    // Frontend: local mirror. UI subscribes locally, not to the network stream.
    const mirror = createStoreMirror<StrategyStore>(api, {strategies: {}}, {drain: 'micro'})
    const stopSync = await mirror.sync({strategies: true}, {current: true, drain: 'micro'})
    const stopUi = mirror.node.strategies.on(() => {
        console.log('ui strategies:', keys(mirror.state))
    }, {current: true, drain: 'micro'})

    backend.state.strategies.alpha = {
        name: 'alpha',
        strategyName: 'meanReversion',
        symbols: [{exchange: 'binance', category: 'spot', symbol: 'BTCUSDT'}],
        params: {period: 20},
        paramsRun: {},
        status: false,
        show: true,
    }
    await settle(backend.state)

    backend.state.strategies.alpha.status = true
    await settle(backend.state)

    delete backend.state.strategies.alpha
    await settle(backend.state)

    stopUi()
    stopSync()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})