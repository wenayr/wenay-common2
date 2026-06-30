// ============================================================
//  schedule.ts — L3 OPT-IN effects scheduler (0 external deps)
//
//  An effect is a side-effecting reaction with automatic dependency
//  tracking. You write `createEffect(use => { ...read use(a)... })`;
//  each `use(source)` both RECORDS the source as a dependency and
//  RETURNS its current value (the autotrack.ts model, reused here for
//  a side-effect sink instead of a derived value). When any dep
//  changes the effect RE-RUNS — deferred and COALESCED through
//  batch.ts, so an effect dirtied N times inside one batch runs ONCE
//  on flush.
//
//  Lifecycle:
//   • onCleanup(cb) — registered DURING a run; every registered cb
//     fires before the next re-run and once on dispose. This is how
//     an effect releases what the previous run acquired.
//   • createRoot(fn) / owner scope — effects created inside a root
//     attach to it; disposing the root tears down the WHOLE subgraph
//     (every effect made within) at once, so upstream subscriber
//     counts return to 0. getOwner() exposes the current owner; bare
//     onCleanup() binds to it.
//
//  Layering (CLAUDE.md): the dep-tracking + re-run machinery is the
//  utility core; effect/root are the business surface on top. Built
//  only on reactive.ts (Source) and batch.ts (defer/coalesce).
//
//  HONEST SCOPE: batch coalesces per-node emits and effect runs.
//  Perfect glitch-free diamond coalescing — an intermediate computed
//  recomputing twice within a flush — is OUT OF SCOPE here and
//  deferred to a future glitch-free pull pass.
// ============================================================

import {Source} from './reactive'
import {enqueue} from './batch'

// the collector handed to an effect body: calling it on a source tags
// the dep and returns its current value (mirrors autotrack.ts tUse).
// .untrack reads without tagging — a read purely for control-flow that
// must not cause a re-run.
type tUse = {
    <T>(s: Source<T>): T
    untrack: <T>(s: Source<T>) => T
}

// ============================================================
//  owner scope — the disposal tree
//
//  An owner collects disposers (child effects + onCleanup cbs added
//  outside any run). The CURRENT owner is module-scoped and swapped
//  around each createRoot body, so effects created within register
//  with it automatically — dispose the owner, tear down the subtree.
// ============================================================
type tOwner = {
    addDisposer: (d: () => void) => void
    dispose: () => void
}

let currentOwner: tOwner | null = null

export function getOwner() { return currentOwner }

function createOwner(): tOwner {
    const disposers = new Set<() => void>()
    let disposed = false
    return {
        addDisposer(d) {
            if (disposed) { d(); return }   // late child of a dead owner — clean it up now
            disposers.add(d)
        },
        dispose() {
            if (disposed) return
            disposed = true
            // dispose children first; iterate a snapshot since a child's
            // dispose may itself touch the set.
            for (const d of [...disposers]) d()
            disposers.clear()
        },
    }
}

// run `fn` with `owner` as the current owner, restoring the previous
// owner afterwards (supports nested roots).
function withOwner<T>(owner: tOwner | null, fn: () => T) {
    const prev = currentOwner
    currentOwner = owner
    try {
        return fn()
    } finally {
        currentOwner = prev
    }
}

// ============================================================
//  createRoot — a disposable owner scope
//
//  Runs `fn(dispose)` under a fresh owner. The returned dispose tears
//  down every effect (and nested root) created during fn, in one shot.
//  A nested root registers with its parent owner, so disposing the
//  parent disposes nested roots too.
// ============================================================
export function createRoot<T>(fn: (dispose: () => void) => T) {
    const owner = createOwner()
    currentOwner?.addDisposer(owner.dispose)   // nest under any enclosing root
    const dispose = () => owner.dispose()
    const result = withOwner(owner, () => fn(dispose))
    return {result, dispose}
}

// bare onCleanup — binds the cb to the current owner when called
// OUTSIDE an effect run. Inside an effect run the effect installs its
// OWN onCleanup (see createEffect) that scopes the cb to that run.
export function onCleanup(cb: () => void) {
    currentOwner?.addDisposer(cb)
}

// ============================================================
//  createEffect — the reaction
// ============================================================
export function createEffect(fn: (use: tUse) => void) {
    // current dep set → unsubscribe handle (Source identity is the key,
    // so the same source read twice is one subscription). Diffed each run.
    let deps = new Map<Source<any>, () => void>()
    // cleanups registered via onCleanup DURING the latest run.
    let cleanups: Array<() => void> = []
    let disposed = false
    let scheduled = false
    // stable identity for batch coalescing — N dirties in a batch => one run.
    const node = {}

    // run pending cleanups (before a re-run and on dispose), newest-first.
    function runCleanups() {
        const cbs = cleanups
        cleanups = []
        for (let i = cbs.length - 1; i >= 0; i--) cbs[i]()
    }

    // execute the body once: fire previous cleanups, collect a fresh dep
    // set under a run-scoped onCleanup, then reconcile subscriptions.
    function execute() {
        if (disposed) return
        runCleanups()
        const seen = new Set<Source<any>>()
        const use = function use<T>(s: Source<T>) { seen.add(s); return s.get() } as tUse
        use.untrack = function untrack<T>(s: Source<T>) { return s.get() }

        // during the run, onCleanup targets THIS effect's run, not the owner.
        const prevOwner = currentOwner
        currentOwner = {
            addDisposer(cb) { cleanups.push(cb) },
            dispose() {},
        }
        try {
            fn(use)
        } finally {
            currentOwner = prevOwner
            // reconcile in finally so a THROWING body still aligns subscriptions
            // to what it actually read before throwing — otherwise the old dep
            // set stays live and the effect reacts to stale deps.
            reconcile(seen)
        }
    }

    // align live subscriptions with the freshly-seen dep set (autotrack model).
    function reconcile(seen: Set<Source<any>>) {
        for (const [s, off] of deps) {
            if (!seen.has(s)) { off(); deps.delete(s) }
        }
        for (const s of seen) {
            if (!deps.has(s)) deps.set(s, s.addListen(schedule))
        }
    }

    // a dep changed: re-run, deferred + coalesced through batch. Outside a
    // batch enqueue is a no-op signal (returns false) and we run inline.
    function schedule() {
        if (disposed || scheduled) return
        const deferred = enqueue(node, function flushEffect() { scheduled = false; execute() })
        if (deferred) { scheduled = true; return }
        execute()
    }

    function dispose() {
        if (disposed) return
        disposed = true
        runCleanups()
        for (const off of deps.values()) off()
        deps.clear()
    }

    // first run is immediate (establishes deps); attach to the current owner.
    execute()
    currentOwner?.addDisposer(dispose)

    return {dispose}
}
export type Effect = ReturnType<typeof createEffect>

