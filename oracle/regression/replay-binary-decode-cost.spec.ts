import assert from 'node:assert/strict'
import {createBinaryValueCodec} from '../../src/Common/events/replay-binary-value'
import {ReplayMessageChannel, serveReplayChannel} from '../../src/Common/events/replay-channel'
import {replayListen} from '../../src/Common/events/replay-listen'
import {exposeReplay} from '../../src/Common/events/replay-wire'

// Hostile frames are built byte by byte: a peer is not bound to our encoder.
// Protocol v1 value tags (replay-binary-value.ts VALUE_TAG).
const TAG = {ARRAY: 9, REGEXP: 12, ARRAY_BUFFER: 15, DATA_VIEW: 16, TYPED_ARRAY: 17, STRING_UTF8: 6} as const
const HEADER = [0x52, 0x43, 0x48, 1] // replay channel magic + version
// Generous both ways: the fixed decoder needs tens of milliseconds for each frame
// below, the quadratic scan and the unbounded leaf flood took 2-4 seconds each.
// Only the decode is timed, and frames are built without JS arrays of their bytes:
// spreading 1 MB into an array cost more than the decode (0.1-0.9 s on Linux CI) and
// its garbage was collected inside the next timed decode.
const BLOCK_BOUND_MS = 500

function createChannelCodec(label: string) {
    // The replay channel's own configuration (replay-channel.ts createReplayBinaryCodec).
    return createBinaryValueCodec({
        magic: [0x52, 0x43, 0x48], version: 1, label, callbackRefs: false,
        shapeCache: {maxEntries: 1000}, maxDepth: 36, maxBinaryBytes: 8_000_000, maxWireBytes: 16_000_000,
    })
}

function varuint(value: number) {
    const out: number[] = []
    do {
        let byte = value % 128
        value = Math.floor(value / 128)
        if (value) byte |= 0x80
        out.push(byte)
    } while (value)
    return out
}

/** Concatenates frame parts straight into one byte array. */
function bytesOf(...parts: readonly (readonly number[] | Uint8Array)[]) {
    const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
    let at = 0
    for (const part of parts) {
        bytes.set(part, at)
        at += part.length
    }
    return bytes
}

function utf8(text: string) {
    const bytes = Buffer.from(text, 'utf8')
    return bytesOf([TAG.STRING_UTF8, ...varuint(bytes.length)], bytes)
}

/** One maximal (1 MB) RegExp source: '(?<' repeated with no closing '>'. */
function unclosedGroupFrame() {
    return bytesOf(HEADER, [TAG.REGEXP], utf8('(?<'.repeat(333_333)), utf8(''))
}

/** outer x inner copies of one leaf, as nested arrays within the item limit. */
function leafFrame(leaf: readonly number[], outer = 99, inner = 10_000) {
    const innerHeader = [TAG.ARRAY, ...varuint(inner)]
    const outerHeader = [TAG.ARRAY, ...varuint(outer)]
    const innerBytes = innerHeader.length + leaf.length * inner
    const bytes = new Uint8Array(HEADER.length + outerHeader.length + outer * innerBytes)
    bytes.set([...HEADER, ...outerHeader])
    let at = HEADER.length + outerHeader.length
    for (let o = 0; o < outer; o++) {
        bytes.set(innerHeader, at)
        at += innerHeader.length
        for (let i = 0; i < inner; i++) {
            bytes.set(leaf, at)
            at += leaf.length
        }
    }
    return bytes
}

function timedOnce(run: () => unknown) {
    const started = performance.now()
    let error: unknown
    try { run() }
    catch (caught) { error = caught }
    return {ms: performance.now() - started, error}
}

/** The fastest of three runs: a GC pause or a cold first run cannot fail the bound,
 *  while a quadratic or unbounded decoder misses it by seconds on every run. */
function timed(run: () => unknown) {
    let fastest = timedOnce(run)
    for (let round = 1; round < 3; round++) {
        const next = timedOnce(run)
        if (next.ms < fastest.ms) fastest = next
    }
    return fastest
}

// ============================================================
// RegExp source validation must stay linear in the source
// ============================================================

function checkCodecRegExpScan() {
    const codec = createChannelCodec('regexp scan')
    const frame = unclosedGroupFrame()
    const {ms, error} = timed(function decodeUnclosedGroups() { codec.decode(frame) })
    console.log(`    codec: 1 MB '(?<' source rejected in ${ms.toFixed(0)} ms`)
    assert.ok(error instanceof Error, 'the invalid RegExp source is still rejected')
    assert.ok(ms < BLOCK_BOUND_MS, `decode blocked ${ms.toFixed(0)} ms (bound ${BLOCK_BOUND_MS} ms)`)
}

