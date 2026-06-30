// ============================================================
//  observable2/usage.ts
//
//  Typed examples for ObserveAll2 / reactive2.
//  Run:
//      npx tsx observable2/usage.ts
// ============================================================

import {flushReactive, listenUpdate, onUpdate, reactive} from './reactive2'

type Coin = 'BTC' | 'ETH' | 'SOL' | 'DOT' | 'ADA'

type Position = {
    qty: number
    entry: number
}

type AccountState = {
    account: {
        balances: Partial<Record<Coin, number>>
        positions: Partial<Record<Coin, Position>>
        risk: {
            enabled: boolean
            maxLoss: number
        }
    }
    market: {
        last: Partial<Record<Coin, number>>
    }
}

const sum = (o: Partial<Record<Coin, number>>) =>
    Object.values(o).reduce((a, b) => a + (b ?? 0), 0)

async function nestedPathSubscriptions() {
    console.log('\n[1] Different access levels')

    const state = reactive<AccountState>({
        account: {
            balances: {BTC: 100, ETH: 400},
            positions: {BTC: {qty: 0.5, entry: 60000}},
            risk: {enabled: true, maxLoss: 50},
        },
        market: {
            last: {BTC: 61000},
        },
    })

    let root = 0
    let account = 0
    let balances = 0
    let positions = 0
    let btcPosition = 0
    let market = 0

    onUpdate(state, () => { root++; console.log('  root') })
    onUpdate(state.account, () => { account++; console.log('  account') })
    onUpdate(state.account.balances, () => {
        balances++
        console.log('  balances total =', sum(state.account.balances))
    })
    onUpdate(state.account.positions, () => {
        positions++
        console.log('  positions keys =', Object.keys(state.account.positions))
    })
    onUpdate(state.account.positions.BTC!, () => {
        btcPosition++
        console.log('  BTC position qty =', state.account.positions.BTC?.qty)
    })
    onUpdate(state.market, () => { market++; console.log('  market') })

    state.account.positions.BTC!.qty = 0.7
    await flushReactive(state)
    console.log('  after BTC qty:', {root, account, balances, positions, btcPosition, market})

    state.account.balances.BTC = 120
    await flushReactive(state)
    console.log('  after balance:', {root, account, balances, positions, btcPosition, market})

    state.market.last.BTC = 62000
    await flushReactive(state)
    console.log('  after market:', {root, account, balances, positions, btcPosition, market})
}

async function replacementKeepsPathSubscriptions() {
    console.log('\n[2] Whole-branch replacement keeps path subscriptions')

    const state = reactive<AccountState>({
        account: {
            balances: {BTC: 100, ETH: 400},
            positions: {BTC: {qty: 0.5, entry: 60000}},
            risk: {enabled: true, maxLoss: 50},
        },
        market: {
            last: {},
        },
    })

    let account = 0
    let positions = 0
    let btc = 0

    onUpdate(state.account, () => {
        account++
        console.log('  account snapshot:', JSON.stringify(state.account))
    })
    onUpdate(state.account.positions, () => {
        positions++
        console.log('  positions snapshot:', JSON.stringify(state.account.positions))
    })
    onUpdate(state.account.positions.BTC!, () => {
        btc++
        console.log('  BTC snapshot:', JSON.stringify(state.account.positions.BTC))
    })

    state.account.positions = {
        BTC: {qty: 3, entry: 59000},
        SOL: {qty: 10, entry: 130},
    }
    await flushReactive(state)

    state.account.positions.BTC!.qty = 5
    await flushReactive(state)

    console.log('  counters:', {account, positions, btc})
}

async function drainModes() {
    console.log('\n[3] Await settled batches and choose drain')

    const micro = reactive({price: 0}, {drain: 'micro'})
    let microHits = 0
    onUpdate(micro, () => microHits++)
    micro.price = 1
    micro.price = 2
    micro.price = 3
    await flushReactive(micro)
    console.log('  micro:', {microHits, price: micro.price})

    const throttled = reactive({price: 0}, {drain: 50})
    let throttleHits = 0
    onUpdate(throttled, () => throttleHits++)
    for (let i = 1; i <= 1000; i++) throttled.price = i
    await flushReactive(throttled)
    console.log('  throttle:', {throttleHits, price: throttled.price})
}

async function eagerAbsoluteReactivity() {
    console.log('\n[4] Eager / absolute wrapping')

    const state = reactive<AccountState>({
        account: {
            balances: {BTC: 100},
            positions: {BTC: {qty: 1, entry: 60000}},
            risk: {enabled: true, maxLoss: 50},
        },
        market: {
            last: {BTC: 61000},
        },
    }, {eager: true})

    let riskHits = 0
    let btcHits = 0

    onUpdate(state.account.risk, () => {
        riskHits++
        console.log('  risk:', JSON.stringify(state.account.risk))
    })
    onUpdate(state.account.positions.BTC!, () => {
        btcHits++
        console.log('  BTC:', JSON.stringify(state.account.positions.BTC))
    })

    state.account.risk.maxLoss = 75
    state.account.positions.BTC!.entry = 60500
    await flushReactive(state)

    console.log('  counters:', {riskHits, btcHits})
}

async function optionalDepthLimit() {
    console.log('\n[5] Optional depth limit')

    const shallow = reactive<AccountState>({
        account: {
            balances: {BTC: 100},
            positions: {BTC: {qty: 1, entry: 60000}},
            risk: {enabled: true, maxLoss: 50},
        },
        market: {
            last: {},
        },
    }, {depth: 2})

    let accountHits = 0
    onUpdate(shallow.account, () => accountHits++)

    shallow.account.positions.BTC!.qty = 2
    await flushReactive(shallow)
    console.log('  opaque deep write:', {accountHits})

    shallow.account.positions.BTC = {qty: 3, entry: 59000}
    await flushReactive(shallow)
    console.log('  replace at reactive level:', {accountHits})
}

async function rpcFacadeExample() {
    console.log('\n[6] RPC facade shape')

    const state = reactive<AccountState>({
        account: {
            balances: {BTC: 100},
            positions: {BTC: {qty: 1, entry: 60000}},
            risk: {enabled: true, maxLoss: 50},
        },
        market: {
            last: {},
        },
    })

    const facade = {
        getAccount: () => state.account,
        accountChanged: listenUpdate(state.account),
        positionsChanged: listenUpdate(state.account.positions),
        btcChanged: listenUpdate(state.account.positions.BTC!),
    }

    console.log('  expose this object through createRpcServerAuto:', Object.keys(facade))
    let btcEvents = 0
    const off = facade.btcChanged.addListen(() => btcEvents++)
    state.account.positions.BTC!.qty = 2
    await flushReactive(state)
    off()
    console.log('  btcChanged Listen events:', btcEvents)
}

async function main() {
    await nestedPathSubscriptions()
    await replacementKeepsPathSubscriptions()
    await drainModes()
    await eagerAbsoluteReactivity()
    await optionalDepthLimit()
    await rpcFacadeExample()
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
