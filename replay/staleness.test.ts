// ============================================================
//  replay/staleness.test.ts
//
//  Staleness watchdog: producer (withReplayListen {staleMs, onStale},
//  isStale()/lastTs()) and client (replaySubscribe {staleMs, onStale,
//  skewMs}, off.isStale()/off.lastTs()). Scenarios: silent wire
//  (edges both ways, not a timer); cold wire without timer;
//  lazy getters without onStale; stale keyframe — stale right at
//  delivery; NO flap on historical tail of since-catch-up;
//  skewMs tolerance; timer cleanup by off()/close().
//  Run:
//      npx tsx replay/staleness.test.ts
// ============================================================

import {replayListen, exposeReplay, replaySubscribe, StaleInfo, ReplayRemote} from '../src/Common/events/replay-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const edgesOf = (list: StaleInfo[]) => list.map(i => i.stale ? 'T' : 'F').join(',')

async function main() {
    console.log('\n[staleness] producer: silent line, edge-triggered both directions')
    {
        const edges: StaleInfo[] = []
        const [emit, listen] = replayListen<[number]>({history: 8, staleMs: 40, onStale: i => edges.push(i)})
        emit(1)
        ok(!listen.isStale() && listen.lastTs() > 0, 'fresh right after emit')
        await delay(100)
        ok(edgesOf(edges) == 'T', `fresh->stale fired exactly once, not a repeating alarm (${edgesOf(edges)})`)
        ok(listen.isStale(), 'isStale() agrees while silent')
        ok(edges[0].age >= 40 && edges[0].lastTs == listen.lastTs(), 'edge info carries lastTs/age')
        emit(2)
        ok(edgesOf(edges) == 'T,F', 'stale->fresh fired on the reviving emit')
        ok(!listen.isStale(), 'fresh again')
        await delay(100)
        ok(edgesOf(edges) == 'T,F,T', 'goes stale again after the next silence')
        listen.close()
    }

    console.log('\n[staleness] producer: cold line stays free')
    {
        const edges: StaleInfo[] = []
        const [, listen] = replayListen<[number]>({history: 8, staleMs: 30, onStale: i => edges.push(i)})
        await delay(90)
        ok(edges.length == 0, 'no events ever -> watchdog never armed, no edges')
        ok(!listen.isStale() && listen.lastTs() == 0, 'cold line is not stale (freshness unknown, not expired)')
        listen.close()
    }

    console.log('\n[staleness] producer: lazy getters without onStale (no timer needed)')
    {
        const [emit, listen] = replayListen<[number]>({history: 8, staleMs: 30})
        emit(1)
        await delay(70)
        ok(listen.isStale(), 'isStale() computes lazily, no onStale installed')
        emit(2)
        ok(!listen.isStale(), 'revives on emit')
        listen.close()
    }

    console.log('\n[staleness] producer: close() disarms the watchdog')
    {
        const edges: StaleInfo[] = []
        const [emit, listen] = replayListen<[number]>({history: 8, staleMs: 30, onStale: i => edges.push(i)})
        emit(1)
        listen.close()
        await delay(90)
        ok(edges.length == 0, 'no stale edge after close()')
    }

    console.log('\n[staleness] client: silent line over the wire shape (arrival gap)')
    {
        const [emit, listen] = replayListen<[number]>({history: 8})
        const remote = exposeReplay(listen) as unknown as ReplayRemote<[number]>
        const edges: StaleInfo[] = []
        const seen: number[] = []
        const sub = replaySubscribe(remote, v => seen.push(v), {staleMs: 40, onStale: i => edges.push(i)})
        await sub.ready
        emit(1)
        ok(!sub.isStale() && sub.lastTs() == listen.lastTs(), 'fresh after delivery, lastTs mirrors the envelope')
        await delay(100)
        ok(edgesOf(edges) == 'T', `silent wire -> one stale edge (${edgesOf(edges)})`)
        ok(sub.isStale(), 'off.isStale() agrees')
        emit(2)
        ok(edgesOf(edges) == 'T,F' && seen.join(',') == '1,2', 'delivery revives: fresh edge once, data intact')
        await delay(100)
        ok(edgesOf(edges) == 'T,F,T', 'stale again after the next silence')
        sub()
        emit(3)
        await delay(100)
        ok(edgesOf(edges) == 'T,F,T', 'off() disarms the client watchdog — no edges after unsubscribe')
        listen.close()
    }

    console.log('\n[staleness] client: dead producer at connect (silent from birth)')
    {
        const [, listen] = replayListen<[number]>({history: 8})
        const remote = exposeReplay(listen) as unknown as ReplayRemote<[number]>
        const edges: StaleInfo[] = []
        const sub = replaySubscribe(remote, () => {}, {staleMs: 40, onStale: i => edges.push(i)})
        await sub.ready
        await delay(100)
        ok(edgesOf(edges) == 'T', 'no envelope ever -> stale from the subscribe-time arrival gap')
        const lazy = replaySubscribe(remote, () => {}, {staleMs: 40})
        await lazy.ready
        await delay(80)
        ok(lazy.isStale(), 'isStale() works lazily without onStale (no timer)')
        sub(); lazy()
        listen.close()
    }

    console.log('\n[staleness] client: stale keyframe reported IMMEDIATELY at delivery')
    {
        let state = 7
        // producer clock "stopped" 500 ms ago — keyframe arrives now, but with old ts
        const producerNow = () => Date.now() - 500
        const [, listen] = replayListen<[number]>({history: 8, current: () => [state], now: producerNow})
        const remote = exposeReplay(listen) as unknown as ReplayRemote<[number]>
        const edges: StaleInfo[] = []
        const seen: number[] = []
        const sub = replaySubscribe(remote, v => seen.push(v), {staleMs: 100, onStale: i => edges.push(i)})
        await sub.ready
        ok(seen.join(',') == '7', 'keyframe delivered')
        ok(edgesOf(edges) == 'T', 'stale edge right after catch-up — no staleMs of waiting')
        ok(sub.isStale() && sub.lastTs() <= Date.now() - 500 + 5, 'lastTs is the old producer ts')
        sub()
        listen.close()
    }

    console.log('\n[staleness] client: historical since-tail does NOT flap')
    {
        let t = Date.now() - 300
        const [emit, listen] = replayListen<[number]>({history: 16, now: () => t})
        emit(1); emit(2); emit(3)          // old tail (ts 300 ms in the past)
        t = Date.now()
        emit(4); emit(5)                   // head is fresh
        const remote = exposeReplay(listen) as unknown as ReplayRemote<[number]>
        const edges: StaleInfo[] = []
        const seen: number[] = []
        const sub = replaySubscribe(remote, v => seen.push(v), {since: 0, staleMs: 100, onStale: i => edges.push(i)})
        await sub.ready
        ok(seen.join(',') == '1,2,3,4,5', 'full tail replayed')
        ok(edges.length == 0, 'old tail ts never flapped stale mid-catch-up; head is fresh -> no edge at all')
        ok(!sub.isStale(), 'fresh after handover')
        sub()
        listen.close()
    }

    console.log('\n[staleness] client: skewMs tolerance for producer/client clock disagreement')
    {
        let state = 1
        const skewedNow = () => Date.now() - 80   // producer lags by 80 ms
        const [, listen] = replayListen<[number]>({history: 8, current: () => [state], now: skewedNow})
        const remote = exposeReplay(listen) as unknown as ReplayRemote<[number]>
        const strict: StaleInfo[] = []
        const s1 = replaySubscribe(remote, () => {}, {staleMs: 50, onStale: i => strict.push(i)})
        await s1.ready
        ok(edgesOf(strict) == 'T', 'skewMs=0: an 80ms-old ts trips the 50ms threshold at delivery')
        s1()
        const tolerant: StaleInfo[] = []
        const s2 = replaySubscribe(remote, () => {}, {staleMs: 50, skewMs: 100, onStale: i => tolerant.push(i)})
        await s2.ready
        ok(tolerant.length == 0, 'skewMs=100 absorbs the clock offset — no false stale')
        s2()
        listen.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
