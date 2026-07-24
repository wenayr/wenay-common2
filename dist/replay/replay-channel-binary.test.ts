import assert from 'assert'
import {exposeReplay} from '../src/Common/events/replay-wire'
import {
    channelReplayRemote,
    ReplayMessageChannel,
    serveReplayChannel,
} from '../src/Common/events/replay-channel'
import {replayListen} from '../src/Common/events/replay-listen'
import {channelFromDataChannel, RtcDataChannel} from '../src/Common/events/route-signal-webrtc'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type tFrame =
    | {binary: false, data: string}
    | {binary: true, data: Uint8Array}

function createBinaryChannelPair({pauseAToB = false}: {pauseAToB?: boolean} = {}) {
    const aTextCbs = new Set<(data: string) => void>()
    const bTextCbs = new Set<(data: string) => void>()
    const aBinaryCbs = new Set<(data: Uint8Array) => void>()
    const bBinaryCbs = new Set<(data: Uint8Array) => void>()
    const aText: string[] = []
    const bText: string[] = []
    const aBinary: Uint8Array[] = []
    const bBinary: Uint8Array[] = []
    const queuedAToB: tFrame[] = []
    let holdAToB = pauseAToB
    let throwAToBBinary = false

    function deliver(
        frame: tFrame,
        textCbs: Set<(data: string) => void>,
        binaryCbs: Set<(data: Uint8Array) => void>,
    ) {
        if (frame.binary) {
            for (const cb of Array.from(binaryCbs)) cb(frame.data)
            return
        }
        for (const cb of Array.from(textCbs)) cb(frame.data)
    }

    function side(
        direction: 'a-to-b' | 'b-to-a',
        sentText: string[],
        sentBinary: Uint8Array[],
        ownTextCbs: Set<(data: string) => void>,
        ownBinaryCbs: Set<(data: Uint8Array) => void>,
        targetTextCbs: Set<(data: string) => void>,
        targetBinaryCbs: Set<(data: Uint8Array) => void>,
    ): ReplayMessageChannel {
        function forward(frame: tFrame) {
            if (direction == 'a-to-b' && holdAToB) {
                queuedAToB.push(frame)
                return
            }
            deliver(frame, targetTextCbs, targetBinaryCbs)
        }

        return {
            send(data) {
                sentText.push(data)
                forward({binary: false, data})
            },
            sendBinary(data) {
                if (direction == 'a-to-b' && throwAToBBinary) {
                    throwAToBBinary = false
                    throw new Error('synthetic binary send failure')
                }
                const owned = data.slice()
                sentBinary.push(owned)
                forward({binary: true, data: owned})
            },
            onMessage(cb) {
                ownTextCbs.add(cb)
                return function offTextMessage() { ownTextCbs.delete(cb) }
            },
            onBinaryMessage(cb) {
                ownBinaryCbs.add(cb)
                return function offBinaryMessage() { ownBinaryCbs.delete(cb) }
            },
        }
    }

    const a = side(
        'a-to-b',
        aText,
        aBinary,
        aTextCbs,
        aBinaryCbs,
        bTextCbs,
        bBinaryCbs,
    )
    const b = side(
        'b-to-a',
        bText,
        bBinary,
        bTextCbs,
        bBinaryCbs,
        aTextCbs,
        aBinaryCbs,
    )

    return {
        a,
        b,
        aText,
        bText,
        aBinary,
        bBinary,
        releaseAToB() {
            holdAToB = false
            while (queuedAToB.length) {
                deliver(queuedAToB.shift()!, bTextCbs, bBinaryCbs)
            }
        },
        throwNextAToBBinary() {
            throwAToBBinary = true
        },
    }
}

function createRichValue(order: number) {
    const sparse: any[] = []
    sparse.length = 4
    sparse[1] = undefined
    sparse[3] = 'present'
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.safe = false
    Reflect.defineProperty(nullPrototype, '__proto__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: 'own',
    })
    const dataViewBytes = Uint8Array.from([9, 8, 7, 6])
    return {
        order,
        undefinedValue: undefined,
        falseValue: false,
        trueValue: true,
        zero: 0,
        minusZero: -0,
        notANumber: NaN,
        positiveInfinity: Infinity,
        text: 'Привет 🌍',
        bigint: 12345678901234567890n,
        sparse,
        nullPrototype,
        date: new Date(1_725_000_123_456),
        regexp: /a+b?/giu,
        map: new Map<unknown, unknown>([['one', 1], [{key: 'nested'}, new Set([false, 'two'])]]),
        set: new Set<unknown>([undefined, 3n, {set: 'object'}]),
        buffer: Uint8Array.from([0, 1, 127, 128, 255]).buffer,
        dataView: new DataView(dataViewBytes.buffer, 1, 2),
        typed: new Float64Array([-0, NaN, Infinity]),
    }
}

