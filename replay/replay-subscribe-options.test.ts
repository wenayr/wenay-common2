import {ReplayRemote, replayRouteSubscribe, replaySubscribe} from '../src/Common/events/replay-index'
import {
    RPC_MEMBER_LOOKUP,
    RPC_SCHEMA_READY,
} from '../src/Common/events/transport-lifecycle'

type tRemoteDeps = Pick<ReplayRemote<[number]>, 'since' | 'keyframe'> & {
    frame?: ReplayRemote<[number]>['frame']
    line?: ReplayRemote<[number]>['line']
}

let fails = 0

function ok(condition: any, message: string) {
    if (condition) {
        console.log('  OK  ', message)
        return
    }
    fails++
    console.log('  FAIL', message)
}

function createRemote(deps: tRemoteDeps) {
    const remote: ReplayRemote<[number]> = {
        line: deps.line ?? {
            on: function subscribeLine() {
                return function unsubscribeLine() {}
            },
        },
        since: deps.since,
        keyframe: deps.keyframe,
    }
    if (deps.frame) remote.frame = deps.frame
    return remote
}

function numberEvent(seq: number) {
    return {seq, ts: seq, event: [seq] as [number]}
}

function deferSchema(remote: object) {
    let state: boolean | undefined
    let resolveSchema = function resolveSchemaLater() {}
    const ready = new Promise<void>(resolve => { resolveSchema = resolve })
    const lookup = function lookupDeferredReplayMember(member: string) {
        return member == 'frame' || member == 'frameLine' ? state : true
    }
    const schemaReady = function waitForDeferredReplaySchema() { return ready }
    Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
    Object.defineProperty(schemaReady, RPC_SCHEMA_READY, {value: true})
    Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: lookup})
    Object.defineProperty(remote, RPC_SCHEMA_READY, {value: schemaReady})
    return {
        resolve(next: boolean | undefined) {
            state = next
            resolveSchema()
        },
    }
}

