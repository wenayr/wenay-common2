import assert from 'node:assert/strict'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from '../../src/Common/events/replay-channel'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay, replaySubscribe} from '../../src/Common/events/replay-wire'
import {channelFromDataChannel} from '../../src/Common/events/route-signal-webrtc'
import {runOracle} from '../run-oracle'

// One live event that cannot travel must not cost the other events of its
// micro-batch their delivery, and its failure must surface once, loudly.

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function createChannelPair() {
    const text = {a: new Set<(data: string) => void>(), b: new Set<(data: string) => void>()}
    const binary = {a: new Set<(data: Uint8Array) => void>(), b: new Set<(data: Uint8Array) => void>()}
    const control = {failNextServerBinary: false}

    function side(me: 'a' | 'b', peer: 'a' | 'b'): ReplayMessageChannel {
        return {
            send(data) { for (const cb of [...text[peer]]) cb(data) },
            sendBinary(data) {
                if (me == 'a' && control.failNextServerBinary) {
                    control.failNextServerBinary = false
                    throw new Error('synthetic binary send failure')
                }
                const owned = data.slice()
                for (const cb of [...binary[peer]]) cb(owned)
            },
            onMessage(cb) { text[me].add(cb); return () => text[me].delete(cb) },
            onBinaryMessage(cb) { binary[me].add(cb); return () => binary[me].delete(cb) },
        }
    }
    return {server: side('a', 'b'), client: side('b', 'a'), control}
}

/** Deferred errors (the replay line and the channel rethrow them on a timer). */
function captureUncaught() {
    const errors: unknown[] = []
    function capture(error: unknown) { errors.push(error) }
    process.on('uncaughtException', capture)
    return {errors, stop() { process.removeListener('uncaughtException', capture) }}
}

function nest(levels: number, leaf: unknown) {
    let value = leaf
    for (let index = 0; index < levels; index++) value = [value]
    return value
}

async function openLiveLine() {
    const [emit, replay] = replayListen<[any]>({history: 64, current: () => [{state: 'keyframe'}]})
    const pair = createChannelPair()
    const stop = serveReplayChannel(exposeReplay(replay), pair.server)
    const remote = channelReplayRemote<[any]>(pair.client)
    return {emit, replay, pair, stop, remote}
}

// ============================================================
// Depth band: valid for the event snapshot, too deep inside a batch packet
// ============================================================

async function checkDeepItemKeepsItsBatchNeighbours() {
    const uncaught = captureUncaught()
    const {emit, stop, remote} = await openLiveLine()
    try {
        const seqs: number[] = []
        const lenient = replaySubscribe<[any]>(remote, function consume() {}, {onSeq: seq => { seqs.push(seq) }})
        let strictError: Error | undefined
        const strict = replaySubscribe<[any]>(remote, function consumeStrictly() {}, {
            gapPolicy: 'error',
            onError(error) { strictError = error },
        })
        await Promise.all([lenient.ready, strict.ready])
        seqs.length = 0
        emit({n: 1})
        emit(nest(33, 7n)) // BigInt cannot fall back to JSON; the event sits in the band
        emit({n: 3})
        emit({n: 4})
        await delay(5)
        emit({n: 5})
        await delay(5)
        assert.deepEqual(seqs, [1, 3, 4, 5], 'every encodable event of the micro-batch is delivered')
        assert.match(String(strictError?.message), /expected 2, received 3/,
            'a gap-strict subscriber reports exactly the one missing event')
        assert.equal(uncaught.errors.length, 1, 'the bad event is reported exactly once')
        assert.match(String((uncaught.errors[0] as Error)?.message), /BigInt/)
        lenient()
        strict()
    } finally {
        stop()
        uncaught.stop()
    }
}

function openManualLine() {
    // A bare source: its emitter is the caller of forward(), nothing defers for it.
    let forward: (ev: any) => void = function notSubscribed() { throw new Error('line not subscribed') }
    const source: any = {
        line: {on(cb: (ev: any) => void) { forward = cb; return function offManualLine() {} }},
        since: () => null,
        keyframe: () => null,
        frame: () => null,
    }
    const pair = createChannelPair()
    const stop = serveReplayChannel(source, pair.server)
    const remote = channelReplayRemote<[any]>(pair.client)
    const got: any[] = []
    remote.line.on(ev => got.push(ev))
    return {forward: (ev: any) => forward(ev), stop, got}
}

async function checkBandItemIsRefusedAtEmit() {
    const {forward, stop, got} = openManualLine()
    try {
        forward({seq: 1, ts: 1, event: [{n: 1}]})
        assert.throws(function emitTooDeep() { forward({seq: 2, ts: 2, event: [nest(33, 7n)]}) }, /BigInt/,
            'an event two levels too deep for its batch packet is refused at emit, as unbatched')
        forward({seq: 3, ts: 3, event: [nest(32, 7n)]})
        await delay(5)
        assert.deepEqual(got.map(ev => ev.seq), [1, 3], 'the refused event never enters the batch')
        let deepest = got[1].event[0]
        while (Array.isArray(deepest)) deepest = deepest[0]
        assert.equal(deepest, 7n, 'the deepest event a batch can carry still travels as binary')
    } finally {
        // A failed check leaves band items queued; their close-time flush error must not mask it.
        try { stop() } catch {}
    }
}