function assertRichValue(value: ReturnType<typeof createRichValue>, order: number) {
    assert.equal(value.order, order)
    assert.equal(value.undefinedValue, undefined)
    assert.equal(value.falseValue, false)
    assert.equal(value.trueValue, true)
    assert.equal(value.zero, 0)
    assert.equal(Object.is(value.minusZero, -0), true)
    assert.equal(Number.isNaN(value.notANumber), true)
    assert.equal(value.positiveInfinity, Infinity)
    assert.equal(value.text, 'Привет 🌍')
    assert.equal(value.bigint, 12345678901234567890n)
    assert.equal(value.sparse.length, 4)
    assert.equal(0 in value.sparse, false)
    assert.equal(1 in value.sparse, true)
    assert.equal(value.sparse[1], undefined)
    assert.equal(Object.getPrototypeOf(value.nullPrototype), null)
    assert.equal(value.nullPrototype.safe, false)
    assert.equal(value.nullPrototype.__proto__, 'own')
    assert.equal(value.date.valueOf(), 1_725_000_123_456)
    assert.equal(value.regexp.source, 'a+b?')
    assert.equal(value.regexp.flags, 'giu')
    assert.equal(value.map.get('one'), 1)
    assert.equal(Array.from(value.set)[1], 3n)
    assert.deepEqual(Array.from(new Uint8Array(value.buffer)), [0, 1, 127, 128, 255])
    assert.deepEqual(Array.from(new Uint8Array(
        value.dataView.buffer,
        value.dataView.byteOffset,
        value.dataView.byteLength,
    )), [8, 7])
    assert.equal(Object.is(value.typed[0], -0), true)
    assert.equal(Number.isNaN(value.typed[1]), true)
    assert.equal(value.typed[2], Infinity)
}

async function testNewPeersUseExactBinaryMessages() {
    let current = createRichValue(10)
    let receivedFrameHint: any = null
    const [emit, replay] = replayListen<[any]>({
        current: () => [current],
        history: 512,
        frame(_tail, hint) {
            receivedFrameHint = hint
            return [{
                seq: 99,
                ts: 99,
                event: [{keep: 'response', omitted() {}}],
            }]
        },
    })
    const pair = createBinaryChannelPair()
    const stop = serveReplayChannel(exposeReplay(replay), pair.a)
    const remote = channelReplayRemote<[any]>(pair.b)
    const got: any[] = []
    remote.line.on(function receiveBinaryReplay(ev) {
        got.push(ev.event[0])
    })

    assert.equal(JSON.parse(pair.bText[0]).t, 'hello')
    assert.equal(JSON.parse(pair.aText[0]).t, 'ready')
    assert.equal(pair.bBinary.length, 1, 'subscription switches to binary after synchronous ready')
    pair.b.send(JSON.stringify({t: 'hello', binary: 1}))
    pair.b.send(JSON.stringify({t: 'sub', batch: 1}))
    assert.equal(pair.aText.filter(raw => JSON.parse(raw).t == 'ready').length, 1,
        'repeated hello/sub cannot restart the negotiated stream')

    pair.aBinary.length = 0
    const live = createRichValue(1)
    emit(live)
    live.order = 999
    await delay(0)
    assert.equal(pair.aBinary.length, 1)
    assert.equal(pair.aText.filter(raw => JSON.parse(raw).t == 'evs').length, 0)
    assertRichValue(got[0], 1)

    current = createRichValue(2)
    const keyframe = await remote.keyframe()
    assert.ok(keyframe)
    assertRichValue(keyframe!.event[0], 2)
    assert.ok(pair.bBinary.length >= 2, 'request is binary')
    assert.ok(pair.aBinary.length >= 2, 'response is binary')

    // A JSON-only value remains compatible after negotiation and is still
    // snapshotted at emit time, exactly like the historical direct channel.
    const legacy: any = {order: 3, keep: 'before', omitted() {}}
    emit({order: 2.5})
    emit(legacy)
    emit({order: 4})
    legacy.keep = 'after'
    await delay(0)
    assert.deepEqual(got.slice(1).map(value => value.order), [2.5, 3, 4])
    assert.equal(got[2].keep, 'before')
    assert.equal('omitted' in got[2], false)
    assert.ok(pair.aText.some(raw => JSON.parse(raw).t == 'evs'),
        'unsupported binary value falls back to the accepted JSON envelope')

    const frameHint: any = {keep: 'hint-before', omitted() {}}
    const framePending = remote.frame!(0, frameHint)
    frameHint.keep = 'hint-after'
    const frameResult = await framePending
    assert.equal(receivedFrameHint.keep, 'hint-before')
    assert.equal('omitted' in receivedFrameHint, false)
    assert.equal(frameResult?.[0].event[0].keep, 'response')
    assert.equal('omitted' in frameResult?.[0].event[0], false)
    assert.ok(pair.bText.some(raw => JSON.parse(raw).t == 'req'),
        'client can fall back to a JSON request after binary negotiation')
    assert.ok(pair.aText.some(raw => JSON.parse(raw).t == 'res'),
        'server can fall back to a JSON response after binary negotiation')

    stop()
}