function checkChannelRegExpScan() {
    // Any peer that negotiated binary reaches this decoder with one message.
    let text: (data: string) => void = function noText() {}
    let binary: (data: Uint8Array) => void = function noBinary() {}
    const channel: ReplayMessageChannel = {
        send() {},
        sendBinary() {},
        onMessage(cb) { text = cb },
        onBinaryMessage(cb) { binary = cb },
    }
    const [, replay] = replayListen<[number]>({history: 1})
    const stop = serveReplayChannel(exposeReplay(replay), channel)
    try {
        text(JSON.stringify({t: 'hello', binary: 1}))
        const frame = unclosedGroupFrame()
        const {ms, error} = timed(function receiveHostileFrame() { binary(frame) })
        console.log(`    channel: hostile frame dropped after ${ms.toFixed(0)} ms of blocked event loop`)
        assert.equal(error, undefined, 'the server drops an undecodable frame')
        assert.ok(ms < BLOCK_BOUND_MS, `server blocked ${ms.toFixed(0)} ms (bound ${BLOCK_BOUND_MS} ms)`)
    } finally { stop() }
}

// ============================================================
// Native leaves (binary views, RegExp) are charged by their real cost
// ============================================================

const NATIVE_LEAVES = {
    'empty Uint8Array': [TAG.TYPED_ARRAY, 2, 0],
    'empty ArrayBuffer': [TAG.ARRAY_BUFFER, 0],
    'empty DataView': [TAG.DATA_VIEW, 0],
    'empty RegExp': [TAG.REGEXP, ...utf8(''), ...utf8('')],
} as const

// A flood must stop where the budget ends, so it costs about as much as the largest legal
// frame of the same leaves (60k, see checkEncoderChargesTheSame); decoding all 990k leaves
// first would cost ~16x. A ratio on the same machine, unlike an absolute bound, does not
// depend on how fast that machine allocates binary views (3-10x slower on Linux CI).
const FLOOD_RATIO_BOUND = 4

function checkHostileLeafFrames() {
    for (const [name, leaf] of Object.entries(NATIVE_LEAVES)) {
        const codec = createChannelCodec('leaf flood')
        const legalFrame = leafFrame(leaf, 6)
        const frame = leafFrame(leaf)
        const legal = timed(function decodeLegalLeaves() { codec.decode(legalFrame) })
        const {ms, error} = timed(function decodeLeafFlood() { codec.decode(frame) })
        console.log(`    ${(frame.byteLength / 1e6).toFixed(1)} MB frame of 990k ${name}: ${ms.toFixed(0)} ms `
            + `(60k legal: ${legal.ms.toFixed(0)} ms), ` + (error ? (error as Error).message : 'accepted'))
        assert.equal(legal.error, undefined, `60k ${name} leaves fit the decode work budget`)
        assert.match(String((error as Error)?.message), /work limit/, `990k ${name} leaves exceed the decode work budget`)
        // +25 ms keeps a few milliseconds of noise from failing the ratio of two tiny timings
        assert.ok(ms < FLOOD_RATIO_BOUND * legal.ms + 25,
            `${name} flood took ${ms.toFixed(0)} ms, ${(ms / legal.ms).toFixed(1)}x the 60k legal frame (bound ${FLOOD_RATIO_BOUND}x)`)
    }
}

function checkEncoderChargesTheSame() {
    // The encoder must refuse exactly what the decoder refuses: a frame the peer
    // rejects would desynchronize their shape caches.
    function views(outer: number) {
        return Array.from({length: outer}, () => Array.from({length: 10_000}, () => new Uint8Array(0)))
    }
    const codec = createChannelCodec('leaf budget')
    const accepted = codec.decode(codec.encode(views(6))) as Uint8Array[][]
    assert.equal(accepted.length * accepted[0].length, 60_000, 'a large but legal view count still round-trips')
    assert.throws(function encodeTooManyViews() { codec.encode(views(7)) }, /work limit/,
        '70k views exceed the encode work budget')
    assert.throws(function decodeTooManyViews() {
        codec.decode(leafFrame(NATIVE_LEAVES['empty Uint8Array'], 7))
    }, /work limit/, 'the decoder refuses the same 70k views')
}

let failures = 0
const checks = [
    checkCodecRegExpScan,
    checkChannelRegExpScan,
    checkHostileLeafFrames,
    checkEncoderChargesTheSame,
]
for (const check of checks) {
    try {
        check()
        console.log(`PASS ${check.name}`)
    } catch (error) {
        failures++
        console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
    }
}
if (failures) {
    console.error(`${failures} replay binary decode-cost checks failed`)
    process.exit(1)
}
console.log('PASS replay binary decode cost: linear RegExp validation, native leaves bounded by the work budget')
