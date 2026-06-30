// ===========================================================================
// DISPOSABLE ORACLE — launch-gap proof. Delete after the launch gate.
//
// Proves the ONE unverified launch gap: subscribe to a LARGE keyed observable
// collection (~1000 keys) over REAL RPC (real server + real client across an
// in-memory socket pair, JSON-cloned exactly like a real wire), then on UPDATES
// verify the client mirror stays correct — exact deltas, nothing lost or
// duplicated — and that the server holds EXACTLY ONE wire subscriber.
//
// Scenarios: (1) point update, (2) add, (3) delete, (4) FULL REPLACE / Binance
// diff-on-replace, (5) rapid burst, plus the dedupe invariant (a 2nd local
// consumer shares one wire sub; last leaver triggers the wire stop).
//
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/bulk-rpc.test.ts
// ===========================================================================

import {createTransportStore} from './store'
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

// loopback transport (JSON-cloned, like a real socket) — copied verbatim from the harness
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

// ── client-side mirror — rebuilt purely from the (key,value) deltas the wire
//    delivers; value==null means delete. This is what "the client mirror" means:
//    the remote consumer never sees the server Map, only the delta stream. ──
function applyDelta(mirror: Map<string, number>, k: string, v: any) {
    if (v == null) mirror.delete(k)
    else mirror.set(k, v)
}
function mapsEqual(a: Map<string, number>, b: Map<string, number>) {
    if (a.size != b.size) return false
    for (const [k, v] of a) if (!b.has(k) || b.get(k) != v) return false
    return true
}

const N = 1000

