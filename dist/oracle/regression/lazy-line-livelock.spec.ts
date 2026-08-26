// =====================================================================
//  Lazy line: a catch-up larger than the byte budget must still make progress.
//
//  Production shape: a subscriber that finished its first pass, went away (tab in the
//  background, phone off the network, process restart with a persisted cursor), and came
//  back after the host had rewritten more data than fits in one read window. That is the
//  case this line exists for — it is the reason the cursor is persistable at all.
//
//  `read()` walks in two halves: catch-up (keys at or before the cursor whose revision
//  moved) and fill (keys past the cursor). Only the fill half advances `cursor.key`, and
//  `cursor.revision` advances only when the catch-up half completed. So when catch-up
//  alone spends the budget, NEITHER field moves and the returned cursor is identical to
//  the one passed in. Every subsequent read redoes the same work: the subscriber gets
//  the same prefix forever and the rest of its mirror stays stale.
//
//  The failure is silent, not loud. Once the first pass is done `remaining` is 0, so the
//  read keeps reporting `filled: true` while the mirror disagrees with the host.
//
//  This test drives the host directly rather than through `syncStoreLazyLine`, because a
//  livelock has no failure to observe through the subscriber's timers — only the absence
//  of convergence, which is what is asserted here.
// =====================================================================
import {createStore} from '../../src/Common/Observe/store'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {exposeStoreLazyLine, type StoreLazyChunkV1, type StoreLazyCursor, type StoreLazyReadV1} from '../../src/Common/Observe/store-lazy-line'

type Test = {name: string, fn: () => void | Promise<void>}
const tests: Test[] = []
function test(name: string, fn: Test['fn']) { tests.push({name, fn}) }
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

const KEY_COUNT = 24
const VALUE_CHARS = 4000
// Small enough that the catch-up for a whole-store rewrite (~96 KB) cannot fit, which is
// the same ratio a real subscriber hits with the 256 KiB default and a few megabytes of
// changed values.
const WINDOW = 8 * 1024

const keyAt = (i: number) => 'k' + String(i).padStart(2, '0')

function seedState(marker: string) {
    const state: Record<string, string> = {}
    for (let i = 0; i < KEY_COUNT; i++) state[keyAt(i)] = marker.repeat(VALUE_CHARS)
    return state
}

/** One read, applied into a mirror exactly as `syncStoreLazyLine` applies it. */
function pump(
    host: ReturnType<typeof exposeStoreLazyLine>,
    mirror: Record<string, unknown>,
    cursor: StoreLazyCursor | null,
) {
    const delivered: string[] = []
    const result = host.api.read({cursor, maxBytes: WINDOW}, function applyChunk(chunk: StoreLazyChunkV1) {
        for (const key of Object.keys(chunk.values)) { mirror[key] = chunk.values[key]; delivered.push(key) }
        for (const key of chunk.deleted) { delete mirror[key]; delivered.push(key) }
    }) as StoreLazyReadV1
    return {result, delivered}
}

function sameCursor(a: StoreLazyCursor, b: StoreLazyCursor) {
    return a.key === b.key && a.revision === b.revision && a.lineId === b.lineId
        && JSON.stringify((a as any).catchUp ?? null) === JSON.stringify((b as any).catchUp ?? null)
}

