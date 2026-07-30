// ============================================================
// Allocation-light RPC wire metrics
// ============================================================

import {deepStrictEqual, throws} from 'node:assert'
import {
    rpcResultWireMetrics,
    rpcResultWireMetricsFast,
} from '../src/Common/rcp/rpc-wire-size'

function same(value: unknown, firstBinaryIndex = 0) {
    deepStrictEqual(
        rpcResultWireMetricsFast(value, firstBinaryIndex),
        rpcResultWireMetrics(value, firstBinaryIndex),
    )
}

const unsafe: Record<string, unknown> = {safe: 1}
Object.defineProperty(unsafe, '__proto__', {
    configurable: true,
    enumerable: true,
    value: {ignored: true},
})
unsafe.constructor = {ignored: true}
unsafe.prototype = {ignored: true}

const sparse: unknown[] = []
sparse.length = 5
sparse[1] = undefined
sparse[2] = function omittedFunction() {}
sparse[3] = Symbol('omitted-symbol')
sparse[4] = 'tail'

const plainCases: unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    1.25,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '',
    'plain ASCII / text',
    'quote " slash \\ controls \b\t\n\f\r\u0001',
    'кириллица 😀 \ud800 \udc00',
    [1, 'two', null, undefined, function omitted() {}, Symbol('array-symbol')],
    sparse,
    {a: 1, b: 'two', c: true, d: null, omitted: undefined},
    {nested: [{a: 'x'}, {b: ['y', 'z']}]},
    Object.assign(Object.create(null), {nullPrototype: 'safe'}),
    unsafe,
    [new Uint8Array(7), new DataView(new ArrayBuffer(11)), new ArrayBuffer(13)],
]

for (const value of plainCases) {
    same(value)
    same(value, 9)
    same(value, 99)
}

const markerCollision = {'$_d': {nested: new Date(7)}}
const customJson = {
    value: 'ignored',
    toJSON() {
        return {custom: 'result'}
    },
}
const richCases: unknown[] = [
    new Date(123),
    /a+/gi,
    new Map<unknown, unknown>([['date', new Date(5)]]),
    new Set<unknown>([1, 2n]),
    12345678901234567890n,
    markerCollision,
    customJson,
    {plainPrefix: 'x'.repeat(256 * 1024), richTail: new Date(9)},
]

for (const value of richCases) {
    same(value)
    same([value, new Uint8Array(3)], 8)
}

let accessorReads = 0
const changingAccessor: Record<string, unknown> = {plain: 'prefix'}
Object.defineProperty(changingAccessor, 'late', {
    configurable: true,
    enumerable: true,
    get() {
        accessorReads++
        return accessorReads == 1 ? new Date(7) : 'changed'
    },
})
const accessorExpected = rpcResultWireMetrics(changingAccessor)
accessorReads = 0
deepStrictEqual(rpcResultWireMetricsFast(changingAccessor), accessorExpected)
deepStrictEqual(accessorReads, 1)

for (const invalidIndex of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    same([new Uint8Array(4)], invalidIndex)
}

const cycle: any = {name: 'cycle'}
cycle.self = cycle
throws(() => rpcResultWireMetrics(cycle))
throws(() => rpcResultWireMetricsFast(cycle))

console.log('RPC fast wire-size equivalence test: OK')
