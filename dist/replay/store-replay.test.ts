import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {ReplayRemote} from '../src/Common/events/replay-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
}

// in-proc «провод»: методы становятся async с задержкой — как настоящий RPC
function makeRemote(exposed: ReturnType<typeof exposeStoreReplay<World>>, lag = 15) {
    const counters = {since: 0, keyframe: 0}
    const remote: ReplayRemote<any> = {
        line: exposed.replay.line,
        since: async (s: number) => { counters.since++; await delay(lag); return exposed.replay.getSince(s) ?? null },
        keyframe: async () => { counters.keyframe++; await delay(lag); return exposed.replay.keyframe() ?? null },
    }
    return {remote, counters}
}

const ascendingUnique = (seqs: number[]) => seqs.every((s, i) => i == 0 || s > seqs[i - 1])

async function main() {
    console.log('\n[store-replay] fresh mirror: keyframe as root patch')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const {remote, counters} = makeRemote(exposed)
        const mirror = createStore<World>({units: {}, tick: -1})
        const seqs: number[] = []
        const sub = syncStoreReplay(mirror, remote, {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'since<0 → keyframe → mirror equals backend')
        ok(counters.keyframe == 1 && counters.since == 0, 'keyframe requested exactly once, no tail call')

        backend.state.units['b'] = {hp: 50, x: 5}
        backend.state.tick = 1
        await flushReactive(backend.state)
        await delay(5)
        ok(json(mirror.state) == json(backend.snapshot()), 'live patches keep mirror converged')
        ok(ascendingUnique(seqs), `delivered seqs strictly ascending: ${seqs.join(',')}`)
        sub()
        exposed.close()
    }

    console.log('\n[store-replay] reconnect with since → tail only, no snapshot')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const {remote} = makeRemote(exposed)
        const mirror = createStore<World>({units: {}, tick: -1})
        const sub = syncStoreReplay(mirror, remote)
        await sub.ready
        sub()  // «обрыв связи»

        backend.state.units['a'].hp = 75
        backend.state.units['c'] = {hp: 10, x: 9}
        await flushReactive(backend.state)
        backend.state.tick = 2
        await flushReactive(backend.state)

        const {remote: remote2, counters: counters2} = makeRemote(exposed)
        const sub2 = syncStoreReplay(mirror, remote2, {since: sub.seq()})
        await sub2.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'reconnect via since converges')
        ok(counters2.keyframe == 0 && counters2.since == 1, 'reconnect cost = tail of patches, NOT a snapshot')
        sub2()
        exposed.close()
    }

    console.log('\n[store-replay] long offline → journal evicted → fresh keyframe, no backlog')
    {
        const backend = createStore<World>({units: {}, tick: 0})
        const exposed = exposeStoreReplay(backend, {history: 3})
        const {remote} = makeRemote(exposed)
        const mirror = createStore<World>({units: {}, tick: -1})
        const sub = syncStoreReplay(mirror, remote)
        await sub.ready
        sub()

        for (let i = 1; i <= 20; i++) {
            backend.state.tick = i
            await flushReactive(backend.state)
        }
        let applied = 0
        const {remote: remote2, counters: counters2} = makeRemote(exposed)
        const counting: ReplayRemote<any> = {...remote2, line: {on: (cb: any) => remote2.line.on((ev: any) => { applied++; cb(ev) })}}
        const sub2 = syncStoreReplay(mirror, counting, {since: sub.seq()})
        await sub2.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'evicted → keyframe fallback converges')
        ok(counters2.keyframe == 1, 'fallback took exactly one fresh keyframe')
        ok(applied == 0, 'NO backlog: 20 offline patches never traveled')
        sub2()
        exposed.close()
    }

    console.log('\n[store-replay] events racing the catch-up window (async handover)')
    {
        const backend = createStore<World>({units: {a: {hp: 1, x: 1}}, tick: 0})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const {remote} = makeRemote(exposed, 30)
        const mirror = createStore<World>({units: {}, tick: -1})
        const seqs: number[] = []
        const sub = syncStoreReplay(mirror, remote, {onSeq: s => seqs.push(s)})
        // мутации ВО ВРЕМЯ ожидания keyframe: попадут и в снапшот, и в live-очередь
        backend.state.tick = 1
        await flushReactive(backend.state)
        backend.state.units['a'].hp = 2
        await flushReactive(backend.state)
        await sub.ready
        backend.state.tick = 3
        await flushReactive(backend.state)
        await delay(5)
        ok(json(mirror.state) == json(backend.snapshot()), 'overlap keyframe/queue converges')
        ok(ascendingUnique(seqs), `no seq delivered twice: ${seqs.join(',')}`)
        sub()
        exposed.close()
    }

    console.log('\n[store-replay] seq from another server life → keyframe resets the line down')
    {
        const backend = createStore<World>({units: {z: {hp: 9, x: 9}}, tick: 100})
        const exposed = exposeStoreReplay(backend, {history: 100})  // свежий сервер: head мал
        const {remote, counters} = makeRemote(exposed)
        const mirror = createStore<World>({units: {}, tick: -1})
        const sub = syncStoreReplay(mirror, remote, {since: 99999})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'future seq → keyframe fallback')
        ok(counters.keyframe == 1, 'keyframe taken once')
        backend.state.tick = 101
        await flushReactive(backend.state)
        await delay(5)
        ok(mirror.state.tick == 101, 'live events AFTER the reset are not muted by the stale big seq')
        sub()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