// ============================================================
//  oracle — disposable self-test (see CLAUDE.md: tests as oracles)
// ============================================================
if (require.main === module) {
    const {createCell} = require('./reactive') as typeof import('./reactive')
    const {batch} = require('./batch') as typeof import('./batch')
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }

    // (a) effect runs once on create, re-runs on dep change, tracks deps
    {
        const a = createCell(1)
        const runs: number[] = []
        const e = createEffect(use => { runs.push(use(a)) })
        assert(runs.join(',') == '1', 'effect runs immediately with current value')
        assert(a.count() == 1, 'effect subscribed to its dep')
        a.set(2)
        assert(runs.join(',') == '1,2', 'effect re-runs on dep change')
        e.dispose()
        assert(a.count() == 0, 'dispose drops the upstream subscription')
        a.set(3)
        assert(runs.join(',') == '1,2', 'no re-run after dispose')
    }

    // (b) two cells changed in a batch -> effect runs ONCE after the batch
    {
        const a = createCell(0)
        const b = createCell(0)
        const seen: string[] = []
        createEffect(use => { seen.push(`${use(a)}:${use(b)}`) })
        assert(seen.length == 1, 'initial single run')
        batch(() => {
            a.set(1)
            b.set(2)
            assert(seen.length == 1, 'no run while batch is open')
        })
        assert(seen.length == 2, `exactly one re-run after batch (got ${seen.length})`)
        assert(seen[seen.length - 1] == '1:2', 'sees both final values')
    }

    // (b2) same cell set 3x in a batch -> one coalesced re-run, final value
    {
        const a = createCell(0)
        const seen: number[] = []
        createEffect(use => { seen.push(use(a)) })
        batch(() => { a.set(1); a.set(2); a.set(3) })
        assert(seen.join(',') == '0,3', `coalesced to one re-run with final value (got ${seen.join(',')})`)
    }

    // (c) onCleanup runs BEFORE each re-run and once on dispose
    {
        const a = createCell(0)
        const log: string[] = []
        const e = createEffect(use => {
            const v = use(a)
            log.push(`run${v}`)
            onCleanup(() => log.push(`cleanup${v}`))
        })
        assert(log.join(',') == 'run0', 'first run, no cleanup yet')
        a.set(1)
        assert(log.join(',') == 'run0,cleanup0,run1', 'cleanup of prev run fires before re-run')
        e.dispose()
        assert(log.join(',') == 'run0,cleanup0,run1,cleanup1', 'final cleanup fires on dispose')
    }

    // (d) createRoot dispose tears down nested effects (upstream count -> 0)
    {
        const a = createCell(1)
        const b = createCell(1)
        let outerRuns = 0
        let innerRuns = 0
        const {dispose} = createRoot(() => {
            createEffect(use => { use(a); outerRuns++ })
            createRoot(() => {
                createEffect(use => { use(b); innerRuns++ })
            })
        })
        assert(a.count() == 1 && b.count() == 1, 'both effects (nested root too) wired')
        a.set(2)
        b.set(2)
        assert(outerRuns == 2 && innerRuns == 2, 'both effects react before dispose')
        dispose()
        assert(a.count() == 0 && b.count() == 0, 'root dispose tears down whole subgraph -> upstream 0')
        a.set(3)
        b.set(3)
        assert(outerRuns == 2 && innerRuns == 2, 'no effect runs after root dispose')
    }

    // (e) getOwner reflects the active scope; onCleanup outside a run binds to it
    {
        assert(getOwner() == null, 'no owner outside a root')
        const log: string[] = []
        const {dispose} = createRoot(() => {
            assert(getOwner() != null, 'owner present inside a root')
            onCleanup(() => log.push('root-cleanup'))
        })
        assert(getOwner() == null, 'owner restored after root body')
        assert(log.length == 0, 'root cleanup not yet fired')
        dispose()
        assert(log.join(',') == 'root-cleanup', 'root-scoped onCleanup fires on dispose')
    }

    // (f) dynamic deps: effect re-subscribes to whichever branch ran
    {
        const flag = createCell(true)
        const a = createCell('A')
        const b = createCell('B')
        const seen: string[] = []
        const e = createEffect(use => { seen.push(use(flag) ? use(a) : use(b)) })
        assert(flag.count() == 1 && a.count() == 1 && b.count() == 0, 'tracks flag+a, not b')
        b.set('B2')
        assert(seen.length == 1, 'inactive branch change does not re-run')
        flag.set(false)
        assert(a.count() == 0 && b.count() == 1, 'flip re-diffs deps: drop a, add b')
        assert(seen[seen.length - 1] == 'B2', 'now reads b')
        e.dispose()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
