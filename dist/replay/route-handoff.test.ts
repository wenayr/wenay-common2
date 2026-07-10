import {replayListen, ReplayRemote, replayRouteSubscribe} from '../src/Common/events/replay-index'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplayRoute} from '../src/Common/Observe/store-replay'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)
const ascendingUnique = (seqs: number[]) => seqs.every((s, i) => i == 0 || s > seqs[i - 1])

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 80; i++) {
        if (cond()) return
        await delay(10)
    }
    throw new Error(`timeout: ${label}`)
}

function makeRemote<Z extends any[]>(replay: any, label: string, lag = 0, failFrame = false) {
    const counters = {line: 0, since: 0, keyframe: 0, frame: 0}
    let active = 0
    const remote: ReplayRemote<Z> = {
        line: {
            on: (cb: (ev: any) => void) => {
                counters.line++
                active++
                const off = replay.line.on(cb)
                return () => { active--; off() }
            },
        },
        since: async (s: number) => { counters.since++; await delay(lag); return replay.getSince(s) ?? null },
        keyframe: async () => { counters.keyframe++; await delay(lag); return replay.keyframe() ?? null },
        frame: async (s: number, hint?: unknown) => {
            counters.frame++
            await delay(lag)
            if (failFrame) throw new Error(`${label} route failed`)
            return replay.frame(s, hint)
        },
    }
    return {remote, counters, active: () => active, label}
}

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
}

async function main() {
    console.log('\n[route-handoff] generic replay relay <-> direct promotion')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const relay = makeRemote<[number]>(replay, 'relay', 5)
        const direct = makeRemote<[number]>(replay, 'direct', 35)
        const bad = makeRemote<[number]>(replay, 'bad', 10, true)
        const got: number[] = []
        const seqs: number[] = []
        const phases: string[] = []
        const sub = replayRouteSubscribe<[number]>(relay.remote, n => got.push(n), {
            label: 'relay',
            onSeq: s => seqs.push(s),
            onRoute: ev => phases.push(`${ev.phase}:${ev.from ?? ''}->${ev.to ?? ''}`),
        })
        await sub.ready
        ok(json(got) == json([0]), 'initial route starts with one keyframe')
        ok(sub.label() == 'relay' && relay.active() == 1, 'relay route is active')

        state = 1; emit(state)
        state = 2; emit(state)
        await delay(5)

        const promote = sub.switch(direct.remote, {label: 'direct'})
        await delay(5)
        ok(relay.active() == 1 && direct.active() == 1, 'old relay stays alive while direct catches up')
        state = 3; emit(state)
        state = 4; emit(state)
        await promote
        ok(sub.label() == 'direct' && relay.active() == 0 && direct.active() == 1, 'direct becomes active and relay is closed after catch-up')
        state = 5; emit(state)
        await delay(5)
        ok(json(got) == json([0, 1, 2, 3, 4, 5]), 'promotion has no gaps or duplicate deliveries')
        ok(ascendingUnique(seqs), `seqs are strictly ascending after promotion: ${seqs.join(',')}`)
        ok(direct.counters.frame == 1, 'promotion uses frame/since coordinate, not a blind new snapshot')

        let failed = false
        const failSwitch = sub.switch(bad.remote, {label: 'bad'}).catch(() => { failed = true })
        await delay(2)
        state = 6; emit(state)
        await failSwitch
        state = 7; emit(state)
        await delay(5)
        ok(failed, 'failed replacement route rejects the switch')
        ok(sub.label() == 'direct' && direct.active() == 1 && bad.active() == 0, 'failed switch keeps the old direct route alive')
        ok(json(got) == json([0, 1, 2, 3, 4, 5, 6, 7]), 'events keep flowing on the old route after failed promotion')

        const reinterpose = sub.switch(relay.remote, {label: 'relay'})
        await delay(5)
        state = 8; emit(state)
        await reinterpose
        state = 9; emit(state)
        await delay(5)
        ok(sub.label() == 'relay' && relay.active() == 1 && direct.active() == 0, 'relay can re-interpose after direct route')
        ok(json(got) == json([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 're-interposition is also gap-free')
        ok(phases.includes('ready:relay->direct') && phases.includes('ready:direct->relay'), 'route lifecycle reports both hand-offs')
        sub()
        ok(relay.active() == 0 && direct.active() == 0, 'close tears down the active route')
    }

    console.log('\n[route-handoff] store mirror over a switched replay route')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const relay = makeRemote<[StorePatch]>(exposed.replay, 'store-relay', 5)
        const direct = makeRemote<[StorePatch]>(exposed.replay, 'store-direct', 30)
        const mirror = createStore<World>({units: {}, tick: -1}, {drain: 'micro'})
        const sub = syncStoreReplayRoute(mirror, relay.remote, {label: 'relay'})
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'store mirror starts from route keyframe')

        backend.state.tick = 1
        await flushReactive(backend.state)
        await waitFor('live relay patch', () => mirror.state.tick == 1)

        const promote = sub.switch(direct.remote, {label: 'direct'})
        await delay(5)
        backend.state.units.b = {hp: 50, x: 5}
        await flushReactive(backend.state)
        backend.state.tick = 2
        await flushReactive(backend.state)
        await promote
        ok(relay.active() == 0 && direct.active() == 1, 'store route switched to direct')

        backend.state.units.a.hp = 80
        backend.state.tick = 3
        await flushReactive(backend.state)
        await waitFor('live direct patch', () => mirror.state.tick == 3 && mirror.state.units.a.hp == 80)
        ok(json(mirror.state) == json(backend.snapshot()), 'store mirror remains converged across route hand-off')
        sub()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })