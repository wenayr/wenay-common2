// =====================================================================
//  CBarsBase.tickSize: the auto-computed value the class is built around.
//
//  `tickSize` is meant to fall back to the greatest common divisor of the closes when the
//  caller did not supply one. The whole class is wired for it: `CBarsMutableBase` keeps a
//  `_tickSizeAuto` flag whose only job is to zero `_ticksize` on every mutation, and the
//  line that does it says so — "new/updated bar changes closes -> reset tickSize cache".
//  Zero is the invalid-cache marker, and `CQuotesHistory.tickSize` reads it that way
//  (`if (!this._ticksize) ...`).
//
//  The getter, however, was written `this._ticksize ??= gcd(closes)`, while the constructor
//  stores `tickSize ? tickSize : 0` — always a number, never nullish. So the fallback never
//  ran, every reset was inert, and `tickSize` reported 0 forever for bars constructed
//  without an explicit value. It propagates: `concat`, `slice`, `createCopy` and
//  `CQuotesHistory.tickSize` all read it.
//
//  `CBarsInternal` in MarketData deliberately opts out with its own `?? 0` getter. It is
//  module-private, so there is nothing to pin here: overriding the getter outright is what
//  keeps it out, and no change to the base getter can reach it.
// =====================================================================
import {TF} from '../../src/Common/Time'
import {CBar, CBars, CBarsMutable} from '../../src/Exchange/Bars'

type Test = {name: string, fn: () => void}
const tests: Test[] = []
function test(name: string, fn: () => void) { tests.push({name, fn}) }
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

const t0 = new Date(Date.UTC(2026, 0, 1))
const at = (index: number) => new Date(t0.valueOf() + index * TF.M1.msec)
/** A bar whose close is what matters here; the rest is filler on the same grid. */
const bar = (index: number, close: number) => new CBar(at(index), close, close, close, close)

// ---------------------------------------------------------------------
// The fallback runs
// ---------------------------------------------------------------------
test('tickSize is derived from the closes when none was given', () => {
    const bars = new CBars(TF.M1, [bar(0, 10), bar(1, 20), bar(2, 30)])
    assert(bars.tickSize === 10, 'expected the gcd of 10/20/30 = 10, got ' + bars.tickSize)

    const finer = new CBars(TF.M1, [bar(0, 1.10), bar(1, 1.15), bar(2, 1.25)])
    assert(finer.tickSize === 0.05, 'expected a 0.05 grid, got ' + finer.tickSize)
})

test('an explicit tickSize is kept as given', () => {
    const bars = new CBars(TF.M1, [bar(0, 10), bar(1, 20)], 0.25)
    assert(bars.tickSize === 0.25, 'explicit value overwritten: ' + bars.tickSize)
})

test('an empty series reports no tick size instead of throwing', () => {
    assert(new CBars(TF.M1, []).tickSize === 0, 'an empty series should report 0')
})

// ---------------------------------------------------------------------
// The invalidation the mutable class already performs now means something
// ---------------------------------------------------------------------
test('a pushed bar re-derives the tick size', () => {
    const bars = new CBarsMutable(TF.M1, [bar(0, 10), bar(1, 20)])
    assert(bars.tickSize === 10, 'before the push: ' + bars.tickSize)
    bars.push(bar(2, 15))
    assert(bars.tickSize === 5, 'after a close of 15 the grid is 5, got ' + bars.tickSize)
})

test('an explicit tick size is not re-derived on mutation', () => {
    const bars = new CBarsMutable(TF.M1, [bar(0, 10)], 2)
    bars.push(bar(1, 15))
    assert(bars.tickSize === 2, 'auto-recompute leaked into an explicitly sized series: ' + bars.tickSize)
})

function main() {
    let failed = 0
    for (const t of tests) {
        try {
            t.fn()
            console.log('PASS  ' + t.name)
        } catch (error) {
            failed++
            console.log('FAIL  ' + t.name + '\n      ' + (error as Error).message)
        }
    }
    console.log((failed == 0 ? 'PASS' : 'FAIL') + ' bars-ticksize: ' + (tests.length - failed) + '/' + tests.length)
    process.exit(failed == 0 ? 0 : 1)
}

main()
