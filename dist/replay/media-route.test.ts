// Acceptance oracle for the media-facing relay/direct/best route facade.

import {replayListen} from '../src/Common/events/replay-listen'
import {
    RouteConnector,
    RoutePairRef,
    tConnectorState,
    tRouteKind,
} from '../src/Common/events/route-coordinator'
import {createMediaRoute} from '../src/Common/media/media-route'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

function makeFakeRoutes(replay: any) {
    const failOpen: Record<tRouteKind, boolean> = {relay: false, direct: false}
    const connects: Record<tRouteKind, number> = {relay: 0, direct: 0}
    const sessions: Array<{
        kind: tRouteKind
        state: () => tConnectorState
        fail: (reason?: unknown) => void
    }> = []

    function connect(_ref: RoutePairRef, kind: tRouteKind): RouteConnector<[number]> {
        connects[kind]++
        let state: tConnectorState = 'idle'
        const failures: Array<(reason?: unknown) => void> = []
        const connector: RouteConnector<[number]> = {
            info: {label: kind, kind, binary: true, ordered: true, reliable: true},
            async open() {
                state = 'opening'
                await delay(kind == 'direct' ? 4 : 1)
                if (failOpen[kind]) {
                    state = 'failed'
                    throw new Error(kind + ' open failed')
                }
                state = 'open'
                return {
                    line: replay.line,
                    since: (seq: number) => replay.getSince(seq) ?? null,
                    keyframe: () => replay.keyframe() ?? null,
                    frame: (seq: number, hint?: unknown) => replay.frame(seq, hint),
                }
            },
            close() {
                state = 'closed'
            },
            state: () => state,
            metrics: () => ({rtt: kind == 'direct' ? 4 : 12, pending: 0}),
            onFail: {
                on(cb) {
                    failures.push(cb)
                    return () => {}
                },
            },
        }
        sessions.push({
            kind,
            state: connector.state,
            fail: reason => failures.forEach(cb => cb(reason)),
        })
        return connector
    }

    function live(kind: tRouteKind) {
        for (let i = sessions.length - 1; i >= 0; i--) {
            const session = sessions[i]
            if (session.kind == kind && session.state() == 'open') return session
        }
        return null
    }

    return {connect, connects, failOpen, live}
}

async function main() {
    console.log('\n[media-route] relay is the compatible default')
    {
        const [emit, replay] = replayListen<[number]>({history: 32, current: 'last'})
        const net = makeFakeRoutes(replay)
        const route = createMediaRoute<[number]>({self: 'a', peer: 'b', connect: net.connect})
        const seen: number[] = []
        route.resource.line.on(value => seen.push(value))
        const status = await route.control.start()
        emit(1)
        ok(status.active == 'relay' && route.view.mode() == 'relay', 'default mode exposes the server relay')
        ok(net.connects.relay == 1 && net.connects.direct == 0, 'relay mode never attempts a direct connector')
        ok(seen.join(',') == '1', 'media frames flow through the facade line')
        route.control.close()
    }

    console.log('\n[media-route] best promotes direct and falls back/retries')
    {
        const [emit, replay] = replayListen<[number]>({history: 32, current: 'last'})
        const net = makeFakeRoutes(replay)
        const route = createMediaRoute<[number]>({
            self: 'a',
            peer: 'b',
            mode: 'best',
            connect: net.connect,
            directRetryMs: 10,
        })
        const seen: number[] = []
        route.resource.line.on(value => seen.push(value))
        const status = await route.control.start()
        emit(2)
        ok(status.active == 'direct' && net.connects.relay == 1 && net.connects.direct == 1,
            'best opens relay first and promotes a healthy direct route')
        ok(seen[seen.length - 1] == 2, 'promoted direct keeps the same replay line')

        net.live('direct')!.fail(new Error('direct lost'))
        await waitFor('best fallback', () => route.view.route() == 'relay')
        emit(3)
        ok(seen[seen.length - 1] == 3, 'direct failure automatically resumes the relay')
        await waitFor('best retry', () => route.view.route() == 'direct' && net.connects.direct == 2)
        ok(net.connects.relay == 2, 'fallback reopens the server connector before retrying direct')
        route.control.close()
    }

    console.log('\n[media-route] direct is strict and never leaks relay frames')
    {
        const [emit, replay] = replayListen<[number]>({history: 32, current: 'last'})
        const net = makeFakeRoutes(replay)
        net.failOpen.direct = true
        const route = createMediaRoute<[number]>({
            self: 'a',
            peer: 'b',
            mode: 'direct',
            connect: net.connect,
            directRetryMs: false,
        })
        const seen: number[] = []
        route.resource.line.on(value => seen.push(value))
        const failed = await route.control.start()
        emit(4)
        ok(failed.active == null && !!failed.error, 'required direct reports an unavailable direct route')
        ok(net.connects.relay == 0, 'required direct does not open the relay data connector')
        ok(seen.length == 0, 'required direct does not silently deliver through relay')

        net.failOpen.direct = false
        const retried = await route.control.reconsider('manual retry')
        emit(5)
        ok(retried.active == 'direct' && seen[seen.length - 1] == 5,
            'required direct can retry without a relay bootstrap')

        const relay = await route.control.setMode('relay')
        emit(6)
        ok(relay.active == 'relay' && seen[seen.length - 1] == 6, 'the caller can explicitly change to relay')
        route.control.close()
    }

    console.log('\n[media-route] best can use direct when the relay data path is unavailable')
    {
        const [emit, replay] = replayListen<[number]>({history: 32, current: 'last'})
        const net = makeFakeRoutes(replay)
        net.failOpen.relay = true
        const route = createMediaRoute<[number]>({
            self: 'a',
            peer: 'b',
            mode: 'best',
            connect: net.connect,
            directRetryMs: false,
        })
        const seen: number[] = []
        route.resource.line.on(value => seen.push(value))
        const status = await route.control.start()
        emit(7)
        ok(status.active == 'direct', 'best promotes direct after a failed relay bootstrap')
        ok(seen[seen.length - 1] == 7, 'the recovered direct subscription delivers media')
        route.control.close()
    }

    if (fails) {
        console.log(`\n${fails} MEDIA ROUTE TEST(S) FAILED`)
        process.exit(1)
    }
    console.log('\nALL MEDIA ROUTE TESTS PASSED')
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
