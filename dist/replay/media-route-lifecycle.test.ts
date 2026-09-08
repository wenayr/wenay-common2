import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {createMediaRoute} from '../src/Common/media/media-route'
import {replayListen} from '../src/Common/events/replay-listen'
import {tConnectorState} from '../src/Common/events/route-coordinator'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

test('relay transition cannot publish a late error after close', async function closeDuringRelayTransition() {
    const entered = deferred<void>()
    const resume = deferred<void>()
    const [, replay] = replayListen<[number]>({current: () => [1]})
    const route = createMediaRoute<[number]>({
        self: 'a', peer: 'b', mode: 'direct',
        connect(_ref, kind) {
            let state: tConnectorState = 'idle'
            return {
                info: {label: kind, kind, binary: true, ordered: true, reliable: true},
                async open() {
                    if (kind == 'relay') {
                        entered.resolve()
                        await resume.promise
                        throw new Error('late relay failure')
                    }
                    if (state != 'closed') state = 'open'
                    return {line: replay.line, since: replay.getSince, keyframe: replay.keyframe}
                },
                state: () => state,
                close() { state = 'closed' },
            }
        },
    })
    try {
        await route.control.start()
        const pending = route.control.setMode('relay')
        await entered.promise
        route.control.close()
        const finalStatus = route.view.status()
        resume.resolve()
        await pending
        assert.deepEqual(route.view.status(), finalStatus)
    } finally {
        resume.resolve()
        route.control.close()
        replay.close()
    }
})

for (const mode of ['relay', 'best', 'direct'] as const) {
    test('closing from start notification is terminal in ' + mode, async function closeFromStartObserver() {
        let connects = 0
        const route = createMediaRoute({
            self: 'a', peer: 'b', mode,
            connect() { connects++; throw new Error('closed route must not connect') },
        })
        route.events.changed.on(function closeWhenStarting(event) {
            if (event.current.state == 'starting') route.control.close()
        })
        await route.control.start()
        assert.equal(connects, 0)
        assert.equal(route.view.route(), null)
        await assert.rejects(route.control.start(), /closed/)
    })

    test('media close stays terminal during ' + mode + ' open', async function closeDuringOpen() {
        const entered = deferred<void>()
        const resume = deferred<void>()
        const [, replay] = replayListen<[number]>({current: () => [1]})
        let connects = 0
        const route = createMediaRoute<[number]>({
            self: 'a', peer: 'b', mode, directRetryMs: false,
            connect(_ref, kind) {
                connects++
                let state: tConnectorState = 'idle'
                function currentState() { return state }
                return {
                    info: {label: kind, kind, binary: true, ordered: true, reliable: true},
                    async open() {
                        state = 'opening'
                        entered.resolve()
                        await resume.promise
                        if (currentState() != 'closed') state = 'open'
                        return {line: replay.line, since: replay.getSince, keyframe: replay.keyframe}
                    },
                    state: currentState,
                    close() { state = 'closed' },
                }
            },
        })
        try {
            const pending = route.control.start()
            const outcome = pending.then(value => value, error => error)
            await entered.promise
            route.control.close()
            const connectsAtClose = connects
            resume.resolve()
            await outcome
            assert.equal(route.view.status().state, 'closed')
            assert.equal(route.view.route(), null)
            assert.equal(connects, connectsAtClose)
            await assert.rejects(route.control.start(), /closed/)
        } finally {
            resume.resolve()
            route.control.close()
            replay.close()
        }
    })
}
