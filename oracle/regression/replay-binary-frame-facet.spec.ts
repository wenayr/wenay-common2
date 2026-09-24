import assert from 'node:assert/strict'
import {isDeepStrictEqual, inspect} from 'node:util'
import {
    createBinaryValueCodec,
    createReplayBinaryCallbackRef,
    type BinaryValueCodecOptions,
} from '../../src/Common/events/replay-binary-value'

// The incremental frame facet (openBatch) encodes each item once, when it is
// added, into a frame that must be byte-identical to prepareEncode of the
// finished array. A rejected add must leave no trace, and the frame must hold
// the codec's pending-encode token until the transport settled it.

const CHANNEL_OPTIONS: BinaryValueCodecOptions = {
    // replay-channel.ts createReplayBinaryCodec
    magic: [0x52, 0x43, 0x48], version: 1, label: 'frame', callbackRefs: false,
    shapeCache: {maxEntries: 1000}, maxDepth: 36, maxBinaryBytes: 8_000_000, maxWireBytes: 16_000_000,
}

function codec(overrides: Partial<BinaryValueCodecOptions> = {}) {
    return createBinaryValueCodec({...CHANNEL_OPTIONS, ...overrides})
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
    return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) == 0
}

function nest(levels: number, leaf: unknown) {
    let value = leaf
    for (let index = 0; index < levels; index++) value = [value]
    return value
}

function encodeStats(stats: ReturnType<ReturnType<typeof codec>['stats']>) {
    const {encodeShapes, encodeFieldRefs, encodeKeyTextBytes, encodeDefinitions, encodeReferences, encodeRawShapes, pendingEncode} = stats
    return {encodeShapes, encodeFieldRefs, encodeKeyTextBytes, encodeDefinitions, encodeReferences, encodeRawShapes, pendingEncode}
}

// ============================================================
// Property: frame bytes == prepareEncode bytes, through rejections, rewinds and rollbacks
// ============================================================

function createRandom(seed: number) {
    let state = seed >>> 0
    function next() {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 0x100000000
    }
    return {next, int: (n: number) => Math.floor(next() * n)}
}

function createItems(random: ReturnType<typeof createRandom>) {
    const KEYS = ['a', 'b', 'id', 'price', '__proto__', 'constructor', 'toString', '', '0', 'é', '😀', 'symbol', 'qty', 'side', 'ts', 'x'.repeat(40)]

    function text() {
        const length = random.int(40)
        let out = ''
        for (let index = 0; index < length; index++) {
            const r = random.next()
            out += r < 0.7 ? String.fromCharCode(32 + random.int(90)) : r < 0.85 ? String.fromCharCode(random.int(0x800)) : r < 0.9 ? '\uD800' : '😀'
        }
        return out
    }

    function value(depth: number): unknown {
        const r = random.next()
        if (depth > 4 || r < 0.4) {
            const kind = random.int(9)
            if (kind == 0) return null
            if (kind == 1) return undefined
            if (kind == 2) return random.next() < 0.5
            if (kind == 3) return random.int(1000) - 500
            if (kind == 4) return (random.next() - 0.5) * 2 ** random.int(60)
            if (kind == 5 || kind == 6) return text()
            if (kind == 7) return BigInt(random.int(1 << 30)) * (random.next() < 0.5 ? -1n : 1n)
            return [new Date(random.int(1e12)), /a[b-c]+/gi, new Uint8Array([1, 2, random.int(255)]), new Map([[1, 'x']]), new Set(['s'])][random.int(5)]
        }
        if (random.next() < 0.3) {
            const items: unknown[] = new Array(random.int(5))
            for (let index = 0; index < items.length; index++) if (random.next() < 0.9) items[index] = value(depth + 1)
            return items
        }
        const object: Record<string, unknown> = random.next() < 0.15 ? Object.create(null) : {}
        const count = random.int(6)
        for (let index = 0; index < count; index++) {
            const key = random.next() < 0.85 ? KEYS[random.int(KEYS.length)] : text()
            Object.defineProperty(object, key, {value: value(depth + 1), enumerable: true, writable: true, configurable: true})
        }
        return object
    }

    function item(index: number): unknown {
        // Realistic repeated shapes, so definitions and references cross item boundaries.
        const kind = random.int(3)
        if (kind == 0) return {symbol: 'SYM' + (index % 50), price: 100 + index * 0.25, qty: index % 17, side: index % 2 ? 'buy' : 'sell', ts: 1727000000000 + index}
        if (kind == 1) return {seq: index, ts: 1727000000000 + index, event: [{path: ['books', 'SYM' + (index % 50), 'bids'], value: {price: 100 + index, qty: 3, orders: 2}, op: 'set'}]}
        return value(0)
    }

    function rejected(index: number): unknown {
        const kind = random.int(4)
        if (kind == 0) return {keep: index, nested: {fresh: index, omitted() {}}}
        if (kind == 1) {
            const cyclic: any = {cycleKey: index}
            cyclic.inner = {back: cyclic}
            return cyclic
        }
        if (kind == 2) return {deepKey: nest(34, {tooDeep: index})}
        return {symbolKey: index, [Symbol('hidden')]: 1}
    }

    return {item, rejected}
}