async function testBinaryMicroBatchBounds() {
    const [emit, replay] = replayListen<[any]>({history: 512})
    const pair = createBinaryChannelPair()
    const stop = serveReplayChannel(exposeReplay(replay), pair.a)
    const remote = channelReplayRemote<[any]>(pair.b)
    const got: any[] = []
    remote.line.on(ev => got.push(ev.event[0]))
    pair.aBinary.length = 0

    for (let index = 0; index < 130; index++) {
        emit({symbol: 'S' + index, price: index + 0.5, active: index % 2 == 0})
    }
    await delay(0)
    assert.equal(pair.aBinary.length, 3)
    assert.ok(pair.aBinary.every(frame => frame.byteLength <= 64 * 1024))
    assert.equal(got.length, 130)
    assert.equal(got[129].symbol, 'S129')

    pair.aBinary.length = 0
    const large = 'Ж'.repeat(15_000)
    emit(large)
    emit(large)
    emit(large)
    await delay(0)
    assert.equal(pair.aBinary.length, 2)
    assert.ok(pair.aBinary.every(frame => frame.byteLength <= 64 * 1024))
    assert.deepEqual(got.slice(-3), [large, large, large])

    pair.aBinary.length = 0
    const oversize = 'z'.repeat(70 * 1024)
    emit(oversize)
    await delay(0)
    assert.equal(pair.aBinary.length, 1)
    assert.ok(pair.aBinary[0].byteLength > 64 * 1024,
        'one oversize event is allowed as its own physical frame')
    assert.equal(got[got.length - 1], oversize)
    stop()
}

