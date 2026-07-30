import {replaySubscribe, type ReplayRemote} from '../src/Common/events/replay-wire'
import {
    RPC_TRANSPORT_LIFECYCLE,
    createTransportLifecycle,
} from '../src/Common/events/transport-lifecycle'

let failures = 0

function ok(condition: unknown, message: string) {
    if (condition) {
        console.log('  OK  ', message)
        return
    }
    failures++
    console.log('  FAIL', message)
}

function event(seq: number, value = seq) {
    return {seq, ts: seq * 10, event: [value] as [number]}
}

function createRemote(deps: Partial<ReplayRemote<[number]>> = {}) {
    return {
        line: {
            on: function subscribeEmptyLine() {
                return function unsubscribeEmptyLine() {}
            },
        },
        since: async function noTail() { return null },
        keyframe: async function noKeyframe() { return null },
        ...deps,
    } satisfies ReplayRemote<[number]>
}

function turn() {
    return new Promise<void>(function waitForTurn(resolve) { setTimeout(resolve, 0) })
}

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return
        await turn()
    }
    throw new Error('timeout: ' + label)
}

async function runCase(name: string, run: () => Promise<void>) {
    console.log('\n[replay external snapshot] ' + name)
    try {
        await run()
    } catch (error) {
        failures++
        console.log('  FAIL unexpected error', error)
    }
}