// ============================================================
// Transport failure of one packet during a flush
// ============================================================

async function checkFailedPacketKeepsLaterGroups() {
    const uncaught = captureUncaught()
    const {emit, pair, stop, remote} = await openLiveLine()
    try {
        const got: any[] = []
        remote.line.on(ev => got.push(ev.event[0].k))
        pair.control.failNextServerBinary = true
        emit({k: 1}) // binary group, its packet send throws
        emit({k: 2, omitted() {}}) // JSON group: functions are not binary values
        emit({k: 3}) // binary group again
        await delay(5)
        assert.deepEqual(got, [2, 3], 'groups after the failed packet are still sent')
        assert.equal(uncaught.errors.length, 1, 'the failed send is reported exactly once')
        assert.equal((uncaught.errors[0] as Error)?.message, 'synthetic binary send failure')
    } finally {
        stop()
        uncaught.stop()
    }
}

async function checkSizeFlushFailureKeepsTriggeringEvent() {
    const uncaught = captureUncaught()
    const {emit, pair, stop, remote} = await openLiveLine()
    try {
        const got: string[] = []
        remote.line.on(ev => got.push(ev.event[0].slice(0, 1)))
        emit('a'.repeat(40_000))
        pair.control.failNextServerBinary = true
        // Queue bytes would pass 64 KB: the queued event is flushed first and its send fails.
        emit('b'.repeat(40_000))
        await delay(5)
        assert.deepEqual(got, ['b'], 'the event that triggered the flush is still queued and sent')
        assert.equal(uncaught.errors.length, 1, 'the failed send is reported exactly once')
    } finally {
        stop()
        uncaught.stop()
    }
}

// ============================================================
// Closing WebRTC datachannel
// ============================================================

function createFakeDataChannel() {
    const sent: unknown[] = []
    const dc = {
        readyState: 'open',
        binaryType: undefined as string | undefined,
        onmessage: null as ((ev: {data: unknown}) => void) | null,
        onclose: null as ((ev?: unknown) => void) | null,
        onerror: null as ((ev?: unknown) => void) | null,
        send(data: unknown) {
            // Browser behaviour: send() outside 'open' throws before onclose fires.
            if (dc.readyState != 'open') throw new Error('InvalidStateError: RTCDataChannel.readyState is not \'open\'')
            sent.push(data)
        },
        close() { dc.readyState = 'closing' },
    }
    return {dc, sent}
}

function checkDataChannelAdapterWhileClosing() {
    const {dc, sent} = createFakeDataChannel()
    const channel = channelFromDataChannel(dc)
    channel.send('open')
    dc.readyState = 'closing'
    channel.send('late text')
    channel.sendBinary!(Uint8Array.from([1]))
    assert.deepEqual(sent, ['open'], 'a closing datachannel drops sends instead of throwing')
}

async function checkServerOverClosingDataChannel() {
    const uncaught = captureUncaught()
    const [emit, replay] = replayListen<[number]>({history: 16})
    const {dc, sent} = createFakeDataChannel()
    const stop = serveReplayChannel(exposeReplay(replay), channelFromDataChannel(dc))
    try {
        dc.onmessage!({data: JSON.stringify({t: 'hello', binary: 1})})
        dc.onmessage!({data: JSON.stringify({t: 'sub', batch: 1})})
        emit(1)
        await delay(5)
        const sentWhileOpen = sent.length
        dc.readyState = 'closing'
        emit(2)
        await delay(5)
        dc.readyState = 'closed'
        dc.onclose!()
        emit(3)
        await delay(5)
        assert.equal(sentWhileOpen, 2, 'ready and the first live frame went out')
        assert.equal(sent.length, sentWhileOpen, 'nothing is written after the channel started closing')
        assert.equal(uncaught.errors.length, 0, 'a closing datachannel is not an application error')
    } finally {
        stop()
        uncaught.stop()
    }
}

async function runChecks() {
    let failures = 0
    const checks = [
        checkDeepItemKeepsItsBatchNeighbours,
        checkBandItemIsRefusedAtEmit,
        checkFailedPacketKeepsLaterGroups,
        checkSizeFlushFailureKeepsTriggeringEvent,
        checkDataChannelAdapterWhileClosing,
        checkServerOverClosingDataChannel,
    ]
    for (const check of checks) {
        try {
            await check()
            console.log(`PASS ${check.name}`)
        } catch (error) {
            failures++
            console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
        }
    }
    // Let any stray timer rethrow before judging.
    await delay(20)
    if (failures) {
        console.error(`${failures} replay channel live-batch checks failed`)
        process.exit(1)
    }
    console.log('PASS replay channel live batch: bad items and failed sends cost no neighbours, closing datachannels stay quiet')
}

async function main() {
    await runChecks().catch(function fail(error) {
        console.error('FAIL', error)
        process.exit(1)
    })
}

runOracle(main)
