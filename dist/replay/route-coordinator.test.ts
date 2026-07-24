// Acceptance oracle for createRouteCoordinator (ROADMAP 0.1 list):
// policy denial / promotion / failed direct / timeout / re-interposition /
// shadow relay / revocation / block — over fake in-process connectors.
import {
    createRouteCoordinator, RouteConnector, RouteConnectorInfo, RoutePairRef, RoutePolicy,
    tConnectorState, tRouteKind,
} from '../src/Common/events/replay-index'
import {replayListen} from '../src/Common/events/replay-index'
import {createStore, applyStorePatch, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)
const ascendingUnique = (seqs: number[]) => seqs.every((s, i) => i == 0 || s > seqs[i - 1])

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (cond()) return
        await delay(10)
    }
    throw new Error(`timeout: ${label}`)
}

// =====================================================================
// Fake in-process network: connectors are pure transports over one replay
// journal; behavior knobs simulate lag, open failure, catch-up failure.
// =====================================================================

type FakeBehavior = {
    lag: number
    failOpen?: boolean
    failCatchUp?: boolean
    hangCatchUp?: boolean
}

function makeFakeNet<Z extends any[]>(replay: any) {
    const behavior: Record<tRouteKind, FakeBehavior> = {
        relay: {lag: 5},
        direct: {lag: 25},
    }
    const opened: Record<tRouteKind, number> = {relay: 0, direct: 0}
    const connects: Record<tRouteKind, number> = {relay: 0, direct: 0}
    const conns: Array<{kind: tRouteKind, state: () => tConnectorState, lines: () => number, fail: (reason?: unknown) => void}> = []

    function connect(ref: RoutePairRef, kind: tRouteKind): RouteConnector<Z> {
        connects[kind]++
        const b = behavior[kind]
        let state: tConnectorState = 'idle'
        let lines = 0
        const failCbs: Array<(reason?: unknown) => void> = []
        const info: RouteConnectorInfo = {label: kind, kind, ordered: true, reliable: true, binary: false}
        const connector: RouteConnector<Z> = {
            info,
            open: async () => {
                state = 'opening'
                await delay(b.lag)
                if (b.failOpen) { state = 'failed'; throw new Error(kind + ' open failed') }
                state = 'open'
                opened[kind]++
                return {
                    line: {
                        on: (cb: (ev: any) => void) => {
                            lines++
                            const off = replay.line.on(cb)
                            return () => { lines--; off() }
                        },
                    },
                    since: async (s: number) => {
                        await delay(b.lag)
                        if (b.failCatchUp) throw new Error(kind + ' since failed')
                        if (b.hangCatchUp) await new Promise<void>(function keepCatchUpPending() {})
                        return replay.getSince(s) ?? null
                    },
                    keyframe: async () => {
                        await delay(b.lag)
                        if (b.failCatchUp) throw new Error(kind + ' keyframe failed')
                        if (b.hangCatchUp) await new Promise<void>(function keepCatchUpPending() {})
                        return replay.keyframe() ?? null
                    },
                    frame: async (s: number, hint?: unknown) => {
                        await delay(b.lag)
                        if (b.failCatchUp) throw new Error(kind + ' frame failed')
                        if (b.hangCatchUp) await new Promise<void>(function keepCatchUpPending() {})
                        return replay.frame(s, hint)
                    },
                }
            },
            close: () => { state = 'closed' },
            state: () => state,
            metrics: () => ({rtt: b.lag, pending: 0}),
            onFail: {on: (cb: (reason?: unknown) => void) => { failCbs.push(cb); return () => {} }},
        }
        conns.push({kind, state: connector.state, lines: () => lines, fail: reason => failCbs.forEach(cb => cb(reason))})
        return connector
    }

    function last(kind: tRouteKind) {
        for (let i = conns.length - 1; i >= 0; i--) if (conns[i].kind == kind) return conns[i]
        throw new Error('no connector of kind ' + kind)
    }
    function activeLines(kind: tRouteKind) {
        return conns.filter(c => c.kind == kind && c.state() == 'open').reduce((n, c) => n + c.lines(), 0)
    }
    return {connect, behavior, opened, connects, last, activeLines}
}

type World = {units: Record<string, {hp: number, x: number}>, tick: number}

