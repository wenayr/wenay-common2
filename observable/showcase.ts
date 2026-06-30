// ===========================================================================
//  showcase.ts — Observable, the way you'd actually use it.
//
//  A story, not an API dump: "I want to watch a price on the frontend."
//  On the SERVER we keep state as a PLAIN OBJECT and mutate it plainly
//  (`state.price = 101`). On the FRONT we subscribe once and just receive
//  every change. Then: tabs (nested categories), replacing a whole tab at
//  once (only deltas travel), and several widgets sharing ONE server feed.
//
//  Every scene ends in an assert(), so this file is ALSO a living test —
//  if the convenience ever breaks, this goes red.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/showcase.ts
// ===========================================================================

import {createReactive, listen, listenValue, onKey} from './native'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createRpcClient, type RpcClientReturn} from '../src/Common/rcp/rpc-client'
import type {DeepSocketListen} from '../src/Common/rcp/listen-deep'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'

// Project the client onto its server shape: Listen-nodes become a typed
// `.on/.callback/.once` subscription surface (value types flow from the server).
// This is the idiomatic typed client — no `as any` at any call site.
function webListen<T extends object>(c: RpcClientReturn<T>) {
    return c.func as unknown as DeepSocketListen<T>
}

let fails = 0
function assert(cond: any, msg: string) {
    if (!cond) { fails++; console.log('   ❌ FAIL:', msg) }
    else console.log('   ✅', msg)
}
const J = (v: any) => JSON.stringify(v)
const delay = (ms = 0) => new Promise(r => setTimeout(r, ms))
const log = (...a: any[]) => console.log('  ', ...a)

