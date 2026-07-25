// ============================================================
//  replay/conflate.test.ts
//
//  Layer D.1: per-client conflation + snapshot recovery.
//  Part 1 — generic wire (counter), part 2 — independence
//  per-client, part 3 — store mirror over async wire with lag.
//  Run:
//      npx tsx replay/conflate.test.ts
// ============================================================

import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {replayListen, replaySubscribe, ReplayRemote} from '../src/Common/events/replay-index'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {conflateReplay} from '../src/Common/events/replay-index'

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

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
}

async function main() {
    console.log('\n[conflate] generic line: drop over highWater, keyframe recovery on drain')
    {
        let value = 0
        const [emit, replay] = replayListen<[number]>({current: () => [value], history: 100})
        const push = (n: number) => { value = n; emit(n) }
        const buf = {v: 0}  // simulated client outgoing buffer
        const gated = conflateReplay(replay, {pending: () => buf.v, highWater: 5, pollMs: 10})
        const remote: ReplayRemote<[number]> = {
            line: gated.api.line,
            since: s => gated.api.since(s),
            keyframe: () => gated.api.keyframe(),
        }
        const got: number[] = []
        const seqs: number[] = []
        const sub = replaySubscribe(remote, (n: number) => got.push(n), {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(got) == json([0]), 'fresh subscriber got the keyframe')

        push(1)
        push(2)
        ok(json(got) == json([0, 1, 2]), 'below highWater deltas pass through untouched')
        ok(gated.stats().dropped == 0 && gated.stats().keyframes == 0, 'gate was transparent so far')

        // ============ overflow: deltas stop being sent ============
        buf.v = 10
        for (let n = 3; n <= 7; n++) push(n)
        ok(got[got.length - 1] == 2, 'over highWater: deltas stop reaching the client')
        ok(gated.stats().conflating && gated.stats().dropped == 5, `all 5 deltas dropped, not queued (dropped=${gated.stats().dropped})`)

        // ============ buffer drained in silence → recovery by polling ============
        buf.v = 0
        await waitFor('poll recovery', () => got[got.length - 1] == 7)
        ok(got[got.length - 1] == 7 && !got.includes(3), '5 missed deltas collapsed into ONE fresh keyframe')
        ok(gated.stats().keyframes == 1 && !gated.stats().conflating, 'exactly one recovery keyframe')

        push(8)
        ok(got[got.length - 1] == 8, 'live deltas resume after recovery')

        // ============ recovery by the next event itself, no polling wait ============
        buf.v = 10
        push(9)
        ok(got[got.length - 1] == 8, 'delta while conflating is dropped')
        buf.v = 0
        push(10)
        ok(got[got.length - 1] == 10, 'drained buffer + next event → keyframe immediately, no poll wait')
        ok(gated.stats().keyframes == 2, 'recovery was a keyframe, not the delta')
        ok(got.filter(n => n == 10).length == 1, 'keyframe covering the delta is not duplicated by it')

        ok(ascendingUnique(seqs), `delivered seqs strictly ascending: ${seqs.join(',')}`)

        // ============ close: gate is dead forever ============
        const before = got.length
        gated.close()
        push(11)
        ok(got.length == before, 'after close() nothing reaches the client')
        sub()
    }

    console.log('\n[conflate] lowWater hysteresis: recovery waits for a REAL drain, not the first dip')
    {
        let value = 0
        const [emit, replay] = replayListen<[number]>({current: () => [value], history: 100})
        const push = (n: number) => { value = n; emit(n) }
        const buf = {v: 0}
        const gated = conflateReplay(replay, {pending: () => buf.v, highWater: 5, lowWater: 2, pollMs: 10})
        const got: number[] = []
        const sub = replaySubscribe<[number]>(
            {line: gated.api.line, since: s => gated.api.since(s), keyframe: () => gated.api.keyframe()},
            n => got.push(n))
        await sub.ready

        buf.v = 10
        push(1)
        ok(gated.stats().conflating, 'over highWater → conflating')

        // ============ gray zone (lowWater < pending <= highWater): gate does NOT open ============
        buf.v = 4
        push(2)          // event-based recovery path should not fire
        await delay(50)  // nor polling
        ok(got.length == 1 && gated.stats().keyframes == 0, 'between lowWater and highWater the gate stays shut (hysteresis)')
        ok(gated.stats().dropped == 2, 'deltas in the gray zone are still dropped, not queued')

        // ============ real drain: pending <= lowWater ============
        buf.v = 2
        await waitFor('hysteresis recovery', () => got[got.length - 1] == 2)
        ok(gated.stats().keyframes == 1 && !gated.stats().conflating, 'recovery fired only at lowWater')

        // re-entry into conflation — only ABOVE highWater
        buf.v = 4
        push(3)
        ok(got[got.length - 1] == 3 && !gated.stats().conflating, 'below highWater the gate does not re-enter conflation')
        sub(); gated.close()
    }

    console.log('\n[conflate] misuse: no current provider → loud construction error')
    {
        const [, bare] = replayListen<[number]>({history: 10})
        let threw = false
        try { conflateReplay(bare, {pending: () => 0, highWater: 1}) } catch { threw = true }
        ok(threw, 'conflateReplay without keyframe recovery throws at construction')
    }

    console.log('\n[conflate] per-client independence: slow client conflates, fast one streams')
    {
        let value = 0
        const [emit, replay] = replayListen<[number]>({current: () => [value], history: 100})
        const push = (n: number) => { value = n; emit(n) }
        const bufSlow = {v: 100}
        const fast = conflateReplay(replay, {pending: () => 0, highWater: 5, pollMs: 10})
        const slow = conflateReplay(replay, {pending: () => bufSlow.v, highWater: 5, pollMs: 10})
        const gotFast: number[] = []
        const gotSlow: number[] = []
        const subFast = replaySubscribe<[number]>(
            {line: fast.api.line, since: s => fast.api.since(s), keyframe: () => fast.api.keyframe()},
            n => gotFast.push(n))
        const subSlow = replaySubscribe<[number]>(
            {line: slow.api.line, since: s => slow.api.since(s), keyframe: () => slow.api.keyframe()},
            n => gotSlow.push(n))
        await subFast.ready
        await subSlow.ready

        for (let n = 1; n <= 6; n++) push(n)
        ok(gotFast[gotFast.length - 1] == 6 && gotFast.length == 7, 'fast client received every delta')
        ok(gotSlow.length == 1, 'slow client got nothing extra — its line is conflated')

        bufSlow.v = 0
        await waitFor('slow client recovery', () => gotSlow[gotSlow.length - 1] == 6)
        ok(gotSlow.length == 2, 'slow client caught up with ONE keyframe, no backlog')
        subFast(); subSlow(); fast.close(); slow.close()
    }

    console.log('\n[conflate] store mirror over a lagged async wire')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const buf = {v: 0}
        const gated = conflateReplay(exposed.replay, {pending: () => buf.v, highWater: 3, pollMs: 10})
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

        backend.state.tick = 1
        await flushReactive(backend.state)
        ok(json(mirror.state) == json(backend.snapshot()), 'live patches flow through the transparent gate')

        // ============ client "stalled": patches accumulate only at backend ============
        buf.v = 50
        for (let i = 2; i <= 12; i++) {
            backend.state.units['a'].hp = i
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        ok(mirror.state.tick == 1, 'stalled client got NO deltas (no queue growing for it)')
        const envBefore = envelopes

        // ============ drained → one keyframe instead of 22 patches ============
        buf.v = 0
        await waitFor('mirror recovery', () => mirror.state.tick == 12)
        ok(json(mirror.state) == json(backend.snapshot()), 'recovered mirror equals backend')
        ok(envelopes - envBefore == 1, `22 missed patches collapsed into 1 envelope (got ${envelopes - envBefore})`)
        ok(gated.stats().keyframes == 1, 'recovery cost exactly one keyframe')

        backend.state.tick = 13
        await flushReactive(backend.state)
        await waitFor('live after recovery', () => mirror.state.tick == 13)
        ok(json(mirror.state) == json(backend.snapshot()), 'live stream continues after recovery')
        ok(ascendingUnique(seqs), `delivered seqs strictly ascending: ${seqs.join(',')}`)

        sub()
        gated.close()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
