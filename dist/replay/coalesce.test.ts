// ============================================================
//  replay/coalesce.test.ts
//
//  Layer D: key-level coalescing in conflateReplay (opts.keyOf).
//  While client lags — map "key → latest envelope", recovery
//  via tail of coalesced deltas instead of full keyframe; non-keyed event
//  or maxKeys overflow → degrade to keyframe recovery.
//  Part 1 — generic wire (ticks by symbol), part 2 — degradations,
//  part 3 — store mirror with storePatchKey (including nested paths).
//  Run:
//      npx ts-node replay/coalesce.test.ts
// ============================================================

import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {replayListen, replaySubscribe, ReplayRemote, conflateReplay} from '../src/Common/events/replay-index'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)
const ascendingUnique = (seqs: number[]) => seqs.every((s, i) => i == 0 || s > seqs[i - 1])

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 120; i++) {
        if (cond()) return
        await delay(10)
    }
    throw new Error(`timeout: ${label}`)
}

type Msg =
    | {type: 'tick', sym: string, px: number}
    | {type: 'snap', all: Record<string, number>}

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
}

async function main() {
    console.log('\n[coalesce] generic line: last-per-key tail instead of a full keyframe')
    {
        const state: Record<string, number> = {}
        const [emit, replay] = replayListen<[Msg]>({
            current: () => [{type: 'snap', all: {...state}}],
            history: 1000,
        })
        const tick = (sym: string, px: number) => { state[sym] = px; emit({type: 'tick', sym, px}) }
        const buf = {v: 0}
        const gated = conflateReplay(replay, {
            pending: () => buf.v, highWater: 5, pollMs: 10,
            keyOf: m => m.type == 'tick' ? m.sym : null,
        })
        let envelopes = 0
        const remote: ReplayRemote<[Msg]> = {
            line: {on: (cb: any) => gated.api.line.on((ev: any) => { envelopes++; cb(ev) })},
            since: s => gated.api.since(s),
            keyframe: () => gated.api.keyframe(),
        }
        const book: Record<string, number> = {}
        const got: Msg[] = []
        const seqs: number[] = []
        const sub = replaySubscribe(remote, function applyMsg(m: Msg) {
            got.push(m)
            if (m.type == 'snap') { for (const k of Object.keys(book)) delete book[k]; Object.assign(book, m.all) }
            else book[m.sym] = m.px
        }, {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(got.length == 1 && got[0].type == 'snap', 'fresh subscriber got the snap keyframe')

        tick('A', 100)
        tick('B', 200)
        ok(json(book) == json(state), 'below highWater ticks pass through untouched')
        const s0 = gated.stats()
        ok(s0.coalesced == 0 && s0.flushes == 0 && s0.keyframes == 0, 'gate was transparent so far')

        // ============ congestion: ticks coalesce by symbol, client — silence ============
        buf.v = 10
        for (let px = 101; px <= 105; px++) tick('A', px)   // 5 ticks of same key
        tick('B', 201)
        tick('A', 106)
        ok(book['A'] == 100 && book['B'] == 200, 'over highWater: nothing reaches the client')
        ok(gated.stats().conflating, 'gate is conflating')
        ok(gated.stats().coalesced == 5, `5 ticks of A superseded in place (coalesced=${gated.stats().coalesced})`)

        // ============ buffer drained in silence → tail of latest values, NOT keyframe ============
        const envBefore = envelopes
        buf.v = 0
        await waitFor('poll flush', () => book['A'] == 106)
        ok(book['A'] == 106 && book['B'] == 201, 'client converged to last values')
        ok(envelopes - envBefore == 2, `7 missed ticks collapsed into 2 envelopes (got ${envelopes - envBefore})`)
        ok(gated.stats().flushes == 1 && gated.stats().keyframes == 0, 'recovery was a coalesced tail, no keyframe')
        ok(!got.some(m => m.type == 'tick' && m.sym == 'A' && m.px > 100 && m.px < 106), 'intermediate A values never crossed the wire')

        tick('A', 107)
        ok(book['A'] == 107, 'live ticks resume after recovery')

        // ============ recovery by the next event itself, no polling wait ============
        buf.v = 10
        tick('C', 1)
        ok(book['C'] == null, 'tick while conflating is held, not delivered')
        buf.v = 0
        tick('D', 2)
        ok(book['C'] == 1 && book['D'] == 2, 'drained + next event → tail flushed immediately, incl. that event')
        ok(gated.stats().flushes == 2 && gated.stats().keyframes == 0, 'again a tail, not a keyframe')

        ok(ascendingUnique(seqs), `delivered seqs strictly ascending: ${seqs.join(',')}`)

        // ============ non-keyed event → episode degrades to keyframe ============
        buf.v = 10
        tick('E', 5)
        emit({type: 'snap', all: {...state}})   // keyOf → null: cannot coalesce
        const envBeforeKf = envelopes
        buf.v = 0
        tick('F', 6)
        ok(gated.stats().keyframes == 1, 'unkeyable event degraded the episode to keyframe recovery')
        ok(envelopes - envBeforeKf == 1, `recovery cost exactly 1 envelope (got ${envelopes - envBeforeKf})`)
        ok(book['E'] == 5 && book['F'] == 6 && json(book) == json(state), 'keyframe covered both held and unkeyable events')

        // ============ close: gate is dead forever ============
        const before = got.length
        gated.close()
        tick('G', 7)
        ok(got.length == before, 'after close() nothing reaches the client')
        sub()
    }

    console.log('\n[coalesce] maxKeys overflow degrades to keyframe; killer property holds')
    {
        const state: Record<string, number> = {}
        const [emit, replay] = replayListen<[Msg]>({
            current: () => [{type: 'snap', all: {...state}}],
            history: 100,
        })
        const tick = (sym: string, px: number) => { state[sym] = px; emit({type: 'tick', sym, px}) }
        const buf = {v: 10}
        const gated = conflateReplay(replay, {
            pending: () => buf.v, highWater: 5, pollMs: 10,
            keyOf: m => m.type == 'tick' ? m.sym : null,
            maxKeys: 2,
        })
        const book: Record<string, number> = {}
        const sub = replaySubscribe<[Msg]>(
            {line: gated.api.line, since: s => gated.api.since(s), keyframe: () => gated.api.keyframe()},
            m => { if (m.type == 'snap') Object.assign(book, m.all); else book[m.sym] = m.px })
        await sub.ready
        tick('A', 1); tick('B', 2); tick('C', 3)   // third key does not fit in map
        buf.v = 0
        await waitFor('keyframe recovery', () => book['C'] == 3)
        ok(gated.stats().keyframes == 1 && gated.stats().flushes == 0, 'over maxKeys → one keyframe, memory stays bounded by keys')
        ok(json(book) == json(state), 'client converged via the keyframe')
        sub(); gated.close()
    }

    console.log('\n[coalesce] close() mid-episode: held tail dies with the gate')
    {
        const state: Record<string, number> = {}
        const [emit, replay] = replayListen<[Msg]>({
            current: () => [{type: 'snap', all: {...state}}],
            history: 100,
        })
        const tick = (sym: string, px: number) => { state[sym] = px; emit({type: 'tick', sym, px}) }
        const buf = {v: 10}
        const gated = conflateReplay(replay, {
            pending: () => buf.v, highWater: 5, pollMs: 10,
            keyOf: m => m.type == 'tick' ? m.sym : null,
        })
        const book: Record<string, number> = {}
        let delivered = 0
        const sub = replaySubscribe<[Msg]>(
            {line: gated.api.line, since: s => gated.api.since(s), keyframe: () => gated.api.keyframe()},
            m => { delivered++; if (m.type == 'snap') Object.assign(book, m.all); else book[m.sym] = m.px })
        await sub.ready
        const base = delivered
        tick('A', 1); tick('B', 2)
        ok(gated.stats().conflating, 'episode is holding a key map')

        gated.close()   // disconnect mid-episode: map dies with gate
        buf.v = 0
        await delay(60)   // polling stopped by close() — no recovery
        tick('C', 3)      // and events no longer pass through the gate (wire log continues)
        ok(delivered == base && book['A'] == null, 'nothing leaks after close(): no tail, no keyframe, no live')
        ok(json(gated.stats()) == json({conflating: true, dropped: 0, keyframes: 0, coalesced: 0, flushes: 0}), 'stats frozen at close time')
        sub()
    }

    console.log('\n[coalesce] store mirror: only changed keys travel, nested paths stay exact')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}, b: {hp: 50, x: 5}}, tick: 0}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 200})
        const buf = {v: 0}
        const gated = conflateReplay(exposed.replay, {
            pending: () => buf.v, highWater: 3, pollMs: 10,
            keyOf: patches => patches.length == 1 ? JSON.stringify(patches[0].path) : null,
        })
        let envelopes = 0
        const remote: ReplayRemote<any> = {
            line: {on: (cb: any) => gated.api.line.on((ev: any) => { envelopes++; cb(ev) })},
            since: async s => { await delay(10); return gated.api.since(s) },
            keyframe: async () => { await delay(10); return gated.api.keyframe() },
        }
        const mirror = createStore<World>({units: {}, tick: -1})
        const seqs: number[] = []
        const sub = syncStoreReplay(mirror, remote, {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'fresh mirror converged via keyframe')

        // ============ client stalled: 20 patches of two paths → 2 envelopes ============
        buf.v = 50
        for (let i = 1; i <= 10; i++) {
            backend.state.units['a'].hp = 100 + i
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        ok(mirror.state.tick == 0, 'stalled client got NO deltas')
        const envBefore = envelopes
        buf.v = 0
        await waitFor('coalesced recovery', () => mirror.state.tick == 10)
        ok(json(mirror.state) == json(backend.snapshot()), 'recovered mirror equals backend')
        ok(envelopes - envBefore == 1, `10 multi-patch V2 envelopes collapsed into one keyframe (got ${envelopes - envBefore})`)
        ok(gated.stats().flushes == 0 && gated.stats().keyframes == 1, 'multi-patch V2 recovery uses one keyframe')

        // ============ nested paths: leaf → ancestor replacement → leaf, ordered by seq ============
        buf.v = 50
        backend.state.units['b'].hp = 55
        await flushReactive(backend.state)
        backend.state.units['b'] = {hp: 70, x: 7}
        await flushReactive(backend.state)
        backend.state.units['b'].x = 9
        await flushReactive(backend.state)
        buf.v = 0
        await waitFor('nested recovery', () => mirror.state.units['b']?.x == 9)
        ok(json(mirror.state) == json(backend.snapshot()), 'ancestor/descendant interleave replayed bit-exact')
        ok(gated.stats().keyframes == 1 && gated.stats().flushes == 1,
            'single-patch V2 envelopes still recover through a keyed tail')

        // ============ reconnect via since: log full, coalescing gaps harmless ============
        const at = sub.seq()
        sub()
        backend.state.tick = 11
        await flushReactive(backend.state)
        const sub2 = syncStoreReplay(mirror, remote, {since: at})
        await sub2.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'reconnect via since converged from the journal tail')

        ok(ascendingUnique(seqs), `delivered seqs strictly ascending: ${seqs.join(',')}`)
        sub2()
        gated.close()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