async function main() {
    await runCase('prepareCatchUp commits an external coordinate before tail and queued live', async function preparedSnapshot() {
        let emitLive = function emitLiveLater(_value: ReturnType<typeof event>) {}
        let subscription!: ReturnType<typeof replaySubscribe<[number]>>
        let committedBeforeTail = false
        let keyframes = 0
        const values: number[] = []
        const sequences: number[] = []
        const remote = createRemote({
            line: {
                on: function subscribeLive(cb) {
                    emitLive = cb
                    return function unsubscribeLive() {}
                },
            },
            since: async function tailAfterExternalSnapshot(point) {
                committedBeforeTail = point == 5
                    && subscription.seq() == 5
                    && subscription.lastTs() == 50
                return [event(6)]
            },
            keyframe: async function unusedKeyframe() {
                keyframes++
                return event(99)
            },
        })

        subscription = replaySubscribe(remote, function applyReplayValue(value) {
            values.push(value)
        }, {
            catchUp: 'tail',
            onSeq: function collectSequence(seq) { sequences.push(seq) },
            prepareCatchUp: function installExternalSnapshot(context) {
                ok(context.initial && context.since == -1, 'prepare hook receives the initial coordinate')
                ok(!context.signal.aborted, 'prepare hook receives a live AbortSignal')
                values.push(5)
                emitLive(event(7))
                return {since: 5, ts: 50}
            },
        })

        await subscription.ready

        ok(committedBeforeTail, 'external seq and ts commit before requesting its tail')
        ok(values.join(',') == '5,6,7', 'snapshot, tail and queued live apply in order')
        ok(sequences.join(',') == '5,6,7', 'onSeq reports the external coordinate exactly once before successors')
        ok(subscription.seq() == 7 && subscription.lastTs() == 70, 'final cursor belongs to queued live')
        ok(keyframes == 0, 'prepared external snapshot does not request a keyframe')
        subscription()
    })

    await runCase('recoverGap installs a bounded snapshot before strict gap failure', async function recoveredGap() {
        const calls: string[] = []
        const values: number[] = []
        const sequences: number[] = []
        let keyframes = 0
        const remote = createRemote({
            since: async function recoverableTail(point) {
                calls.push('since:' + point)
                return point == 2 ? null : [event(6)]
            },
            keyframe: async function unusedRecoveredKeyframe() {
                keyframes++
                return event(99)
            },
        })
        const subscription = replaySubscribe(remote, function applyRecoveredTail(value) {
            values.push(value)
        }, {
            since: 2,
            catchUp: 'tail',
            gapPolicy: 'error',
            onSeq: function collectRecoveredSequence(seq) { sequences.push(seq) },
            recoverGap: function installReplacementSnapshot(context) {
                calls.push('recover:' + context.since)
                ok(context.initial && !context.signal.aborted, 'gap hook receives initial state and a live signal')
                values.push(5)
                return {since: 5, ts: 50}
            },
        })

        await subscription.ready

        ok(calls.join(',') == 'since:2,recover:2,since:5',
            'missing tail invokes recovery and then verifies the recovered coordinate tail')
        ok(values.join(',') == '5,6' && sequences.join(',') == '5,6',
            'strict policy accepts an installed replacement snapshot and its successor')
        ok(subscription.seq() == 6 && keyframes == 0, 'successful recovery bypasses ordinary keyframe fallback')
        subscription()
    })

    await runCase('recoverGap runs before ordinary keyframe fallback', async function recoveryBeforeKeyframe() {
        const calls: string[] = []
        const values: number[] = []
        const remote = createRemote({
            since: async function missingTail() {
                calls.push('since')
                return null
            },
            keyframe: async function fallbackKeyframe() {
                calls.push('keyframe')
                return event(9)
            },
        })
        const subscription = replaySubscribe(remote, function applyFallback(value) {
            values.push(value)
        }, {
            since: 4,
            catchUp: 'tail',
            recoverGap: function declineExternalRecovery() {
                calls.push('recover')
            },
        })

        await subscription.ready

        ok(calls.join(',') == 'since,recover,keyframe', 'external recovery gets first refusal before keyframe')
        ok(values.join(',') == '9' && subscription.seq() == 9, 'declined recovery preserves keyframe behavior')
        subscription()
    })

    await runCase('recoverGap runs before strict gap error', async function recoveryBeforeError() {
        const calls: string[] = []
        let keyframes = 0
        let failure: unknown = null
        const remote = createRemote({
            since: async function missingStrictTail() {
                calls.push('since')
                return null
            },
            keyframe: async function forbiddenKeyframe() {
                keyframes++
                return event(9)
            },
        })
        const subscription = replaySubscribe(remote, function receiveUnexpectedValue() {
            ok(false, 'strict missing-tail recovery must not deliver')
        }, {
            since: 4,
            catchUp: 'tail',
            gapPolicy: 'error',
            recoverGap: function declineStrictRecovery() {
                calls.push('recover')
            },
            onError: function captureStrictError(error) { failure = error },
        })

        await subscription.ready

        ok(calls.join(',') == 'since,recover', 'strict policy offers external recovery before failing')
        ok(keyframes == 0, 'strict policy still forbids ordinary keyframe fallback')
        ok(String((failure as any)?.message).includes('gap policy forbids keyframe reset'),
            'declined external recovery keeps the existing strict-gap error')
        ok(subscription.seq() == 4, 'failed recovery keeps its last honest coordinate')
        subscription()
    })

    await runCase('off aborts recoverGap and ignores its late coordinate', async function abortRecoveryOnOff() {
        let capturedSignal: AbortSignal | undefined
        let resolveRecovery = function resolveRecoveryLater(_value: {since: number}) {}
        let secondTailCalls = 0
        const sequences: number[] = []
        const heldRecovery = new Promise<{since: number}>(resolve => { resolveRecovery = resolve })
        const remote = createRemote({
            since: async function heldRecoveryTail(point) {
                if (point == 2) return null
                secondTailCalls++
                return []
            },
        })
        const subscription = replaySubscribe(remote, function receiveUnexpectedRecoveryValue() {
            ok(false, 'closed recovery must not deliver')
        }, {
            since: 2,
            catchUp: 'tail',
            onSeq: function collectUnexpectedSequence(seq) { sequences.push(seq) },
            recoverGap: function holdExternalRecovery(context) {
                capturedSignal = context.signal
                return heldRecovery
            },
        })

        await waitFor('recoverGap start', () => capturedSignal != undefined)
        subscription()
        await subscription.ready
        resolveRecovery({since: 5})
        await turn()
        await turn()

        ok(capturedSignal!.aborted, 'off aborts the active recovery signal')
        ok(subscription.seq() == 2 && sequences.length == 0, 'late recovery result cannot commit after off')
        ok(secondTailCalls == 0, 'late recovery result cannot request a successor tail')
    })

    await runCase('disconnect aborts prepareCatchUp and stale completion cannot overwrite reconnect', async function abortPreparationOnDisconnect() {
        let prepareCalls = 0
        let firstSignal: AbortSignal | undefined
        let resolveFirst = function resolveFirstLater(_value: {since: number}) {}
        const firstPreparation = new Promise<{since: number}>(resolve => { resolveFirst = resolve })
        const sequences: number[] = []
        const lifecycle = createTransportLifecycle(true)
        const remote = createRemote({
            since: async function tailAfterReconnect(point) {
                return point == 8 ? [] : null
            },
        })
        Object.defineProperty(remote, RPC_TRANSPORT_LIFECYCLE, {value: lifecycle.api})

        const subscription = replaySubscribe(remote, function receiveUnexpectedReconnectValue() {
            ok(false, 'empty reconnect tail must not deliver')
        }, {
            catchUp: 'tail',
            onSeq: function collectReconnectSequence(seq) { sequences.push(seq) },
            prepareCatchUp: function prepareReconnectSnapshot(context) {
                prepareCalls++
                if (prepareCalls == 1) {
                    firstSignal = context.signal
                    return firstPreparation
                }
                return {since: 8, ts: 80}
            },
        })

        await waitFor('first prepareCatchUp start', () => firstSignal != undefined)
        lifecycle.control.disconnect('test disconnect')
        ok(firstSignal!.aborted, 'disconnect aborts the active preparation signal')
        lifecycle.control.connect()
        await subscription.ready
        resolveFirst({since: 3})
        await turn()
        await turn()

        ok(prepareCalls == 2, 'reconnect starts a fresh preparation generation')
        ok(sequences.join(',') == '8', 'only the reconnect snapshot coordinate commits')
        ok(subscription.seq() == 8 && subscription.lastTs() == 80,
            'late completion from the disconnected generation cannot overwrite the cursor')
        subscription()
    })

    await runCase('external coordinate validates fully and honors reentrant close', async function validateBeforeCommit() {
        let failure: unknown
        const invalid = replaySubscribe(createRemote(), function receiveInvalidSnapshot() {}, {
            since: 2,
            catchUp: 'tail',
            onError(error) { failure = error },
            prepareCatchUp() {
                return {since: 5, ts: Number.NaN}
            },
        })
        await invalid.ready
        ok(failure != null && invalid.seq() == 2,
            'invalid snapshot timestamp cannot advance the last honest coordinate')

        let tailCalls = 0
        let closing!: ReturnType<typeof replaySubscribe<[number]>>
        closing = replaySubscribe(createRemote({
            since: async function tailAfterClosedPreparation() {
                tailCalls++
                return []
            },
        }), function receiveClosedSnapshot() {}, {
            catchUp: 'tail',
            onSeq() { closing() },
            prepareCatchUp() { return {since: 7, ts: 70} },
        })
        await closing.ready
        ok(closing.seq() == 7 && tailCalls == 0,
            'onSeq reentrant close commits the external coordinate but starts no extra tail request')
    })

    if (failures) {
        console.log('\n' + failures + ' replay external snapshot assertion(s) failed')
        process.exitCode = 1
        return
    }
    console.log('\nAll replay external snapshot assertions passed')
}

void main()
