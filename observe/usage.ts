// ============================================================
//  observe/usage.ts
//
//  Локальные self-check примеры для Observe / reactive.
//  Запуск:
//      npx tsx observe/usage.ts
// ============================================================

import {flushReactive, onUpdate, onUpdatePaths, reactive} from './reactive'
import {createStore, createStoreMirror, exposeStore} from './store'

type Coin = 'BTC' | 'ETH' | 'SOL' | 'DOT' | 'ADA'

type Position = {
    qty: number
    entry: number
}

type AccountState = {
    account: {
        balances: Partial<Record<Coin, number>>
        positions: Partial<Record<Coin, Position>>
    }
}

type Strategy = {
    status: boolean
    limit: number
}

type StrategyStore = {
    strategies: Record<string, Strategy>
    meta: {status: string}
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const coinKeys = (positions: Partial<Record<Coin, Position>>) => Object.keys(positions).sort()
const strategyKeys = (state: StrategyStore) => Object.keys(state.strategies).sort()
const pathText = (path: PropertyKey[]) => path.map(String).join('.') || '<self>'
const json = (v: any) => JSON.stringify(v)

function section(title: string) {
    console.log(`\n${title}`)
}

function scenario(title: string, expected: string) {
    console.log(`\n  ${title}`)
    console.log(`  ожидаем: ${expected}`)
}

function expectEq(label: string, got: any, expected: any) {
    const g = json(got)
    const e = json(expected)
    console.log(`  ${label}:`, g)
    if (g !== e) throw new Error(`${label}: expected ${e}, got ${g}`)
    console.log('  OK')
}

function expectThrow(label: string, fn: () => void, expectedPart: string) {
    console.log(`\n  ${label}`)
    console.log(`  ожидаем: ошибка содержит "${expectedPart}"`)
    let message = ''
    try { fn() }
    catch (e: any) { message = String(e?.message ?? e) }
    console.log('  получили:', message || '<ошибки не было>')
    if (!message.includes(expectedPart)) throw new Error(`${label}: expected error containing ${expectedPart}, got ${message}`)
    console.log('  OK')
}

async function waitFor(label: string, ok: () => boolean) {
    for (let i = 0; i < 50; i++) {
        if (ok()) return
        await tick()
    }
    throw new Error(`timeout: ${label}`)
}

async function localReactiveAddDelete() {
    section('[1] Локально: add/delete в reactive object')

    const state = reactive<AccountState>({
        account: {
            balances: {BTC: 100},
            positions: {BTC: {qty: 0.5, entry: 60000}},
        },
    }, {drain: 'micro'})

    let positionsEvents = 0
    let lastPaths: string[] = []

    onUpdate(state.account.positions, () => {
        positionsEvents++
        console.log('  событие positions, keys =', coinKeys(state.account.positions).join(',') || '-')
    })
    onUpdatePaths(state.account.positions, change => {
        lastPaths = change.paths.map(pathText).sort()
        console.log('  dirty paths =', lastPaths.join(',') || '-')
    })

    scenario('case A: добавляем SOL', 'keys = BTC,SOL; dirty path = SOL; positionsEvents = 1')
    positionsEvents = 0
    lastPaths = []
    state.account.positions.SOL = {qty: 10, entry: 130}
    await flushReactive(state)
    expectEq('keys после add', coinKeys(state.account.positions), ['BTC', 'SOL'])
    expectEq('dirty paths после add', lastPaths, ['SOL'])
    expectEq('events после add', positionsEvents, 1)

    scenario('case B: удаляем BTC', 'keys = SOL; dirty path = BTC; positionsEvents = 1')
    positionsEvents = 0
    lastPaths = []
    delete state.account.positions.BTC
    await flushReactive(state)
    expectEq('keys после delete', coinKeys(state.account.positions), ['SOL'])
    expectEq('dirty paths после delete', lastPaths, ['BTC'])
    expectEq('events после delete', positionsEvents, 1)
}

async function localMirrorAddDelete() {
    section('[2] Локально: backend store -> mirror store без сети')

    const backend = createStore<StrategyStore>({
        strategies: {alpha: {status: false, limit: 100}},
        meta: {status: 'ok'},
    }, {drain: 'micro'})

    const exposed = exposeStore(backend)
    const pulls: any[] = []
    const api = {
        ...exposed,
        get(mask?: any) {
            pulls.push(mask)
            console.log('  mirror pull mask =', json(mask))
            return exposed.get(mask)
        },
    }

    const mirror = createStoreMirror<StrategyStore>(api, {strategies: {}, meta: {status: ''}}, {drain: 'micro'})
    const stopSync = await mirror.sync({strategies: true}, {current: true, drain: 'micro'})
    await waitFor('initial mirror sync', () => 'alpha' in mirror.state.strategies)
    pulls.length = 0

    const stopUi = mirror.node.strategies.on(() => {
        console.log('  UI видит strategies keys =', strategyKeys(mirror.state).join(',') || '-')
    }, {current: true, drain: 'micro'})

    scenario('case A: backend добавляет beta', 'mirror увидит alpha,beta; подтянется только mask {strategies:{beta:true}}')
    backend.state.strategies.beta = {status: true, limit: 200}
    await flushReactive(backend.state)
    await waitFor('mirror got beta', () => 'beta' in mirror.state.strategies)
    await flushReactive(mirror.state)
    expectEq('mirror keys после add', strategyKeys(mirror.state), ['alpha', 'beta'])
    expectEq('последний pull mask после add', pulls[pulls.length - 1], {strategies: {beta: true}})

    scenario('case B: backend удаляет beta', 'mirror удалит beta; подтянется тот же точечный mask {strategies:{beta:true}}')
    pulls.length = 0
    delete backend.state.strategies.beta
    await flushReactive(backend.state)
    await waitFor('mirror removed beta', () => !('beta' in mirror.state.strategies))
    await flushReactive(mirror.state)
    expectEq('mirror keys после delete', strategyKeys(mirror.state), ['alpha'])
    expectEq('последний pull mask после delete', pulls[pulls.length - 1], {strategies: {beta: true}})

    stopUi()
    stopSync()
}

function missingKeyCases() {
    section('[3] Если обращаемся туда, чего нет')

    const state = reactive<AccountState>({
        account: {
            balances: {},
            positions: {},
        },
    })

    expectThrow('case A: onUpdate(state.account.positions.BTC!, ...)', () => {
        onUpdate(state.account.positions.BTC!, () => {})
    }, 'onUpdate: not a reactive object')

    expectThrow('case B: state.account.positions.BTC!.qty = 0.7', () => {
        state.account.positions.BTC!.qty = 0.7
    }, "Cannot set properties of undefined")

    console.log('\n  вывод: `!` не создает объект. Если ключ может отсутствовать, сначала делаем:')
    console.log('  state.account.positions.BTC = {qty: 0.7, entry: 60000}')
}

async function main() {
    await localReactiveAddDelete()
    await localMirrorAddDelete()
    missingKeyCases()
    console.log('\nALL OK: local usage examples passed')
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