async function main() {
    console.log('\n[bulk-rpc] boot real server + client over loopback, expose a ~' + N + '-key store via .listen()')

    // server-side source: a large keyed reactive collection
    const init: Record<string, number> = {}
    for (let i = 0; i < N; i++) init['k' + i] = i
    const store = createTransportStore(init)
    // a server-side mirror of truth, kept in lockstep with our own mutations,
    // so the client mirror can be compared against the real current collection
    const truth = new Map<string, number>(Object.entries(init))

    const [cs, ss] = createLoopback()
    createRpcServerAuto({
        socket: ss,
        object: {bulk: store.listen()},   // whole-collection direct-child delta stream
        socketKey: 'rpc',
    })
    const c = createRpcClient<any>({socket: cs, socketKey: 'rpc'})
    await delay(0)   // let the Pkt.MAP handshake arrive

    // remote consumer #1 — fan the (key,value) deltas into a client mirror.
    //
    // NOTE on .listen() semantics: it is a FUTURE-deltas-only stream (no current
    // replay over the wire — confirmed: the wire is silent on subscribe, asserted
    // below). A real consumer therefore pairs an INITIAL SNAPSHOT with the live
    // delta stream. We model that here: seed the mirror from the snapshot the
    // server holds at subscribe time, then let deltas keep it correct. The gap
    // under test is "on UPDATES everything stays correct", so updates — not the
    // initial fetch — are what the deltas must prove.
    const deltas1: [string, any][] = []
    const mirror = new Map<string, number>(Object.entries(init))   // initial snapshot
    const sub1: any = (c.func as any).bulk.callback((k: string, v: any) => {
        deltas1.push([k, v])
        applyDelta(mirror, k, v)
    })
    await delay(10)

    // .listen() carries FUTURE deltas only (no current replay), so the wire is
    // silent on subscribe; that is the contract we mirror against below.
    assert(deltas1.length == 0, 'subscribe is new-updates-only (no current replay over .listen()): got ' + deltas1.length)
    assert(store.listen().count() == 1, 'EXACTLY ONE wire subscriber on the server after subscribe')

    // ── 1. POINT UPDATE: set one existing key → exactly one delta ──
    console.log('\n[1] point update')
    {
        const before = deltas1.length
        store.set('k7', 999); truth.set('k7', 999)
        await delay(10)
        const got = deltas1.slice(before)
        assert(J(got) == J([['k7', 999]]), 'exactly one delta for the changed key: ' + J(got))
    }

    // ── 2. ADD: a brand-new key → exactly that add ──
    console.log('\n[2] add a brand-new key')
    {
        const before = deltas1.length
        store.set('k' + N, 4242); truth.set('k' + N, 4242)
        await delay(10)
        const got = deltas1.slice(before)
        assert(J(got) == J([['k' + N, 4242]]), 'exactly one add delta: ' + J(got))
    }

    // ── 3. DELETE: remove a key → exactly that removal (value null) ──
    console.log('\n[3] delete a key')
    {
        const before = deltas1.length
        store.delete('k3'); truth.delete('k3')
        await delay(10)
        const got = deltas1.slice(before)
        assert(J(got) == J([['k3', null]]), 'exactly one delete delta (value null): ' + J(got))
    }

    // ── 4. FULL REPLACE (the Binance case): only changed/added/removed keys
    //       emit; unchanged keys stay silent; client mirror ends == new map ──
    console.log('\n[4] FULL REPLACE — diff-on-replace, only deltas fire')
    {
        // build a fresh whole map: keep most keys identical, change a handful,
        // add some new ones, drop some old ones — so the diff is non-trivial.
        const next = new Map<string, number>()
        for (let i = 0; i < N; i++) next.set('k' + i, i)   // baseline identical to ORIGINAL seed
        // re-apply the live mutations we already made so "unchanged" is truthful
        // vs the CURRENT collection (k7=999, k1000 added, k3 deleted):
        next.set('k7', 999)            // unchanged vs current → must stay silent
        next.set('k' + N, 4242)        // unchanged vs current → must stay silent
        next.delete('k3')              // still absent → silent
        // now the genuine changes for THIS replace:
        next.set('k10', -10)           // changed
        next.set('k20', -20)           // changed
        next.set('newA', 1)            // added
        next.set('newB', 2)            // added
        next.delete('k500')            // removed (was present)
        next.delete('k0')              // removed (was present)

        const before = deltas1.length
        store.replace(next)
        // keep the truth in lockstep with the replace
        truth.clear()
        for (const [k, v] of next) truth.set(k, v)
        await delay(10)

        const got = deltas1.slice(before)
        // expected delta MULTISET (order across a Map iteration is insertion order;
        // we assert as a set to be robust to emit ordering).
        const expected = new Map<string, any>([
            ['k10', -10], ['k20', -20], ['newA', 1], ['newB', 2],
            ['k500', null], ['k0', null],
        ])
        assert(got.length == expected.size, 'replace fired ONLY the ' + expected.size + ' changed/added/removed keys (not all): got ' + got.length)
        let allMatch = got.length == expected.size
        const seenKeys = new Set<string>()
        for (const [k, v] of got) {
            if (!expected.has(k) || expected.get(k) !== v) allMatch = false
            if (seenKeys.has(k)) allMatch = false   // no duplicate key in one replace
            seenKeys.add(k)
        }
        assert(allMatch, 'replace deltas are exactly the diff, no dup/extra: ' + J(got))
        assert(mapsEqual(mirror, truth), 'client mirror == new collection after replace (size ' + mirror.size + ' vs ' + truth.size + ')')
    }

    // ── 5. RAPID BURST: N point updates → all N in order, no loss/dup ──
    console.log('\n[5] rapid burst of point updates')
    {
        const BURST = 300
        const before = deltas1.length
        for (let i = 0; i < BURST; i++) { store.set('k1', i); truth.set('k1', i) }
        await delay(10)
        const got = deltas1.slice(before)
        assert(got.length == BURST, 'all ' + BURST + ' burst deltas delivered (no loss): ' + got.length)
        let inOrder = got.length == BURST
        for (let i = 0; i < got.length; i++) if (J(got[i]) != J(['k1', i])) inOrder = false
        assert(inOrder, 'burst deltas arrived in order, no dup: first=' + J(got[0]) + ' last=' + J(got[got.length - 1]))
        assert(mapsEqual(mirror, truth), 'client mirror still == collection after burst')
    }

    // ── final mirror integrity across EVERYTHING ──
    console.log('\n[mirror] full integrity check')
    assert(mapsEqual(mirror, truth), 'client mirror exactly mirrors the server collection (size ' + mirror.size + ')')

    // ── DEDUPE INVARIANT: a 2nd local consumer shares ONE wire sub ──
    console.log('\n[dedupe] second consumer shares one wire subscriber')
    {
        const deltas2: [string, any][] = []
        const sub2: any = (c.func as any).bulk.callback((k: string, v: any) => deltas2.push([k, v]))
        await delay(10)
        assert(store.listen().count() == 1, 'STILL exactly one wire subscriber with two local consumers')

        store.set('k2', 77); truth.set('k2', 77)
        await delay(10)
        // both consumers see the same delta (fan-out)
        assert(J(deltas1[deltas1.length - 1]) == J(['k2', 77]), 'consumer #1 got the delta')
        assert(J(deltas2[deltas2.length - 1]) == J(['k2', 77]), 'consumer #2 (shared) got the same delta')

        // first consumer leaves → wire stays up (one consumer remains)
        sub1.unsubscribe?.()
        await delay(10)
        assert(store.listen().count() == 1, 'wire still up after first consumer leaves (one remains)')

        // last consumer leaves → wire STOP fires, server-side subscriber freed
        sub2.unsubscribe?.()
        await delay(10)
        assert(store.listen().count() == 0, 'last consumer leaving triggers wire stop (server back to 0 subscribers)')

        // a post-stop mutation reaches nobody
        const d1 = deltas1.length, d2 = deltas2.length
        store.set('k4', -1)
        await delay(10)
        assert(deltas1.length == d1 && deltas2.length == d2, 'no deltas delivered after the wire stopped')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    return fails
}

main().then(f => process.exit(f == 0 ? 0 : 1))