function checkFrameBytesMatchPrepareEncode() {
    const random = createRandom(20260924)
    const items = createItems(random)
    const batchCodec = codec({label: 'batch'})
    const twinCodec = codec({label: 'twin'})
    const decoder = codec({label: 'decoder'})
    let frames = 0, adds = 0, rejections = 0, rewinds = 0, rollbacks = 0
    for (let frame = 0; frame < 400; frame++) {
        const prefix = frame % 7 == 0 ? [5, 'prefix', {prefixKey: frame}] : [5]
        const batch = batchCodec.openBatch(prefix, 64)
        const accepted: unknown[] = []
        const count = 1 + random.int(40)
        for (let index = 0; index < count && accepted.length < 64; index++) {
            const bytesBefore = batch.byteLength()
            if (random.next() < 0.08) {
                assert.throws(function addRejected() { batch.add(items.rejected(index)) }, /^TypeError|^RangeError/)
                rejections++
                assert.equal(batch.byteLength(), bytesBefore, 'a rejected add writes nothing')
                assert.equal(batch.count(), accepted.length, 'a rejected add counts nothing')
                continue
            }
            const item = items.item(index)
            batch.add(item)
            adds++
            if (random.next() < 0.12) {
                batch.rewindLast()
                rewinds++
                assert.equal(batch.byteLength(), bytesBefore, 'rewindLast restores the frame length')
                assert.equal(batch.count(), accepted.length, 'rewindLast restores the item count')
                const replacement = random.next() < 0.5 ? item : items.item(index + 1000)
                batch.add(replacement)
                accepted.push(replacement)
                continue
            }
            accepted.push(item)
        }
        if (!accepted.length) {
            batch.rollback()
            continue
        }
        const finished = batch.finish()
        const reference = twinCodec.prepareEncode([...prefix, accepted])
        assert.ok(sameBytes(finished.wire, reference.wire),
            `frame ${frame}: incremental bytes equal prepareEncode bytes (${finished.wire.byteLength} vs ${reference.wire.byteLength})`)
        frames++
        if (random.next() < 0.1) {
            // A refused send: neither side commits, the decoder never sees the frame.
            finished.rollback()
            reference.rollback()
            rollbacks++
            continue
        }
        finished.commit()
        reference.commit()
        const decoded = decoder.decode(finished.wire)
        assert.ok(isDeepStrictEqual(decoded, [...prefix, accepted]),
            `frame ${frame}: the decoder stays in shape-id sync\n${inspect(decoded, {depth: 4}).slice(0, 400)}`)
        assert.deepEqual(encodeStats(batchCodec.stats()), encodeStats(twinCodec.stats()), `frame ${frame}: shape state and counters match the twin`)
    }
    console.log(`    ${frames} frames, ${adds} adds, ${rejections} rejected adds, ${rewinds} rewinds, ${rollbacks} rolled-back frames`)
    assert.ok(rejections > 50 && rewinds > 50 && rollbacks > 10, 'the property run exercised every path')
}

// ============================================================
// Atomic add: every budget a failed item touched is restored
// ============================================================