async function testMixedVersionsRemainJson() {
    {
        const [emit, replay] = replayListen<[number]>({history: 16})
        const pair = createBinaryChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const received: any[] = []
        pair.b.onMessage(function oldClientMessage(raw) {
            const message = JSON.parse(raw)
            if (message.t == 'ev') received.push(message.ev.event[0])
        })
        pair.b.send(JSON.stringify({t: 'sub'}))
        pair.aText.length = 0
        emit(1)
        assert.deepEqual(received, [1])
        assert.equal(pair.aBinary.length, 0)
        assert.equal(JSON.parse(pair.aText[0]).t, 'ev')
        stop()
    }
    {
        const [emit, replay] = replayListen<[number]>({history: 16})
        const pair = createBinaryChannelPair()
        let off = function noOldServerSubscription() {}
        pair.a.onMessage(function oldServerMessage(raw) {
            const message = JSON.parse(raw)
            if (message.t != 'sub') return
            off = replay.line.on(function oldServerLive(ev) {
                pair.a.send(JSON.stringify({t: 'ev', ev}))
            })
        })
        const remote = channelReplayRemote<[number]>(pair.b)
        const got: number[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        emit(1)
        emit(2)
        assert.deepEqual(got, [1, 2])
        assert.equal(pair.aBinary.length, 0)
        assert.equal(pair.bBinary.length, 0)
        assert.deepEqual(pair.bText.map(raw => JSON.parse(raw).t), ['hello', 'sub'])
        off()
    }
}

async function testOrderedDelayedReady() {
    let current = {kind: 'keyframe', value: 7}
    const [emit, replay] = replayListen<[any]>({
        current: () => [current],
        history: 16,
    })
    const pair = createBinaryChannelPair({pauseAToB: true})
    const stop = serveReplayChannel(exposeReplay(replay), pair.a)
    const remote = channelReplayRemote<[any]>(pair.b)
    const got: any[] = []
    remote.line.on(ev => got.push(ev.event[0]))
    const keyframe = remote.keyframe()
    emit({kind: 'live', value: 8})
    await delay(0)
    assert.equal(got.length, 0)
    assert.equal(pair.bBinary.length, 0,
        'client keeps requests textual until the ordered ready reaches it')

    pair.releaseAToB()
    assert.deepEqual(got, [{kind: 'live', value: 8}])
    assert.deepEqual((await keyframe)?.event[0], current)
    stop()
}

async function testMalformedAndFailedFramesDoNotPoisonCaches() {
    {
        const [emit, replay] = replayListen<[any]>({history: 16})
        const pair = createBinaryChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[any]>(pair.b)
        const got: any[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        pair.a.sendBinary!(Uint8Array.from([0x52, 0x43, 0x48, 1, 20, 255]))
        emit({kind: 'after-malformed', value: 1})
        await delay(0)
        assert.deepEqual(got, [{kind: 'after-malformed', value: 1}])
        stop()
    }
    {
        let forward = function forwardLater(_ev: any) {}
        const source: any = {
            line: {
                on(cb: (ev: any) => void) {
                    forward = cb
                    return function offManualLine() {}
                },
            },
            since: () => null,
            keyframe: () => null,
            frame: () => null,
        }
        const pair = createBinaryChannelPair()
        const stop = serveReplayChannel(source, pair.a)
        const remote = channelReplayRemote<[any]>(pair.b)
        const got: any[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        pair.aBinary.length = 0
        pair.throwNextAToBBinary()
        let sendFailed = false
        try {
            for (let seq = 1; seq <= 64; seq++) {
                forward({seq, ts: seq, event: [{kind: 'quote', seq}]})
            }
        } catch (error: any) {
            sendFailed = error.message == 'synthetic binary send failure'
        }
        assert.equal(sendFailed, true)
        forward({seq: 65, ts: 65, event: [{kind: 'quote', seq: 65}]})
        await delay(0)
        assert.deepEqual(got.map(value => value.seq), [65],
            'rolled-back shape definitions are emitted again after a failed send')
        stop()
    }
}

async function testThrowingCloseStillTearsDown() {
    const textCbs = new Set<(data: string) => void>()
    const binaryCbs = new Set<(data: Uint8Array) => void>()
    const closeCbs = new Set<() => void>()
    const sentText: string[] = []
    let binaryAttempts = 0
    let unsubscribeCount = 0
    let forward = function forwardLater(_ev: any) {}
    const source: any = {
        line: {
            on(cb: (ev: any) => void) {
                forward = cb
                return function unsubscribeThrowingCloseSource() {
                    unsubscribeCount++
                }
            },
        },
        since: () => null,
        keyframe: () => null,
        frame: () => null,
    }
    const channel: ReplayMessageChannel = {
        send(data) {
            sentText.push(data)
        },
        sendBinary() {
            binaryAttempts++
            throw new Error('close flush failed')
        },
        onMessage(cb) {
            textCbs.add(cb)
            return function offCloseTestText() { textCbs.delete(cb) }
        },
        onBinaryMessage(cb) {
            binaryCbs.add(cb)
            return function offCloseTestBinary() { binaryCbs.delete(cb) }
        },
        onClose(cb) {
            closeCbs.add(cb)
            return function offCloseTestClose() { closeCbs.delete(cb) }
        },
    }
    const stop = serveReplayChannel(source, channel)
    const serverText = Array.from(textCbs)[0]
    serverText(JSON.stringify({t: 'hello', binary: 1}))
    serverText(JSON.stringify({t: 'sub', batch: 1}))
    forward({seq: 1, ts: 1, event: [{kind: 'pending'}]})

    let closeFailure: unknown
    try { stop() } catch (error) { closeFailure = error }
    assert.equal((closeFailure as Error)?.message, 'close flush failed')
    assert.equal(binaryAttempts, 1)
    assert.equal(unsubscribeCount, 1)
    assert.equal(textCbs.size, 0)
    assert.equal(binaryCbs.size, 0)
    assert.equal(closeCbs.size, 0)

    forward({seq: 2, ts: 2, event: [{kind: 'late'}]})
    serverText(JSON.stringify({t: 'req', id: 1, m: 'keyframe', a: []}))
    await delay(0)
    assert.equal(binaryAttempts, 1)
    assert.deepEqual(sentText.map(raw => JSON.parse(raw).t), ['ready'])
    stop()
}

function testFailedFirstSubscriptionCanRetry() {
    const textCbs = new Set<(data: string) => void>()
    let subscriptionAttempts = 0
    const channel: ReplayMessageChannel = {
        send(data) {
            if (JSON.parse(data).t != 'sub') return
            subscriptionAttempts++
            if (subscriptionAttempts == 1) throw new Error('first subscription send failed')
        },
        onMessage(cb) {
            textCbs.add(cb)
            return function offRetryText() { textCbs.delete(cb) }
        },
    }
    const remote = channelReplayRemote<[number]>(channel)
    assert.throws(function failFirstSubscription() {
        remote.line.on(function ignoredFirstSubscriber() {})
    }, /first subscription send failed/)
    const off = remote.line.on(function retrySubscriber() {})
    assert.equal(subscriptionAttempts, 2)
    off()
}

async function testFreshChannelOwnsFreshShapeCaches() {
    const [emit, replay] = replayListen<[any]>({history: 16})
    for (let session = 1; session <= 2; session++) {
        const pair = createBinaryChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[any]>(pair.b)
        const got: any[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        emit({kind: 'session', session, nested: {active: true}})
        await delay(0)
        assert.deepEqual(got, [{kind: 'session', session, nested: {active: true}}])
        stop()
    }
}

function testWebRtcBinaryAdapter() {
    const sent: Array<string | ArrayBuffer | ArrayBufferView> = []
    const dc: RtcDataChannel = {
        send(data) { sent.push(data) },
        close() {},
    }
    const channel = channelFromDataChannel(dc)
    const text: string[] = []
    const binary: number[][] = []
    channel.onMessage(value => text.push(value))
    channel.onBinaryMessage!(value => binary.push(Array.from(value)))

    dc.onmessage?.({data: 'text'})
    dc.onmessage?.({data: Uint8Array.from([1, 2, 3]).buffer})
    const source = Uint8Array.from([9, 8, 7, 6])
    dc.onmessage?.({data: new DataView(source.buffer, 1, 2)})
    channel.sendBinary!(Uint8Array.from([4, 5]))

    assert.equal(dc.binaryType, 'arraybuffer')
    assert.deepEqual(text, ['text'])
    assert.deepEqual(binary, [[1, 2, 3], [8, 7]])
    assert.ok(sent[0] instanceof Uint8Array)
}

async function main() {
    console.log('\n[replay-channel-binary] negotiated exact binary protocol')
    await testNewPeersUseExactBinaryMessages()
    console.log('  OK   rich live values, requests, responses, snapshots and JSON fallback')

    await testBinaryMicroBatchBounds()
    console.log('  OK   physical binary microbatches obey item and actual byte ceilings')

    await testMixedVersionsRemainJson()
    console.log('  OK   new/old and old/new peers remain on the historical JSON protocol')

    await testOrderedDelayedReady()
    console.log('  OK   delayed ready preserves ordered JSON-to-binary handoff')

    await testMalformedAndFailedFramesDoNotPoisonCaches()
    console.log('  OK   malformed receives and failed sends keep shape caches synchronized')

    await testThrowingCloseStillTearsDown()
    testFailedFirstSubscriptionCanRetry()
    console.log('  OK   throwing final flush still tears down every listener and subscription')

    await testFreshChannelOwnsFreshShapeCaches()
    console.log('  OK   reconnecting channels start with independent fresh shape caches')

    testWebRtcBinaryAdapter()
    console.log('  OK   WebRTC adapter separates strings, ArrayBuffers and typed views')
    console.log('\nall passed')
}

main().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