async function settlement(promise: Promise<unknown>, timeoutMs = 100) {
    let timer: any
    try {
        return await Promise.race([
            promise.then(
                function settledResolved() { return 'resolved' as const },
                function settledRejected() { return 'rejected' as const },
            ),
            new Promise<'pending'>(function waitForSettlementTimeout(resolve) {
                timer = setTimeout(function settlementTimedOut() { resolve('pending') }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function waitForCondition(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return
        await new Promise<void>(function waitForConditionTurn(resolve) { setTimeout(resolve, 0) })
    }
    throw new Error('timeout: ' + label)
}

async function runCase(name: string, run: () => Promise<void>) {
    console.log('\n[replay subscribe options] ' + name)
    try {
        await run()
    } catch (error) {
        fails++
        console.log('  FAIL unexpected error', error)
    }
}

async function main() {
    await runCase('defaults preserve frame then tail then keyframe recovery', async function defaultRecovery() {
        let frameCalls = 0
        let tailCalls = 0
        let keyframeCalls = 0
        let failure: any = null
        const seen: number[] = []
        const remote = createRemote({
            frame: async function requestFrame(point) {
                frameCalls++
                ok(point == 2, 'default frame starts from requested point')
                return null
            },
            since: async function requestTail(point) {
                tailCalls++
                ok(point == 2, 'default tail fallback starts from requested point')
                return null
            },
            keyframe: async function requestKeyframe() {
                keyframeCalls++
                return {seq: 5, ts: 1, event: [5] as [number]}
            },
        })
        const subscription = replaySubscribe(remote, function receiveDefault(value) {
            seen.push(value)
        }, {
            since: 2,
            onError: function captureDefaultError(error) { failure = error },
        })

        await subscription.ready
        subscription()

        ok(frameCalls == 1, 'default catch-up still tries frame')
        ok(tailCalls == 1, 'default catch-up still falls back to since-tail')
        ok(keyframeCalls == 1, 'default missing tail still falls back to keyframe')
        ok(seen.join(',') == '5' && failure == null, 'default recovery delivers the keyframe without error')
    })

    await runCase('tail catch-up skips frame', async function tailRecovery() {
        let frameCalls = 0
        let tailCalls = 0
        let keyframeCalls = 0
        const seen: number[] = []
        const remote = createRemote({
            frame: async function requestFrame() {
                frameCalls++
                return [{seq: 99, ts: 1, event: [99] as [number]}]
            },
            since: async function requestTail(point) {
                tailCalls++
                ok(point == 2, 'tail mode starts from requested point')
                return [{seq: 3, ts: 1, event: [3] as [number]}]
            },
            keyframe: async function requestKeyframe() {
                keyframeCalls++
                return {seq: 100, ts: 1, event: [100] as [number]}
            },
        })
        const subscription = replaySubscribe(remote, function receiveTail(value) {
            seen.push(value)
        }, {since: 2, catchUp: 'tail'})

        await subscription.ready
        subscription()

        ok(frameCalls == 0, 'tail mode does not call remote.frame')
        ok(tailCalls == 1 && keyframeCalls == 0, 'available tail completes recovery directly')
        ok(seen.join(',') == '3', 'tail mode delivers only the since-tail')
    })

    await runCase('error gap policy rejects missing tail without keyframe', async function strictGapRecovery() {
        let keyframeCalls = 0
        let failure: any = null
        const remote = createRemote({
            since: async function requestMissingTail() {
                return null
            },
            keyframe: async function requestKeyframe() {
                keyframeCalls++
                return {seq: 9, ts: 1, event: [9] as [number]}
            },
        })
        const subscription = replaySubscribe(remote, function receiveUnexpected() {
            ok(false, 'strict gap recovery must not deliver a keyframe')
        }, {
            since: 4,
            catchUp: 'tail',
            gapPolicy: 'error',
            onError: function captureGapError(error) { failure = error },
        })

        await subscription.ready
        subscription()

        ok(keyframeCalls == 0, 'error gap policy does not call remote.keyframe')
        ok(failure instanceof Error, 'error gap policy reports a terminal recovery error')
        ok(String(failure?.message).includes('gap policy forbids keyframe reset'), 'reported error explains the rejected reset')
        ok(subscription.seq() == 4, 'failed recovery keeps the last honest sequence')
    })

    await runCase('error gap policy rejects a non-contiguous tail', async function strictTailSequence() {
        let failure: any = null
        const seen: number[] = []
        const remote = createRemote({
            since: async function requestGappedTail() {
                return [{seq: 4, ts: 1, event: [4] as [number]}]
            },
            keyframe: async function requestUnusedKeyframe() {
                return {seq: 8, ts: 1, event: [8] as [number]}
            },
        })
        const subscription = replaySubscribe(remote, function receiveGappedTail(value) {
            seen.push(value)
        }, {
            since: 2,
            catchUp: 'tail',
            gapPolicy: 'error',
            onError: function captureTailGap(error) { failure = error },
        })

        await subscription.ready

        ok(seen.length == 0, 'a gapped tail is rejected before its first dishonest delivery')
        ok(String(failure?.message).includes('expected 3, received 4'),
            'tail gap reports the expected and received sequences')
        ok(subscription.seq() == 2, 'tail gap keeps the last honest sequence')
    })

    await runCase('error gap policy rejects a live sequence jump', async function strictLiveSequence() {
        let failure: any = null
        let emitLive = function emitLiveLater(_event: any) {}
        const seen: number[] = []
        const remote = createRemote({
            line: {
                on: function subscribeLine(cb) {
                    emitLive = cb
                    return function unsubscribeLine() {}
                },
            },
            since: async function requestContiguousTail() {
                return [{seq: 3, ts: 1, event: [3] as [number]}]
            },
            keyframe: async function requestUnusedKeyframe() {
                return null
            },
        })
        const subscription = replaySubscribe(remote, function receiveLive(value) {
            seen.push(value)
        }, {
            since: 2,
            catchUp: 'tail',
            gapPolicy: 'error',
            onError: function captureLiveGap(error) { failure = error },
        })

        await subscription.ready
        emitLive({seq: 5, ts: 2, event: [5] as [number]})

        ok(seen.join(',') == '3', 'the contiguous tail is delivered before a later live gap')
        ok(String(failure?.message).includes('expected 4, received 5'),
            'live gap reports the expected and received sequences')
        ok(subscription.seq() == 3, 'live gap keeps the last honest sequence')
    })

    await runCase('reentrant delivery preserves cursor and callback order', async function reentrantDelivery() {
        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seen: number[] = []
            const seqs: number[] = []
            const errors: unknown[] = []
            const remote = createRemote({
                line: {
                    on: function subscribeLine(cb) {
                        emitLive = cb
                        return function unsubscribeLine() {}
                    },
                },
                since: async function requestMissingTail() { return null },
                keyframe: async function requestInitialKeyframe() { return numberEvent(0) },
            })
            const subscription = replaySubscribe(remote, function receiveReentrant(value) {
                seen.push(value)
                if (value == 1) emitLive(numberEvent(2))
            }, {
                gapPolicy: 'error',
                onSeq: function emitFromSequence(seq) {
                    seqs.push(seq)
                    if (seq == 1) emitLive(numberEvent(3))
                },
                onError: function captureReentrantError(error) { errors.push(error) },
            })
            await subscription.ready
            seen.length = 0
            seqs.length = 0

            emitLive(numberEvent(1))

            ok(seen.join(',') == '1,2,3', 'replay callback and onSeq emissions stay in sequence order')
            ok(seqs.join(',') == '1,2,3' && subscription.seq() == 3,
                'replay cursor commits monotonically after each successful callback')
            ok(errors.length == 0, 'strict gap mode does not reject a valid reentrant successor')
            subscription()
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seen: number[] = []
            let failure: unknown = null
            const remote = createRemote({
                line: {
                    on: function subscribeLine(cb) {
                        emitLive = cb
                        return function unsubscribeLine() {}
                    },
                },
                since: async function requestMissingTail() { return null },
                keyframe: async function requestInitialKeyframe() { return numberEvent(0) },
            })
            const subscription = replaySubscribe(remote, function throwAfterReentrantEmit(value) {
                seen.push(value)
                if (value != 1) return
                emitLive(numberEvent(2))
                throw new Error('reentrant consumer failed')
            }, {
                gapPolicy: 'error',
                onError: function captureConsumerFailure(error) { failure = error },
            })
            await subscription.ready
            seen.length = 0

            emitLive(numberEvent(1))

            ok(seen.join(',') == '1', 'failed replay callback discards its queued reentrant successor')
            ok(subscription.seq() == 0, 'failed replay callback leaves the last honest cursor unchanged')
            ok(String((failure as any)?.message).includes('reentrant consumer failed'),
                'failed replay callback remains a terminal reported error')
            subscription()
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seen: number[] = []
            const seqs: number[] = []
            const remote = createRemote({
                line: {
                    on: function subscribeRouteLine(cb) {
                        emitLive = cb
                        return function unsubscribeRouteLine() {}
                    },
                },
                since: async function requestMissingRouteTail() { return null },
                keyframe: async function requestRouteKeyframe() { return numberEvent(0) },
            })
            const route = replayRouteSubscribe(remote, function receiveReentrantRoute(value) {
                seen.push(value)
                if (value == 1) emitLive(numberEvent(2))
            }, {
                onSeq: function emitFromRouteSequence(seq) {
                    seqs.push(seq)
                    if (seq == 1) emitLive(numberEvent(3))
                },
            })
            await route.ready
            seen.length = 0
            seqs.length = 0

            emitLive(numberEvent(1))

            ok(seen.join(',') == '1,2,3' && seqs.join(',') == '1,2,3',
                'route callback and onSeq emissions stay in sequence order')
            ok(route.seq() == 3, 'route cursor cannot regress after a reentrant successor')
            route()
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seen: number[] = []
            let failure: unknown = null
            const remote = createRemote({
                line: {
                    on: function subscribeRouteLine(cb) {
                        emitLive = cb
                        return function unsubscribeRouteLine() {}
                    },
                },
                since: async function requestMissingRouteTail() { return null },
                keyframe: async function requestRouteKeyframe() { return numberEvent(0) },
            })
            const route = replayRouteSubscribe(remote, function throwAfterRouteEmit(value) {
                seen.push(value)
                if (value != 1) return
                emitLive(numberEvent(2))
                throw new Error('reentrant route consumer failed')
            }, {
                onError: function captureRouteFailure(error) { failure = error },
            })
            await route.ready
            seen.length = 0

            emitLive(numberEvent(1))

            ok(seen.join(',') == '1', 'failed route callback discards its queued reentrant successor')
            ok(route.seq() == 0, 'failed route callback leaves the last honest cursor unchanged')
            ok(String((failure as any)?.message).includes('reentrant route consumer failed'),
                'failed route callback remains visible to route error handling')
            route()
        }
    })

    await runCase('self-close commits only callbacks which returned successfully', async function selfCloseCommit() {
        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seqs: number[] = []
            const remote = createRemote({
                line: {
                    on: function subscribeSelfClosingReplay(cb) {
                        emitLive = cb
                        return function unsubscribeSelfClosingReplay() {}
                    },
                },
                since: async function requestMissingTail() { return null },
                keyframe: async function requestSelfClosingKeyframe() { return numberEvent(0) },
            })
            let subscription!: ReturnType<typeof replaySubscribe<[number]>>
            subscription = replaySubscribe(remote, function closeSuccessfulReplay(value) {
                if (value == 1) subscription()
            }, {
                onSeq: function rememberSelfClosedReplaySeq(seq) { seqs.push(seq) },
            })
            await subscription.ready
            seqs.length = 0

            emitLive(numberEvent(1))

            ok(subscription.seq() == 1 && seqs.join(',') == '1',
                'replay callback which closes itself still commits its delivered coordinate')
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const remote = createRemote({
                line: {
                    on: function subscribeThrowingSelfCloseReplay(cb) {
                        emitLive = cb
                        return function unsubscribeThrowingSelfCloseReplay() {}
                    },
                },
                since: async function requestMissingTail() { return null },
                keyframe: async function requestThrowingSelfCloseKeyframe() { return numberEvent(0) },
            })
            let subscription!: ReturnType<typeof replaySubscribe<[number]>>
            subscription = replaySubscribe(remote, function closeThenThrowReplay(value) {
                if (value != 1) return
                subscription()
                throw new Error('self-closed replay callback failed')
            })
            await subscription.ready

            emitLive(numberEvent(1))

            ok(subscription.seq() == 0,
                'replay callback which throws after closing itself does not commit')
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const seqs: number[] = []
            const remote = createRemote({
                line: {
                    on: function subscribeSelfClosingRoute(cb) {
                        emitLive = cb
                        return function unsubscribeSelfClosingRoute() {}
                    },
                },
                since: async function requestMissingRouteTail() { return null },
                keyframe: async function requestSelfClosingRouteKeyframe() { return numberEvent(0) },
            })
            let route!: ReturnType<typeof replayRouteSubscribe<[number]>>
            route = replayRouteSubscribe(remote, function closeSuccessfulRoute(value) {
                if (value == 1) route()
            }, {
                onSeq: function rememberSelfClosedRouteSeq(seq) { seqs.push(seq) },
            })
            await route.ready
            seqs.length = 0

            emitLive(numberEvent(1))

            ok(route.seq() == 1 && seqs.join(',') == '1',
                'route callback which closes itself still commits its delivered coordinate')
        }

        {
            let emitLive = function emitLiveLater(_event: any) {}
            const remote = createRemote({
                line: {
                    on: function subscribeThrowingSelfCloseRoute(cb) {
                        emitLive = cb
                        return function unsubscribeThrowingSelfCloseRoute() {}
                    },
                },
                since: async function requestMissingRouteTail() { return null },
                keyframe: async function requestThrowingSelfCloseRouteKeyframe() { return numberEvent(0) },
            })
            let route!: ReturnType<typeof replayRouteSubscribe<[number]>>
            route = replayRouteSubscribe(remote, function closeThenThrowRoute(value) {
                if (value != 1) return
                route()
                throw new Error('self-closed route callback failed')
            })
            await route.ready

            emitLive(numberEvent(1))

            ok(route.seq() == 0,
                'route callback which throws after closing itself does not commit')
        }
    })

    await runCase('delayed and dynamic schemas retain frame policy until absence is proven', async function delayedFrameSchema() {
        function createDeferredFrameRemote(value: number) {
            const stats = {line: 0, frameLine: 0, frame: 0, since: 0}
            const remote: ReplayRemote<[number]> = {
                line: {
                    on: function subscribeFallbackLine() {
                        stats.line++
                        return function unsubscribeFallbackLine() {}
                    },
                },
                frameLine: {
                    on: function subscribeFrameLine() {
                        stats.frameLine++
                        return function unsubscribeFrameLine() {}
                    },
                },
                frame: async function requestDeferredFrame() {
                    stats.frame++
                    return [numberEvent(value)]
                },
                since: async function requestDeferredTail() {
                    stats.since++
                    return [numberEvent(value)]
                },
                keyframe: async function requestDeferredKeyframe() {
                    return numberEvent(value)
                },
            }
            return {remote, stats, schema: deferSchema(remote)}
        }

        {
            const test = createDeferredFrameRemote(1)
            const seen: number[] = []
            const subscription = replaySubscribe(test.remote, value => seen.push(value), {
                since: 0,
                policy: 'frame',
            })
            await Promise.resolve()
            ok(test.stats.line == 0 && test.stats.frameLine == 0 && test.stats.frame == 0,
                'replay waits for a declared schema instead of prematurely choosing the base line')

            // A dynamic MAP may remain undefined after readiness. Its concrete
            // projected members are still the best available capability signal.
            test.schema.resolve(undefined)
            await subscription.ready

            ok(test.stats.frameLine == 1 && test.stats.line == 0,
                'unknown dynamic replay schema keeps the requested frame line')
            ok(test.stats.frame == 1 && test.stats.since == 0 && seen.join(',') == '1',
                'unknown dynamic replay schema keeps initial frame catch-up')
            subscription()
        }

        {
            const test = createDeferredFrameRemote(2)
            const seen: number[] = []
            const route = replayRouteSubscribe(test.remote, value => seen.push(value), {
                since: 0,
                policy: 'frame',
            })
            await Promise.resolve()
            ok(test.stats.line == 0 && test.stats.frameLine == 0 && test.stats.frame == 0,
                'route also waits for its delayed capability map')

            test.schema.resolve(true)
            await route.ready

            ok(test.stats.frameLine == 1 && test.stats.line == 0,
                'known route frameLine is selected after MAP')
            ok(test.stats.frame == 1 && test.stats.since == 0 && seen.join(',') == '2',
                'known route frame method performs initial catch-up')
            route()
        }

        {
            const test = createDeferredFrameRemote(3)
            const seen: number[] = []
            const subscription = replaySubscribe(test.remote, value => seen.push(value), {
                since: 0,
                policy: 'frame',
            })
            test.schema.resolve(false)
            await subscription.ready

            ok(test.stats.frameLine == 0 && test.stats.line == 1,
                'MAP-proven missing frameLine safely falls back to the base line')
            ok(test.stats.frame == 0 && test.stats.since == 1 && seen.join(',') == '3',
                'MAP-proven missing frame safely falls back to the old since path')
            subscription()
        }
    })

    await runCase('route close settles blocked reads and stale switches', async function closeBlockedRoutes() {
        async function closeBlockedRead(kind: 'frame' | 'since' | 'keyframe') {
            let started = false
            let lineOffs = 0
            let releaseRead = function releaseBlockedReadLater(_value: any) {}
            const blockedRead = new Promise<any>(resolve => { releaseRead = resolve })
            const deps: tRemoteDeps = {
                line: {
                    on: function subscribeBlockedRouteLine() {
                        return function unsubscribeBlockedRouteLine() { lineOffs++ }
                    },
                },
                since: function requestBlockedRouteTail() {
                    if (kind == 'since') {
                        started = true
                        return blockedRead
                    }
                    return null
                },
                keyframe: function requestBlockedRouteKeyframe() {
                    if (kind == 'keyframe') {
                        started = true
                        return blockedRead
                    }
                    return null
                },
            }
            if (kind == 'frame') {
                deps.frame = function requestBlockedRouteFrame() {
                    started = true
                    return blockedRead
                }
            }
            const seen: number[] = []
            const route = replayRouteSubscribe(createRemote(deps), function receiveBlockedRoute(value) {
                seen.push(value)
            }, {since: 0})
            await waitForCondition(kind + ' request start', () => started)

            route()
            const state = await settlement(route.ready)
            ok(state == 'resolved', 'close settles ready blocked in ' + kind)
            ok(lineOffs == 1, 'close releases the ' + kind + ' live handle exactly once')

            releaseRead(kind == 'keyframe' ? numberEvent(1) : [numberEvent(1)])
            await Promise.resolve()
            await Promise.resolve()
            ok(seen.length == 0, 'late ' + kind + ' result from a closed slot is ignored')
        }

        await closeBlockedRead('frame')
        await closeBlockedRead('since')
        await closeBlockedRead('keyframe')

        const initial = createRemote({
            since: async function requestInitialRouteTail() { return null },
            keyframe: async function requestInitialRouteKeyframe() { return numberEvent(0) },
        })
        let staleStarted = false
        let staleLineOffs = 0
        let releaseStale = function releaseStaleLater(_value: any) {}
        const staleRead = new Promise<any>(resolve => { releaseStale = resolve })
        const stale = createRemote({
            line: {
                on: function subscribeStaleRouteLine() {
                    return function unsubscribeStaleRouteLine() { staleLineOffs++ }
                },
            },
            since: function requestStaleRouteTail() {
                staleStarted = true
                return staleRead
            },
            keyframe: function requestUnusedStaleKeyframe() { return null },
        })
        const switchedValues: number[] = []
        const route = replayRouteSubscribe(initial, function receiveSwitchedRoute(value) {
            switchedValues.push(value)
        })
        await route.ready
        switchedValues.length = 0
        const pendingSwitch = route.switch(stale, {since: 0})
        await waitForCondition('stale switch read', () => staleStarted)

        route()
        ok(await settlement(pendingSwitch) == 'resolved',
            'close settles a stale switch whose remote read never returns')
        ok(staleLineOffs == 1, 'close releases the stale switch line exactly once')

        releaseStale([numberEvent(1)])
        await Promise.resolve()
        await Promise.resolve()
        ok(switchedValues.length == 0, 'late stale-switch data cannot reach the closed route')
    })

    await runCase('throwing route onError is isolated from delivery', async function throwingRouteOnError() {
        let emitLive = function emitLiveLater(_event: any) {}
        const remote = createRemote({
            line: {
                on: function subscribeThrowingErrorRoute(cb) {
                    emitLive = cb
                    return function unsubscribeThrowingErrorRoute() {}
                },
            },
            since: async function requestThrowingErrorTail() { return null },
            keyframe: async function requestThrowingErrorKeyframe() { return numberEvent(0) },
        })
        let resolveThrown = function resolveThrownLater(_error: unknown) {}
        const thrown = new Promise<unknown>(resolve => { resolveThrown = resolve })
        function captureRouteErrorCallback(error: unknown) { resolveThrown(error) }
        process.once('uncaughtException', captureRouteErrorCallback)
        const route = replayRouteSubscribe(remote, function throwRouteConsumer(value) {
            if (value == 1) throw new Error('route consumer failed')
        }, {
            onError: function throwRouteOnError() { throw new Error('route onError failed') },
        })
        await route.ready

        let escaped = false
        try { emitLive(numberEvent(1)) }
        catch { escaped = true }
        const callbackError = await Promise.race([
            thrown,
            new Promise<unknown>(resolve => setTimeout(function routeErrorTimeout() { resolve('pending') }, 100)),
        ])
        process.off('uncaughtException', captureRouteErrorCallback)

        ok(!escaped, 'throwing onError cannot escape through the live producer callback')
        ok(String((callbackError as any)?.message).includes('route onError failed'),
            'throwing onError remains visible asynchronously')
        ok(route.seq() == 0 && !route.active(), 'failed delivery keeps the honest cursor and closes its route')
        route()
    })

    await runCase('ordered fast path keeps inversion and large route queues exact', async function orderedQueues() {
        const sorted: number[] = []
        const unorderedRemote = createRemote({
            since: async function requestUnorderedTail() {
                return [
                    {seq: 3, ts: 1, event: [3] as [number]},
                    {seq: 1, ts: 1, event: [1] as [number]},
                    {seq: 2, ts: 1, event: [2] as [number]},
                ]
            },
            keyframe: async function requestUnusedKeyframe() { return null },
        })
        const unordered = replaySubscribe(unorderedRemote, function receiveSorted(value) {
            sorted.push(value)
        }, {since: 0, catchUp: 'tail'})
        await unordered.ready
        unordered()
        ok(sorted.join(',') == '1,2,3', 'the no-copy ordered fast path still sorts a real inversion')

        let emitLive = function emitLiveLater(_event: any) {}
        let releaseKeyframe = function releaseKeyframeLater() {}
        const heldKeyframe = new Promise<any>(resolve => { releaseKeyframe = () => resolve(null) })
        const routeRemote = createRemote({
            line: {
                on: function subscribeRouteLine(cb) {
                    emitLive = cb
                    return function unsubscribeRouteLine() {}
                },
            },
            since: async function requestMissingRouteTail() { return null },
            keyframe: function requestHeldRouteKeyframe() { return heldKeyframe },
        })
        const routeValues: number[] = []
        const route = replayRouteSubscribe(routeRemote, function receiveRouteValue(value) {
            routeValues.push(value)
        })
        for (let index = 0; index < 20_000; index++) {
            emitLive({seq: index, ts: index, event: [index] as [number]})
        }
        releaseKeyframe()
        await route.ready
        route()
        ok(routeValues.length == 20_000 && routeValues[0] == 0 && routeValues[19_999] == 19_999,
            'route catch-up drains a large live queue once without loss or reordering')
    })

    if (fails) {
        console.log('\n' + fails + ' replay subscribe option assertion(s) failed')
        process.exitCode = 1
        return
    }
    console.log('\nAll replay subscribe option assertions passed')
}

void main()