function checkRejectedAddsLeaveNoTrace() {
    const batchCodec = codec({label: 'batch'})
    const twinCodec = codec({label: 'twin'})
    const decoder = codec({label: 'decoder'})
    const cyclic: any = {cycleKey: 1}
    cyclic.inner = {back: cyclic}
    // Each refused item stages its shapes before it fails; the good twin reuses those keys.
    const rejected = {
        'function': {alpha: 1, beta: {gamma: 2, bad() {}}},
        'cycle': cyclic,
        // Items sit at depth 2: the leaf value lands at 37, one past the channel ceiling.
        'depth-35 item': {zeta: nest(33, {eta: 1})},
        'work limit': {theta: Array.from({length: 101}, () => new Array(10_000).fill(0))},
    }
    const good = [
        {alpha: 3, beta: {gamma: 4, bad: 5}},
        {cycleKey: 2, inner: {back: null}},
        {zeta: nest(32, {eta: 2})},
        {theta: [1, 2, 3]},
    ]
    const batch = batchCodec.openBatch([5], 64)
    const accepted: unknown[] = []
    for (const [name, value] of Object.entries(rejected)) {
        const before = {bytes: batch.byteLength(), count: batch.count(), stats: encodeStats(batchCodec.stats())}
        assert.throws(function addRejected() { batch.add(value) }, /^(TypeError|RangeError): batch: /, `${name} is refused with a labeled error`)
        assert.deepEqual({bytes: batch.byteLength(), count: batch.count(), stats: encodeStats(batchCodec.stats())}, before,
            `${name}: the refused item leaves the frame as it was`)
        const next = good[accepted.length]
        batch.add(next)
        accepted.push(next)
    }
    const finished = batch.finish()
    const reference = twinCodec.prepareEncode([5, accepted])
    assert.ok(sameBytes(finished.wire, reference.wire), 'shapes the refused items staged are gone: ids match prepareEncode')
    finished.commit()
    reference.commit()
    assert.deepEqual(decoder.decode(finished.wire), [5, accepted], 'the decoder assigns the same shape ids')
    // Committed shapes are referenced, not redefined, by the next frame of either kind.
    const second = batchCodec.openBatch([5], 64)
    second.add(good[0])
    const secondWire = second.finish()
    const secondReference = twinCodec.prepareEncode([5, [good[0]]])
    assert.ok(sameBytes(secondWire.wire, secondReference.wire), 'the next frame references the committed shapes')
    secondWire.commit()
    secondReference.commit()
    assert.deepEqual(decoder.decode(secondWire.wire), [5, [good[0]]])
}

function checkWorkBudgetIsRestored() {
    // One work budget spans the frame: a refused item must return what it spent.
    const batchCodec = codec({label: 'batch'})
    const twinCodec = codec({label: 'twin'})
    const heavy = (rows: number) => Array.from({length: rows}, () => new Array(10_000).fill(1))
    const batch = batchCodec.openBatch([5], 64)
    batch.add(heavy(60)) // ~600k units
    assert.throws(function addSpendsThenFails() { batch.add([...heavy(30), function omitted() {}]) }, /function values/)
    batch.add(heavy(35)) // fits only if the refused item's ~300k units were given back
    const finished = batch.finish()
    const reference = twinCodec.prepareEncode([5, [heavy(60), heavy(35)]])
    assert.ok(sameBytes(finished.wire, reference.wire))
    finished.commit()
    reference.commit()
}

function checkCallbackBudgetIsRestored() {
    const batchCodec = codec({label: 'batch', callbackRefs: true})
    const twinCodec = codec({label: 'twin', callbackRefs: true})
    const refs = (count: number, from: number) => Array.from({length: count}, (_, index) => createReplayBinaryCallbackRef(from + index))
    const batch = batchCodec.openBatch([5], 64)
    batch.add(refs(1000, 0))
    assert.throws(function addSpendsRefsThenFails() { batch.add([...refs(20, 1000), function omitted() {}]) }, /function values/)
    batch.add(refs(24, 2000)) // 1024 is the protocol ceiling: passes only if the 20 refs were given back
    assert.throws(function addOverCeiling() { batch.add(refs(1, 3000)) }, /callback reference count/)
    const finished = batch.finish()
    const reference = twinCodec.prepareEncode([5, [refs(1000, 0), refs(24, 2000)]])
    assert.ok(sameBytes(finished.wire, reference.wire))
    finished.commit()
    reference.commit()
}

