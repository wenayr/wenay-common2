import assert from 'node:assert/strict'
import {createBinaryValueCodec} from '../../src/Common/events/replay-binary-value'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from '../../src/Common/events/replay-channel'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay} from '../../src/Common/events/replay-wire'

// A batched binary live event is encoded once, at emit time, straight into the
// frame that carries it: those bytes are its snapshot. Everything the 3.0.1
// snapshot guaranteed must still hold (frozen value, order across JSON
// fallbacks, frame sizes, shapes after a refused send), including events that
// arrive while a frame is still being sent by a synchronous transport.

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type tSent = {kind: 'text', data: string} | {kind: 'binary', data: Uint8Array}

function createChannelPair() {
    const text = {a: new Set<(data: string) => void>(), b: new Set<(data: string) => void>()}
    const binary = {a: new Set<(data: Uint8Array) => void>(), b: new Set<(data: Uint8Array) => void>()}
    const control = {failNextServerBinary: false, sent: [] as tSent[]}

    function side(me: 'a' | 'b', peer: 'a' | 'b'): ReplayMessageChannel {
        return {
            send(data) {
                if (me == 'a') control.sent.push({kind: 'text', data})
                for (const cb of [...text[peer]]) cb(data)
            },
            sendBinary(data) {
                if (me == 'a' && control.failNextServerBinary) {
                    control.failNextServerBinary = false
                    throw new Error('synthetic binary send failure')
                }
                const owned = data.slice()
                if (me == 'a') control.sent.push({kind: 'binary', data: owned})
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

function openLiveLine() {
    const [emit, replay] = replayListen<[any]>({history: 256})
    const pair = createChannelPair()
    const stop = serveReplayChannel(exposeReplay(replay), pair.server)
    const remote = channelReplayRemote<[any]>(pair.client)
    const got: any[] = []
    remote.line.on(ev => got.push(ev.event[0]))
    pair.control.sent.length = 0 // handshake done synchronously: only live traffic from here on
    return {emit, pair, stop, remote, got}
}

/** Decodes the server's live frames in order, like a peer that saw all of them. */
function liveFrames(sent: tSent[]) {
    const decoder = createBinaryValueCodec({
        magic: [0x52, 0x43, 0x48], version: 1, label: 'observer', callbackRefs: false,
        shapeCache: {maxEntries: 1000}, maxDepth: 36, maxBinaryBytes: 8_000_000, maxWireBytes: 16_000_000,
    })
    return sent.map(packet => packet.kind == 'text'
        ? {kind: 'text', events: JSON.parse(packet.data).evs as any[]}
        : {kind: 'binary', events: (decoder.decode(packet.data) as [number, any[]])[1]})
}

// ============================================================
// Snapshot and ordering guarantees
// ============================================================

async function checkMutationAfterEmitIsInvisible() {
    const {emit, stop, got} = openLiveLine()
    try {
        const value = {a: 1, nested: {b: 2}, list: [1, 2], when: new Date(10)}
        emit(value)
        value.a = 99
        value.nested.b = 99
        value.list.push(3)
        value.when.setTime(99)
        await delay(5)
        assert.deepEqual(got, [{a: 1, nested: {b: 2}, list: [1, 2], when: new Date(10)}], 'the peer sees the value as emitted')
    } finally { stop() }
}

async function checkJsonItemKeepsOrderBetweenFrames() {
    const {emit, pair, stop, got} = openLiveLine()
    try {
        emit({k: 1})
        emit({k: 2, omitted() {}}) // functions are not binary values: legacy JSON
        emit({k: 3})
        await delay(5)
        assert.deepEqual(got.map(ev => ev.k), [1, 2, 3], 'order survives the JSON fallback')
        assert.deepEqual(liveFrames(pair.control.sent).map(frame => frame.kind + ':' + frame.events.map(ev => ev.event[0].k)),
            ['binary:1', 'text:2', 'binary:3'], 'the JSON item splits the binary run into three packets')
    } finally { stop() }
}

async function checkFrameSizePolicy() {
    const {emit, pair, stop, got} = openLiveLine()
    try {
        emit('a'.repeat(40_000))
        emit('b'.repeat(40_000)) // together past 64 KB: a frame of its own
        await delay(5)
        emit('c'.repeat(100_000)) // alone past 64 KB: still one frame, sent at once
        emit({small: 1})
        await delay(5)
        assert.deepEqual(got.map(ev => typeof ev == 'string' ? ev[0] + ev.length : 'small'), ['a40000', 'b40000', 'c100000', 'small'])
        assert.deepEqual(liveFrames(pair.control.sent).map(frame => frame.events.length), [1, 1, 1, 1], 'one frame per event past the byte limit')
        // Later frames reference shapes defined above: always decode from the first frame.
        const earlier = pair.control.sent.length
        for (let index = 0; index < 130; index++) emit({n: index})
        assert.deepEqual(liveFrames(pair.control.sent).slice(earlier).map(frame => frame.events.length), [64, 64], 'full frames go out inside emit')
        await delay(5)
        assert.deepEqual(liveFrames(pair.control.sent).slice(earlier).map(frame => frame.events.length), [64, 64, 2], 'the rest follows at the micro-batch')
        assert.equal(got.length, 134)
    } finally { stop() }
}

async function checkRefusedSendRedefinesShapes() {
    const uncaught = captureUncaught()
    const {emit, pair, stop, got} = openLiveLine()
    try {
        pair.control.failNextServerBinary = true
        emit({alpha: 1, beta: 'x'}) // first use of the envelope and value shapes; the frame is refused
        await delay(5)
        emit({alpha: 2, beta: 'y'})
        await delay(5)
        assert.deepEqual(got, [{alpha: 2, beta: 'y'}], 'the peer decodes the next frame: its shapes are defined again')
        assert.equal(uncaught.errors.length, 1, 'the refused send is reported once')
    } finally {
        stop()
        uncaught.stop()
    }
}

async function checkRequestFlushesOpenFrameFirst() {
    // A bare source whose since() the test resolves, so the response is prepared
    // while live events sit in an open frame.
    let forward: (ev: any) => void = function notSubscribed() { throw new Error('line not subscribed') }
    let resolveSince: (value: unknown) => void = function notRequested() {}
    const source: any = {
        line: {on(cb: (ev: any) => void) { forward = cb; return function offManualLine() {} }},
        since: () => new Promise(resolve => { resolveSince = resolve }),
        keyframe: () => null,
        frame: () => null,
    }
    const pair = createChannelPair()
    const stop = serveReplayChannel(source, pair.server)
    const remote = channelReplayRemote<[any]>(pair.client)
    const got: any[] = []
    remote.line.on(ev => got.push(ev.seq))
    pair.control.sent.length = 0
    try {
        const response = remote.since(0)
        resolveSince([{seq: 1, ts: 1, event: [new Map([[1, 'x']])]}])
        forward({seq: 2, ts: 2, event: [{n: 2}]}) // queued behind the response continuation
        const answer = await response
        assert.deepEqual(got, [2], 'the open frame went out before the response')
        assert.ok(answer?.[0].event[0] instanceof Map, 'the response still travels as binary')
        assert.deepEqual(pair.control.sent.map(packet => packet.kind), ['binary', 'binary'], 'frame, then binary response')
    } finally { stop() }
}

// ============================================================
// Events arriving while a frame is being sent (synchronous transport)
// ============================================================

async function checkReentrantEmitKeepsTypesAndOrder() {
    const {emit, remote, stop} = openLiveLine()
    try {
        const seen: any[] = []
        remote.line.on(function consumeAndReply(ev) {
            const value = ev.event[0]
            seen.push(value)
            // Runs inside the server's frame send: the encoder is still owned by that frame.
            if (value.kind == 'ping') {
                emit({kind: 'pong', at: new Date(5), big: 7n, map: new Map([[1, 'x']])})
                emit({kind: 'pong-json', omitted() {}})
            }
        })
        emit({kind: 'ping'})
        emit({kind: 'after'})
        await delay(10)
        assert.deepEqual(seen.map(value => value.kind), ['ping', 'after', 'pong', 'pong-json'], 're-entrant events follow the frame in flight, in order')
        const pong = seen[2]
        assert.ok(pong.at instanceof Date && pong.big === 7n && pong.map instanceof Map, 'a re-entrant event keeps its binary types')
    } finally { stop() }
}

async function checkFrameBudgetRefusalTravelsAlone() {
    // One work budget spans a frame. An event refused only because its frame is
    // already heavy must travel in a frame of its own, not fall back to JSON.
    const {emit, pair, stop, got} = openLiveLine()
    try {
        const views = (count: number) => Array.from({length: count}, () => new Float64Array(0))
        emit({first: [views(10_000), views(10_000)]}) // ~60 KB, ~320k work units: frame stays open
        emit({second: Array.from({length: 5}, () => views(9_000))}) // ~720k units: fits only alone
        await delay(5)
        assert.equal(got.length, 2)
        assert.ok(got[1].second[4][8_999] instanceof Float64Array, 'the heavy event still travels as binary')
        assert.deepEqual(pair.control.sent.map(packet => packet.kind), ['binary', 'binary'])
    } finally { stop() }
}

// ============================================================
// Cost: one encode pass per live event
// ============================================================

function countEncodeInto(marker: string) {
    const original = TextEncoder.prototype.encodeInto
    const counter = {calls: 0, restore() { TextEncoder.prototype.encodeInto = original }}
    TextEncoder.prototype.encodeInto = function countingEncodeInto(this: TextEncoder, source: string, destination: Uint8Array) {
        if (source.includes(marker)) counter.calls++
        return original.call(this, source, destination)
    }
    return counter
}

async function checkOneEncodePassPerEvent() {
    const {emit, stop, got} = openLiveLine()
    const marker = 'encode-pass-marker'
    // Non-ASCII and longer than any short-string fast path: every pass goes through encodeInto.
    const payload = (index: number) => `Привет, мир — ${marker} #${index}`
    const counter = countEncodeInto(marker)
    try {
        for (let index = 0; index < 100; index++) emit({text: payload(index), n: index})
        await delay(5)
        counter.restore()
        assert.equal(got.length, 100)
        assert.equal(got[99].text, payload(99))
        assert.equal(counter.calls / 100, 1, `encode passes per live event: ${counter.calls / 100}`)
    } finally {
        counter.restore()
        stop()
    }
}

async function main() {
    let failures = 0
    const checks = [
        checkMutationAfterEmitIsInvisible,
        checkJsonItemKeepsOrderBetweenFrames,
        checkFrameSizePolicy,
        checkRefusedSendRedefinesShapes,
        checkRequestFlushesOpenFrameFirst,
        checkReentrantEmitKeepsTypesAndOrder,
        checkFrameBudgetRefusalTravelsAlone,
        checkOneEncodePassPerEvent,
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
    await delay(20)
    if (failures) {
        console.error(`${failures} replay channel encode-once checks failed`)
        process.exit(1)
    }
    console.log('PASS replay channel encode-once: one encode per live event, 3.0.1 snapshot, order and failure semantics kept')
}

main().catch(function fail(error) {
    console.error('FAIL', error)
    process.exit(1)
})