// in-memory loopback that behaves like a real socket (JSON-cloned both ways)
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

    // =======================================================================
    //  SCENE 0 — purely local: it's just an object
    // =======================================================================
    console.log('\n━━ SCENE 0 — on the server it is just a normal object ━━')
    {
        // The whole app state. Plain nested object. Nothing special to learn.
        const state = createReactive({
            price: 100,
            account: {balances: {BTC: 1, ETH: 10}, leverage: 5},
        })

        // read it like an object
        log('state.price =', state.price)
        log('state.account.balances.BTC =', state.account.balances.BTC)

        // watch one field — a callback fires on every change
        const ticks: number[] = []
        onKey<number>(state, 'price', v => ticks.push(v))

        // mutate it like an object
        state.price = 101
        state.price = 102
        state.account.balances.BTC = 2          // nested write, just as plain

        assert(J(ticks) == '[101,102]', 'watching state.price saw 101,102 from plain `state.price = …`')
        assert(state.account.balances.BTC == 2, 'nested `state.account.balances.BTC = 2` stuck and reads back')
    }

    // =======================================================================
    //  SCENE 1 — the real thing: watch the price FROM THE FRONTEND
    // =======================================================================
    console.log('\n━━ SCENE 1 — front watches a server price (push, not polling) ━━')
    {
        // ── SERVER ──────────────────────────────────────────────
        const state = createReactive({price: 100})
        const server = {price: listenValue<number>(state, 'price')}   // expose the field as a stream
        const [cs, ss] = createLoopback()
        createRpcServerAuto({socket: ss, object: server, socketKey: 'md'})

        // ── FRONT ───────────────────────────────────────────────
        const front = createRpcClient<typeof server>({socket: cs, socketKey: 'md'})
        await delay(0)
        const screen: number[] = []
        const off = webListen(front).price.on(v => {           // v is typed `number`
            screen.push(v)
            log('FRONT received price →', v)                   // this is your UI update
        })
        await delay(10)

        // ── SERVER pushes new prices, just by assigning ─────────
        log('SERVER: state.price = 101')
        state.price = 101
        log('SERVER: state.price = 102')
        state.price = 102
        await delay(10)
        assert(J(screen) == '[101,102]', 'front received every server price change: ' + J(screen))

        // front closes the widget → server subscription goes away on its own
        off()
        await delay(10)
        state.price = 103
        await delay(10)
        assert(J(screen) == '[101,102]', 'after the front unsubscribes, no more updates arrive')
        assert(server.price.count() == 0, 'server feed is back to 0 subscribers (cheap again)')
    }

    // =======================================================================
    //  SCENE 2 — TABS: each part of the screen watches its own sub-category
    // =======================================================================
    console.log('\n━━ SCENE 2 — a dashboard with tabs, each tab watches its own slice ━━')
    {
        // ── SERVER: one nested state object, several tabs inside ─
        const state = createReactive<{
            price: number
            balances: Record<string, number>
            positions: Record<string, number>
        }>({price: 100, balances: {BTC: 1, ETH: 10}, positions: {}})

        const server = {
            price: listenValue<number>(state, 'price'),          // "Price" tab — a single field
            balances: listen<number>(state, 'balances'),         // "Balances" tab — (sym, amount) deltas
            positions: listen<number>(state, 'positions'),       // "Positions" tab — (sym, qty) deltas
        }
        const [cs, ss] = createLoopback()
        createRpcServerAuto({socket: ss, object: server, socketKey: 'dash'})

        // ── FRONT: open only the tabs you care about ────────────
        const front = createRpcClient<typeof server>({socket: cs, socketKey: 'dash'})
        await delay(0)
        const balancesTab = new Map<string, number>()    // the UI keeps a live mirror of the tab
        webListen(front).balances.on((sym, amt) => {     // sym: string, amt: number — both typed
            if (amt == null) balancesTab.delete(sym); else balancesTab.set(sym, amt)
            log('FRONT [Balances tab] ', sym, '→', amt)
        })
        await delay(10)

        // ── SERVER mutates the balances tab like a plain object ─
        log("SERVER: state.balances['BTC'] = 2")
        state.balances['BTC'] = 2                        // change one
        log("SERVER: state.balances['SOL'] = 3")
        state.balances['SOL'] = 3                        // add one
        log("SERVER: delete state.balances['ETH']")
        delete state.balances['ETH']                     // remove one (arrives as null)
        // a change on a DIFFERENT tab must not disturb the Balances tab
        state.price = 101
        state.positions['BTC'] = 0.5
        await delay(10)

        assert(J([...balancesTab]) == J([['BTC', 2], ['SOL', 3]]),
            'Balances tab mirror reflects set/add/delete and ignores other tabs: ' + J([...balancesTab]))
        assert(server.price.count() == 0, 'the Price tab feed has no subscribers (front never opened it)')
    }

    // =======================================================================
    //  SCENE 3 — replace a WHOLE tab at once → only the deltas travel
    // =======================================================================
    console.log('\n━━ SCENE 3 — server gets a fresh snapshot, assigns the whole tab, only changes go over the wire ━━')
    {
        // ── SERVER ──────────────────────────────────────────────
        const state = createReactive<{balances: Record<string, number>}>({balances: {BTC: 1, ETH: 10}})
        const server = {balances: listen<number>(state, 'balances')}
        const [cs, ss] = createLoopback()
        createRpcServerAuto({socket: ss, object: server, socketKey: 'snap'})

        // ── FRONT ───────────────────────────────────────────────
        const front = createRpcClient<typeof server>({socket: cs, socketKey: 'snap'})
        await delay(0)
        const overTheWire: [string, number | null][] = []
        webListen(front).balances.on((sym, amt) => {       // sym: string, amt: number — typed
            overTheWire.push([sym, amt])
        })
        await delay(10)

        // The exchange just handed us a brand-new balances object. We don't diff
        // by hand — we just assign it. The store diffs; only what changed is sent.
        log('SERVER: state.balances = { BTC:1, ETH:11, SOL:3 }   (BTC same, ETH changed, SOL new)')
        state.balances = {BTC: 1, ETH: 11, SOL: 3}
        await delay(10)

        assert(J(overTheWire) == J([['ETH', 11], ['SOL', 3]]),
            'only ETH (changed) + SOL (new) crossed the wire — BTC was unchanged and stayed silent: ' + J(overTheWire))
    }

    // =======================================================================
    //  SCENE 4 — several widgets, ONE server feed (shared subscription)
    // =======================================================================
    console.log('\n━━ SCENE 4 — three widgets on the page watch the same price, server sees ONE subscription ━━')
    {
        // ── SERVER ──────────────────────────────────────────────
        const state = createReactive({price: 100})
        const server = {price: listenValue<number>(state, 'price')}
        const [cs, ss] = createLoopback()
        createRpcServerAuto({socket: ss, object: server, socketKey: 'shared'})

        // ── FRONT: one connection, three UI widgets subscribing ─
        const front = createRpcClient<typeof server>({socket: cs, socketKey: 'shared'})
        await delay(0)
        const header: number[] = [], chart: number[] = [], ticker: number[] = []
        const price = webListen(front).price                 // the typed feed, shared by widgets
        const offHeader = price.on(v => header.push(v))
        const offChart = price.on(v => chart.push(v))
        price.on(v => ticker.push(v))
        await delay(10)

        state.price = 101
        await delay(10)
        assert(header[0] == 101 && chart[0] == 101 && ticker[0] == 101, 'all three widgets got the update')
        assert(server.price.count() == 1, 'but the SERVER has only ONE subscription for all three widgets (deduped)')

        // close two widgets — the third keeps working, server still 1 subscription
        offHeader(); offChart()
        await delay(10)
        state.price = 102
        await delay(10)
        assert(J(ticker) == '[101,102]' && J(header) == '[101]', 'closing two widgets leaves the third live')
        assert(server.price.count() == 1, 'server still holds exactly one subscription for the surviving widget')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅  — this is how it should feel.' : fails + ' FAILURE(S) ❌'}`)
    return fails
}

main().then(f => process.exit(f == 0 ? 0 : 1))