function checkItemLimitAndCountPatch() {
    const batchCodec = codec({label: 'batch'})
    const twinCodec = codec({label: 'twin'})
    const batch = batchCodec.openBatch([5], 3)
    for (let index = 0; index < 3; index++) batch.add({n: index})
    const bytes = batch.byteLength()
    assert.throws(function addPastLimit() { batch.add({n: 3}) }, RangeError)
    assert.equal(batch.byteLength(), bytes, 'the item limit refuses before writing')
    const finished = batch.finish()
    const reference = twinCodec.prepareEncode([5, [{n: 0}, {n: 1}, {n: 2}]])
    assert.ok(sameBytes(finished.wire, reference.wire), 'the patched count equals a varuint count')
    finished.rollback()
    reference.rollback()
    assert.throws(function tooManyItems() { batchCodec.openBatch([5], 128) }, RangeError, 'a count must fit one varuint byte')
    assert.throws(function noItems() { batchCodec.openBatch([5], 0) }, RangeError)
}

// ============================================================
// Token discipline: an open or unsettled frame owns the encoder
// ============================================================

function checkOpenFrameOwnsTheEncoder() {
    const shared = codec({label: 'owner'})
    const pending = /prepared encode must be committed or rolled back/
    const batch = shared.openBatch([5], 64)
    batch.add({a: 1})
    assert.equal(shared.stats().pendingEncode, true, 'an open frame holds the pending-encode token')
    assert.throws(function prepareWhileOpen() { shared.prepareEncode(1) }, pending)
    assert.throws(function encodeWhileOpen() { shared.encode(1) }, pending)
    assert.throws(function measureWhileOpen() { shared.measureEncode(1) }, pending)
    assert.throws(function secondFrameWhileOpen() { shared.openBatch([5], 64) }, pending)
    assert.throws(function resetWhileOpen() { shared.reset() }, /cannot reset with an unsettled prepared encode/)
    assert.deepEqual(shared.decode(codec({label: 'other'}).encode({b: 2})), {b: 2}, 'decoding is not blocked')

    const finished = batch.finish()
    assert.throws(function addAfterFinish() { batch.add({a: 2}) }, /batch is finished/)
    assert.throws(function rewindAfterFinish() { batch.rewindLast() }, /batch is finished/)
    assert.throws(function finishTwice() { batch.finish() }, /batch is finished/)
    assert.throws(function prepareBeforeSettle() { shared.prepareEncode(1) }, pending, 'a finished frame holds the token until settled')
    finished.commit()
    finished.commit()
    finished.rollback()
    assert.equal(shared.stats().pendingEncode, false, 'commit releases the token, repeats are no-ops')
    assert.equal(shared.stats().encodeShapes, 1, 'commit publishes the staged shape')

    const abandoned = shared.openBatch([5], 64)
    abandoned.add({c: 3})
    abandoned.rollback()
    assert.equal(shared.stats().pendingEncode, false, 'rollback of an open frame releases the token')
    assert.equal(shared.stats().encodeShapes, 1, 'an abandoned frame publishes nothing')
    assert.throws(function addAfterRollback() { abandoned.add({c: 4}) }, /batch is finished/)
    shared.reset()

    const empty = shared.openBatch([5], 64)
    assert.throws(function rewindWithoutAdd() { empty.rewindLast() }, /no item to rewind/)
    empty.add({d: 1})
    empty.rewindLast()
    assert.throws(function rewindTwice() { empty.rewindLast() }, /no item to rewind/)
    empty.rollback()

    assert.throws(function badPrefix() { shared.openBatch([function omitted() {}], 64) }, /function values/)
    assert.equal(shared.stats().pendingEncode, false, 'a refused prefix takes no token')
}

function checkRolledBackFrameRedefinesShapes() {
    const sender = codec({label: 'sender'})
    const receiver = codec({label: 'receiver'})
    const tick = {symbol: 'SYM1', price: 100.25, qty: 3}
    const lost = sender.openBatch([5], 64)
    lost.add(tick)
    lost.finish().rollback() // the transport refused it: the peer never saw the definition
    const next = sender.openBatch([5], 64)
    next.add(tick)
    const finished = next.finish()
    finished.commit()
    assert.deepEqual(receiver.decode(finished.wire), [5, [tick]], 'the next frame defines the shape again')
}

let failures = 0
const checks = [
    checkFrameBytesMatchPrepareEncode,
    checkRejectedAddsLeaveNoTrace,
    checkWorkBudgetIsRestored,
    checkCallbackBudgetIsRestored,
    checkItemLimitAndCountPatch,
    checkOpenFrameOwnsTheEncoder,
    checkRolledBackFrameRedefinesShapes,
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
    console.error(`${failures} replay binary frame facet checks failed`)
    process.exit(1)
}
console.log('PASS replay binary frame facet: incremental frames equal prepareEncode, refused adds leave no trace, open frames own the encoder')
