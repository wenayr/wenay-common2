// ============================================================
//  batch.ts — L0 batching core (0 external deps)
//
//  A tiny opt-in scheduler: while a batch is open, per-node
//  notifications are COALESCED — a node set N times inside one
//  batch flushes ONCE, carrying its final state. Outside a batch
//  it is a pure no-op signal, so the L0/L1 fast path pays nothing.
//
//  Design (grounded in alien-signals findings): keep emit cold
//  when NOT batching. `enqueue` is the single hook callers use —
//  it answers "should I emit now, or did I defer?" via its return,
//  so the emit site stays a single `if`.
//
//  Coalescing is PER NODE: the node object is the identity key,
//  its latest `run` thunk overwrites any earlier one, and on flush
//  each node runs its final thunk exactly once.
//
//  HONEST SCOPE: this coalesces per-node emits (and, via
//  schedule.ts, effect runs). Perfect glitch-free diamond
//  coalescing — an intermediate computed that recomputes twice
//  within a flush — is OUT OF SCOPE here and deferred to a future
//  glitch-free pull pass.
// ============================================================

// module-scoped batch state — depth counter + the coalescing queue.
let batchDepth = 0
// true while flush() is draining — a thunk that dirties a node during
// flush should re-queue (coalesced) for a follow-up drain, not emit
// inline, so cascades stay glitch-coalesced within the same flush.
let flushing = false
// node identity -> its latest deferred thunk. A Map preserves
// insertion order, so flush runs nodes in first-dirtied order while
// still coalescing repeat dirties of the same node to one entry.
const queued = new Map<object, () => void>()

// ============================================================
//  api — batch / inBatch / enqueue
// ============================================================

// are we inside an open batch right now?
export function inBatch() { return batchDepth > 0 }

// Should an emit DEFER rather than fire inline? True inside an open batch
// OR mid-flush (so a cascade — a thunk that dirties a node during flush —
// coalesces into the same drain instead of replaying inline). This is the
// cheap predicate the L0 emit path gates on to stay cold when neither holds.
export function deferring() { return batchDepth > 0 || flushing }

// Defer a node's notification while batching. Returns true when the
// run was DEFERRED (caller must NOT emit now — flush will), false
// when not batching (caller should emit immediately — the fast path).
// Repeat calls for the same node coalesce: the latest `run` wins and
// the node still flushes only once.
export function enqueue(node: object, run: () => void) {
    if (batchDepth == 0 && !flushing) return false
    queued.set(node, run)
    return true
}

// Run `fn` as one batch. Nested batches share the queue and only the
// OUTERMOST batch flushes, so a batch-in-a-batch coalesces as one.
export function batch<T>(fn: () => T) {
    batchDepth++
    try {
        return fn()
    } finally {
        if (--batchDepth == 0) flush()
    }
}

// Drain the queue, running each node's final thunk once. We snapshot
// then clear before running so a thunk that itself dirties a node
// (cascade) re-queues cleanly for a follow-up drain.
function flush() {
    flushing = true
    try {
        while (queued.size > 0) {
            const pending = [...queued.values()]
            queued.clear()
            for (const run of pending) run()
        }
    } finally {
        flushing = false
    }
}

// ============================================================
//  oracle — disposable self-test (see CLAUDE.md: tests as oracles)
// ============================================================
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // (1) outside a batch, enqueue is a no-op signal (fast path)
    {
        assert(inBatch() == false, 'not in batch by default')
        assert(enqueue({}, () => { throw new Error('should not run') }) == false,
            'enqueue outside batch returns false (caller emits immediately)')
    }

    // (2) PER-NODE coalesce: same node enqueued 3x -> flushes ONCE with final
    {
        const node = {}
        let runs = 0
        let last = 0
        batch(() => {
            assert(inBatch() == true, 'inBatch true inside batch()')
            for (const v of [1, 2, 3]) {
                const captured = v
                enqueue(node, function flushNode() { runs++; last = captured })
            }
        })
        assert(runs == 1, `node coalesced to a single flush (got ${runs})`)
        assert(last == 3, `flush carried the final state (got ${last})`)
    }

    // (3) two distinct nodes both flush once, in first-dirtied order
    {
        const order: string[] = []
        const a = {}
        const b = {}
        batch(() => {
            enqueue(a, () => order.push('a'))
            enqueue(b, () => order.push('b'))
            enqueue(a, () => order.push('a'))   // re-dirty a, still one entry
        })
        assert(order.join(',') == 'a,b', `both nodes flush once in order (got ${order.join(',')})`)
    }

    // (4) nested batch flushes only at the outermost exit
    {
        let flushed = false
        const isFlushed = () => flushed   // read via fn so TS can't const-narrow
        const node = {}
        batch(() => {
            batch(() => {
                enqueue(node, () => { flushed = true })
                assert(isFlushed() == false, 'inner batch exit does not flush')
            })
            assert(isFlushed() == false, 'still not flushed after inner batch closes')
        })
        assert(isFlushed() == true, 'outermost batch exit flushes')
    }

    // (5) a thunk that re-dirties a node cascades into a follow-up drain
    {
        let outer = 0
        let inner = 0
        const a = {}
        const b = {}
        batch(() => {
            enqueue(a, function runA() {
                outer++
                enqueue(b, function runB() { inner++ })   // dirty during flush
            })
        })
        assert(outer == 1 && inner == 1, `cascade drains follow-up (outer ${outer}, inner ${inner})`)
    }

    // (6) batch returns fn's value; depth resets even if fn throws
    {
        assert(batch(() => 42) == 42, 'batch returns the inner value')
        try { batch(() => { throw new Error('boom') }) } catch { /* expected */ }
        assert(inBatch() == false, 'depth resets to 0 after a throwing batch')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