async function main() {
    console.log('\n[route-coordinator] policy gates: direct is never attempted on denial')
    {
        let state = 0
        const [, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        const denials: Array<[RoutePolicy, string]> = [
            [{canDirect: () => false}, 'canDirect'],
            [{canDirect: () => true, mustRelay: () => true}, 'mustRelay'],
            [{canExposeEndpoint: () => false}, 'canExposeEndpoint'],
        ]
        for (const [policy, name] of denials) {
            const coord = createRouteCoordinator<[number]>({connect: net.connect, policy})
            const link = coord.pair('a', 'b')
            const sub = link.subscribe(() => {})
            await sub.ready
            const res = await link.promoteDirect()
            ok(!res.ok && String(res.reason).includes(name), `policy ${name}: promotion denied with reason`)
            ok(link.state() == 'relay', `policy ${name}: state stays relay`)
            coord.close()
        }
        ok(net.connects.direct == 0, 'denied direct is NEVER attempted (no direct connector created)')
    }

    console.log('\n[route-coordinator] promotion: relay stays live until direct catches up')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        const coord = createRouteCoordinator<[number]>({connect: net.connect})
        const routeLog: string[] = []
        coord.onRoute(ev => routeLog.push(`${ev.from}->${ev.to}`))
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const seqs: number[] = []
        const sub = link.subscribe(n => got.push(n), {onSeq: s => seqs.push(s)})
        await sub.ready
        ok(json(got) == json([0]) && link.label() == 'relay', 'pair starts on relay with keyframe')

        state = 1; emit(state)
        state = 2; emit(state)
        await delay(10)

        const promote = link.promoteDirect()
        await delay(10)
        ok(link.state() == 'direct:connecting', 'promotion passes through direct:connecting')
        ok(net.activeLines('relay') == 1, 'old relay line stays live while direct catches up')
        state = 3; emit(state)
        state = 4; emit(state)
        const res = await promote
        ok(res.ok && res.state == 'direct' && link.state() == 'direct', 'promotion lands in direct')
        ok(net.last('relay').state() == 'closed', 'relay connector is closed after clean direct (relay stepped out)')
        state = 5; emit(state)
        await delay(10)
        ok(json(got) == json([0, 1, 2, 3, 4, 5]), 'promotion is gap-free and dup-free')
        ok(ascendingUnique(seqs), `seqs strictly ascending: ${seqs.join(',')}`)
        ok(routeLog.includes('relay->direct:connecting') && routeLog.includes('direct:connecting->direct'), 'onRoute reports the transitions')

        // re-interposition: relay steps back into the path, resuming from seq
        const back = await link.reinterposeRelay('audit')
        ok(back.ok && link.state() == 'relay', 're-interposition lands back in relay')
        ok(net.last('direct').state() == 'closed', 'direct connector is closed after re-interposition')
        state = 6; emit(state)
        await delay(10)
        ok(json(got) == json([0, 1, 2, 3, 4, 5, 6]), 're-interposition resumes from seq (gap-free)')
        coord.close()
        ok(link.state() == 'closed', 'coordinator close tears the link down')
    }

    console.log('\n[route-coordinator] failed direct: relay continues, no data gap')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        net.behavior.direct.failCatchUp = true
        const coord = createRouteCoordinator<[number]>({connect: net.connect})
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(n => got.push(n))
        await sub.ready
        state = 1; emit(state)
        const res = await link.promoteDirect()
        ok(!res.ok && link.state() == 'fallback', 'failed direct catch-up marks fallback')
        state = 2; emit(state)
        await delay(10)
        ok(json(got) == json([0, 1, 2]), 'relay keeps flowing with no gap after failed direct')
        ok(sub.label() == 'relay', 'consumer is still riding the relay route')

        // open() failure is the same story
        net.behavior.direct.failCatchUp = false
        net.behavior.direct.failOpen = true
        const res2 = await link.promoteDirect()
        state = 3; emit(state)
        await delay(10)
        ok(!res2.ok && json(got) == json([0, 1, 2, 3]), 'failed direct open also keeps relay flowing')
        coord.close()
    }

    console.log('\n[route-coordinator] catch-up timeout: slow replacement fails the switch')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        net.behavior.direct.lag = 120
        const coord = createRouteCoordinator<[number]>({connect: net.connect, catchUpTimeoutMs: 40})
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(n => got.push(n))
        await sub.ready
        const res = await link.promoteDirect()
        ok(!res.ok && String(res.reason).includes('timeout') && link.state() == 'fallback', 'slow direct catch-up times out into fallback')
        state = 1; emit(state)
        await delay(200)
        state = 2; emit(state)
        await delay(10)
        ok(json(got) == json([0, 1, 2]), 'no dups/gaps even after the slow direct eventually resolves')
        ok(sub.label() == 'relay', 'consumer settled back on relay')
        coord.close()
    }

    console.log('\n[route-coordinator] timeout cancels a permanently blocked replacement')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        net.behavior.direct.hangCatchUp = true
        const coord = createRouteCoordinator<[number]>({connect: net.connect, catchUpTimeoutMs: 15})
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(n => got.push(n))
        await sub.ready

        const result = await Promise.race([
            link.promoteDirect(),
            delay(100).then(function markStillBlocked() { return null }),
        ])
        ok(result != null && !result.ok && link.state() == 'fallback',
            'timeout closes the blocked direct slot and lets rollback finish')
        ok(net.activeLines('direct') == 0 && sub.label() == 'relay',
            'blocked replacement releases its live line before returning')
        state = 1
        emit(state)
        await delay(10)
        ok(json(got) == json([0, 1]), 'relay remains live after a permanently blocked promotion')
        coord.close()
    }

    console.log('\n[route-coordinator] shadow relay: direct data path + relay audit copy')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        const audit: Array<[string, number]> = []
        const coord = createRouteCoordinator<[number]>({
            connect: net.connect,
            policy: {mustShadowRelay: () => true},
            shadow: (ref, n) => audit.push([ref.key, n]),
        })
        const link = coord.pair('a', 'b')
        const got: number[] = []
        const sub = link.subscribe(n => got.push(n))
        await sub.ready
        const res = await link.promoteDirect()
        ok(res.ok && link.state() == 'direct+shadowRelay', 'promotion with mustShadowRelay lands in direct+shadowRelay')
        ok(sub.label() == 'direct', 'payload path is direct')
        ok(net.last('relay').state() == 'open', 'relay connector stays open for the audit copy')
        state = 1; emit(state)
        state = 2; emit(state)
        await waitFor('audit copy', () => audit.length >= 2)
        ok(audit.some(([, n]) => n == 1) && audit.some(([, n]) => n == 2), 'audit mirror observes the same events')
        ok(audit.every(([key]) => key == 'a|b'), 'audit events carry the pair ref')
        ok(json(got.slice(-2)) == json([1, 2]), 'consumer data flows while audit observes')

        // revocation: direct dies -> close direct, resume relay from seq
        net.last('direct').fail('endpoint revoked')
        await waitFor('revocation fallback', () => link.state() == 'fallback')
        ok(net.last('direct').state() == 'closed', 'revoked direct connector is closed')
        state = 3; emit(state)
        await delay(10)
        ok(json(got) == json([0, 1, 2, 3]), 'relay resumes from seq after revocation, facade API unchanged')
        ok(sub.label() == 'relay', 'consumer is back on relay after revocation')
        coord.close()
    }

    console.log('\n[route-coordinator] canReinterpose + block')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 100})
        const net = makeFakeNet<[number]>(replay)
        const coord = createRouteCoordinator<[number]>({connect: net.connect, policy: {canReinterpose: () => false}})
        const link = coord.pair('b', 'a')
        ok(link.ref.key == 'a|b' && coord.pair('a', 'b') == link, 'pair key is symmetric: pair(b,a) == pair(a,b)')
        const got: number[] = []
        const sub = link.subscribe(n => got.push(n))
        await sub.ready
        await link.promoteDirect()
        const denied = await link.reinterposeRelay()
        ok(!denied.ok && link.state() == 'direct', 'canReinterpose=false keeps the direct route')

        const blocked = await link.block('moderation')
        ok(blocked.ok && link.state() == 'blocked', 'block lands in blocked from any state')
        state = 1; emit(state)
        await delay(10)
        ok(json(got) == json([0]), 'blocked pair delivers nothing')
        ok((await link.promoteDirect()).ok == false, 'blocked pair cannot promote')
        let threw = false
        try { link.subscribe(() => {}) } catch { threw = true }
        ok(threw, 'blocked pair rejects new subscriptions')
        coord.close()
    }

    console.log('\n[route-coordinator] store mirror rides the coordinator unchanged')
    {
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const net = makeFakeNet<[StorePatch]>(exposed.replay)
        const coord = createRouteCoordinator<[StorePatch]>({connect: net.connect})
        const link = coord.pair('server', 'client')
        const mirror = createStore<World>({units: {}, tick: -1}, {drain: 'micro'})
        const sub = link.subscribe(function applyRoutedPatch(patch) { applyStorePatch(mirror, patch) })
        await sub.ready
        ok(json(mirror.state) == json(backend.snapshot()), 'mirror starts from route keyframe')

        backend.state.tick = 1
        await flushReactive(backend.state)
        await waitFor('relay patch', () => mirror.state.tick == 1)

        const promote = link.promoteDirect()
        backend.state.units.b = {hp: 50, x: 5}
        backend.state.tick = 2
        await flushReactive(backend.state)
        await promote
        backend.state.units.a.hp = 80
        backend.state.tick = 3
        await flushReactive(backend.state)
        await waitFor('direct patch', () => mirror.state.tick == 3)
        ok(link.state() == 'direct', 'store link switched to direct')
        ok(json(mirror.state) == json(backend.snapshot()), 'mirror converged across route hand-off (facade unchanged)')
        coord.close()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