// ---------------------------------------------------------------------
// A returning subscriber whose catch-up exceeds one window still converges
// ---------------------------------------------------------------------
test('lazy line: catch-up bigger than the read window still advances the cursor', async () => {
    const store = createStore(seedState('a'))
    const host = exposeStoreLazyLine(store, {windowBytes: WINDOW, chunkBytes: 2048})
    const mirror: Record<string, unknown> = {}

    // --- first pass, exactly as a fresh subscriber runs it ---
    let cursor: StoreLazyCursor | null = null
    let reads = 0
    while (reads++ < 200) {
        const {result} = pump(host, mirror, cursor)
        cursor = result.cursor
        if (result.filled) break
    }
    assert(cursor != null && cursor.key == keyAt(KEY_COUNT - 1), 'precondition: the first pass reached the last key')
    assert(Object.keys(mirror).length == KEY_COUNT, 'precondition: the mirror holds every key after the first pass')

    // --- the subscriber is away; the host rewrites everything ---
    const fresh = seedState('b')
    for (const key of Object.keys(fresh)) (store.state as Record<string, string>)[key] = fresh[key]
    await flushReactive(store.state)

    const catchUpBytes = KEY_COUNT * VALUE_CHARS
    assert(catchUpBytes > WINDOW * 4, 'precondition: the catch-up cannot fit in one read window')

    // --- it comes back and polls ---
    // Enough reads to carry the whole catch-up several times over, so a failure here is a
    // livelock and not merely a slow line.
    const budgetedReads = Math.ceil(catchUpBytes / WINDOW) * 4
    let stalled = 0
    let progressed = false
    for (let i = 0; i < budgetedReads; i++) {
        const before = cursor!
        const {result, delivered} = pump(host, mirror, before)
        cursor = result.cursor
        if (sameCursor(before, cursor) && delivered.length > 0) stalled++
        else progressed = true
        if (Object.values(mirror).every(value => value === fresh[keyAt(0)])) break
    }

    assert(progressed, 'the cursor never moved across ' + budgetedReads + ' reads: catch-up is livelocked')
    assert(stalled == 0, 'a read re-sent data without moving the cursor ' + stalled + ' times')

    const stale = Object.keys(fresh).filter(key => mirror[key] !== fresh[key])
    assert(stale.length == 0, 'the mirror never converged; still stale: ' + stale.slice(0, 5).join(', ')
        + ' (' + stale.length + ' keys)')

    host.close()
})

// ---------------------------------------------------------------------
// Control: deletions already converge, and must keep doing so
// ---------------------------------------------------------------------
// This one PASSES on the broken code and is here to stay passing. Tombstones are walked
// before any value-carrying key and cost `key.length + 4` bytes each, so a deletion
// catch-up drains before the budget is anywhere near spent. That is worth pinning,
// because a mirror that keeps a deleted key is worse than one that keeps a stale value:
// nothing later contradicts it. Any fix to the walk order must not lose this property.
test('lazy line: a large deletion catch-up removes every key from the mirror', async () => {
    const store = createStore(seedState('a'))
    const host = exposeStoreLazyLine(store, {windowBytes: WINDOW, chunkBytes: 2048})
    const mirror: Record<string, unknown> = {}

    let cursor: StoreLazyCursor | null = null
    for (let i = 0; i < 200; i++) {
        const {result} = pump(host, mirror, cursor)
        cursor = result.cursor
        if (result.filled) break
    }
    assert(Object.keys(mirror).length == KEY_COUNT, 'precondition: the first pass filled the mirror')

    // Half the keys are rewritten (they cost bytes and are walked first in key order),
    // the other half deleted. The rewrites alone exceed the window, so on the broken code
    // the walk never reaches the deletions.
    const state = store.state as Record<string, string>
    for (let i = 0; i < KEY_COUNT; i++) {
        if (i < KEY_COUNT / 2) state[keyAt(i)] = 'c'.repeat(VALUE_CHARS)
        else delete state[keyAt(i)]
    }
    await flushReactive(store.state)

    for (let i = 0; i < 200; i++) {
        const {result} = pump(host, mirror, cursor)
        cursor = result.cursor
        if (Object.keys(mirror).length == KEY_COUNT / 2) break
    }

    const ghosts = Object.keys(mirror).filter(key => !Object.prototype.hasOwnProperty.call(state, key))
    assert(ghosts.length == 0, 'the mirror kept deleted keys: ' + ghosts.slice(0, 5).join(', '))

    host.close()
})

async function main() {
    let failed = 0
    for (const t of tests) {
        try {
            await t.fn()
            console.log('PASS  ' + t.name)
        } catch (error) {
            failed++
            console.log('FAIL  ' + t.name + '\n      ' + (error as Error).message)
        }
    }
    console.log((failed == 0 ? 'PASS' : 'FAIL') + ' lazy-line-livelock: ' + (tests.length - failed) + '/' + tests.length)
    process.exit(failed == 0 ? 0 : 1)
}

void main()
