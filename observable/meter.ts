// ============================================================
//  meter.ts — adaptive OBSERVATION granularity (Mechanism 1)
//
//  Watch a store node; MEASURE its update frequency; ADAPT how we
//  observe it. The loop is the same one V8 runs on object shapes and
//  make/rsync/git run on file change detection: MEASURE → SPECIALIZE →
//  DEOPT.
//
//   • A leaf that updates HOT on its own (data.p ticking) → PROMOTE it
//     to a dedicated fine-grained value() subscription (a "useListen on
//     that leaf"): the consumer gets the value directly, no re-diff.
//   • The container churns but inner leaves rarely move individually →
//     do NOT fan out per-leaf. Keep a COARSE dirty trigger that signals
//     only THE FACT of a change (no value); the consumer lazily pulls +
//     diffs only when IT decides.
//
//  Industry techniques (named where they apply):
//   • STAT-THEN-HASH (make/rsync/git): cheap "something moved" signal
//     first, expensive content compare only after — createDirtyTrigger
//     is the stat; the consumer's pull + deepEqual is the hash.
//   • VERSION / EPOCH dirty-check (Angular digest, React
//     useSyncExternalStore version): poll a monotonic int (rev()).
//   • frequency-driven PROMOTION/DEMOTION with HYSTERESIS (JIT tiering):
//     promote a child above hotRate, demote when it cools — a margin so
//     a leaf hovering at the threshold doesn't flap subs on/off.
//   • pluggable "is this REALLY an update?" (equals/changed) — churn
//     that fails equals doesn't count toward a leaf's hot rate.
//
//  Layers (CLAUDE.md): util (rate meter, dirty trigger) → business
//  (adaptive watch). All clocks are INJECTED (now) so oracles are
//  deterministic — no real time anywhere in the logic.
// ============================================================

export type tKey = string

// ============================================================
//  util — EWMA event-rate meter
//
//  An exponentially-weighted moving rate over event timestamps. No
//  value is retained — only timing. `halfLife` sets the decay window:
//  the contribution of a past event halves every `halfLife` ms, so the
//  rate decays toward 0 when events stop. This is the standard
//  "load average" shape (a low-pass filter on an event train).
// ============================================================
export function createRateMeter(deps: {now: () => number, halfLife?: number}) {
    const {now, halfLife = 1000} = deps
    const decayK = Math.LN2 / halfLife        // e^(-k*dt) halves every halfLife
    let ratePerMs = 0                         // EWMA instantaneous rate (events / ms)
    let total = 0
    let last = -1                             // timestamp of the most recent tick (-1 = never)

    // fold the elapsed gap into the running rate before adding a new event.
    function decayTo(t: number) {
        if (last < 0) return
        const dt = t - last
        if (dt > 0) ratePerMs *= Math.exp(-decayK * dt)
    }

    function tick() {
        const t = now()
        decayTo(t)
        // each event adds one "unit of rate" spread over the decay window: the
        // steady-state of N events/halfLife converges to the true frequency.
        ratePerMs += decayK
        total++
        last = t
    }

    // current rate in events/SECOND, decayed to NOW (so idle → trends to 0).
    function rate() {
        if (last < 0) return 0
        const decayed = ratePerMs * Math.exp(-decayK * (now() - last))
        return decayed * 1000
    }

    return {
        tick,
        rate,
        count: () => total,
        idleFor: () => (last < 0 ? Infinity : now() - last),
    }
}
export type RateMeter = ReturnType<typeof createRateMeter>

// ============================================================
//  util — the stat-then-hash primitive (coarse, no-arg)
//
//  bump() raises a monotonic rev and fans the FACT out (no value) — the
//  "stat". rev() is the version int you poll ("one-eye peek"); if it
//  moved since you last looked, go do the expensive compare (the
//  "hash"). onDirty(cb) subscribes to the bare fact. Costs a Set + an
//  int; nothing fires until someone bumps.
// ============================================================
export function createDirtyTrigger() {
    let rev = 0
    const subs = new Set<() => void>()

    function bump() {
        rev++
        // copy-on-iterate: a handler may unsubscribe itself mid-fan-out.
        for (const cb of [...subs]) cb()
    }

    function onDirty(cb: () => void) {
        subs.add(cb)
        return function offDirty() { subs.delete(cb) }
    }

    return {bump, rev: () => rev, onDirty}
}
export type DirtyTrigger = ReturnType<typeof createDirtyTrigger>

// ============================================================
//  business — createAdaptiveWatch
//
//  Meters per-direct-child update rate vs the whole-node rate and
//  dynamically PROMOTES hot children to a dedicated value() subscription
//  (fine-grained: onHotLeaf(key,value)) while keeping cold/structural
//  churn on the COARSE rev trigger (onCoarse(rev) — the consumer pulls +
//  diffs lazily). HYSTERESIS: promote above hotRate, demote only when a
//  child cools (idle past coolFor OR rate below hotRate*coolRatio) so it
//  doesn't flap subs on/off.
//
//  The minimal node shape it needs (structural — a store nodeFacade
//  satisfies it; nothing store-specific is imported, 0 deps).
// ============================================================
type tWatchable = {
    keys: () => tKey[]
    key: (k: tKey) => {
        snapshot: () => any
        value: (cb: (v: any) => void) => () => void
    }
    entries: (cb: (k: tKey, v: any) => void) => () => void
    rev: () => number
    onRev: (cb: () => void) => () => void
}

type tAdaptiveOpts = {
    now: () => number
    hotRate?: number                              // promote a child above this (events/sec)
    coolRatio?: number                            // demote below hotRate*coolRatio (hysteresis margin)
    coolFor?: number                              // …or after this many ms idle (cool-down)
    halfLife?: number                             // meter decay window
    equals?: (a: any, b: any) => boolean          // "really an update?" gate (default Object.is)
    sampleEvery?: number                          // re-evaluate promote/demote at most once per this many ms
    onHotLeaf?: (key: tKey, value: any) => void   // a promoted child's fine-grained value()
    onCoarse?: (rev: number) => void              // the container-level dirty FACT (cold/structural churn)
}

export function createAdaptiveWatch(node: tWatchable, opts: tAdaptiveOpts) {
    const {
        now, hotRate = 5, coolRatio = 0.5, coolFor = Infinity, halfLife = 1000,
        equals = Object.is, sampleEvery = 0, onHotLeaf, onCoarse,
    } = opts
    const coolRate = hotRate * coolRatio

    // — per-child state: a rate meter + last-seen value (for the equals gate) —
    const meters = new Map<tKey, RateMeter>()
    const lastVal = new Map<tKey, any>()
    const promoted = new Map<tKey, () => void>()  // key → its value() unsub
    const whole = createRateMeter({now, halfLife})
    const coarse = createDirtyTrigger()

    let offEntries: (() => void) | null = null
    let offRev: (() => void) | null = null
    let lastSample = -Infinity
    let running = false

    function meterFor(k: tKey) {
        let m = meters.get(k)
        if (!m) { m = createRateMeter({now, halfLife}); meters.set(k, m) }
        return m
    }

    // ── promote / demote (the JIT-tiering edges) ────────────────
    function promote(k: tKey) {
        if (promoted.has(k)) return
        // a dedicated fine-grained value() sub on that one leaf — the consumer
        // gets the value directly, no whole-subtree re-diff. A promoted leaf is
        // metered HERE (via its own value() stream), not via entries — so its
        // meter keeps decaying/heating and the cool-down demotion can see it.
        const off = node.key(k).value(function onHotValue(v) {
            meterFor(k).tick()
            whole.tick()
            lastVal.set(k, v)
            onHotLeaf?.(k, v)
            maybeReevaluate()
        })
        promoted.set(k, off)
    }

    function demote(k: tKey) {
        const off = promoted.get(k)
        if (!off) return
        off()
        promoted.delete(k)
    }

    // decide, per child, whether to flip its specialization. Hysteresis: cross
    // UP past hotRate to promote; fall to coolRate (or idle past coolFor) to demote.
    function reevaluate() {
        for (const [k, m] of meters) {
            const r = m.rate()
            if (!promoted.has(k)) {
                if (r >= hotRate) promote(k)
            } else {
                if (r <= coolRate || m.idleFor() >= coolFor) demote(k)
            }
        }
    }

    // throttle reevaluation so we don't recompute every event in a tight burst.
    function maybeReevaluate() {
        const t = now()
        if (sampleEvery > 0 && t - lastSample < sampleEvery) return
        lastSample = t
        reevaluate()
    }

    // ── the entries handler: meter + gate every direct-child delta ──
    function onChild(k: tKey, v: any) {
        // a promoted leaf is metered via its dedicated value() stream (see promote);
        // entries would double-count it AND the equals gate would mis-fire against the
        // value()-written lastVal — so skip promoted keys on the coarse entries path.
        if (promoted.has(k)) return

        // "is this REALLY an update?" — a no-op re-set of an equal value does NOT
        // count toward the child's hot rate (the pluggable equals gate).
        const prev = lastVal.get(k)
        const real = !(lastVal.has(k) && equals(prev, v))
        lastVal.set(k, v)
        if (!real) return

        meterFor(k).tick()
        whole.tick()
        maybeReevaluate()
    }

    // ── coarse path: rev moved → fire the bare FACT (no value) ──
    // Promoted children already deliver their value directly; the coarse
    // trigger covers the cold/structural remainder. We ride the store's own
    // rev epoch as the stat, re-broadcasting via our dirty trigger.
    function onAnyRev() {
        coarse.bump()
        onCoarse?.(node.rev())
        // any subtree churn is also a chance to DEMOTE a leaf that has cooled
        // while something else moved — otherwise a promoted leaf that goes idle
        // is only ever re-checked by its own (now silent) value events.
        maybeReevaluate()
    }

    // ── control: lifecycle (no subs open until start — cheap-until-subscribed) ──
    function start() {
        if (running) return
        running = true
        offEntries = node.entries(onChild)
        offRev = node.onRev(onAnyRev)
    }

    function stop() {
        running = false
        offEntries?.(); offEntries = null
        offRev?.(); offRev = null
        for (const off of promoted.values()) off()
        promoted.clear()
    }

    // a fully IDLE store fires no events at all, so a lone promoted leaf that
    // cools would never be re-checked. poll() lets the owner drive demotion on
    // their own cadence (animation frame / interval) — clocks stay injected, no
    // real timer lives in here. Forces a reevaluate (bypasses the sampleEvery gate).
    function poll() { reevaluate() }

    return {
        // owner drives lifecycle
        control: {start, stop, poll},
        // outward surface (debug/inspect + the coarse epoch)
        api: {
            rateOf: (k: tKey) => meters.get(k)?.rate() ?? 0,
            wholeRate: () => whole.rate(),
            promoted: () => [...promoted.keys()],
            isPromoted: (k: tKey) => promoted.has(k),
            rev: () => coarse.rev(),
            onDirty: coarse.onDirty,
        },
    }
}
export type AdaptiveWatch = ReturnType<typeof createAdaptiveWatch>

// ============================================================
//  oracle — deterministic clock (no real time)
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/meter.ts
//
//  Proves: (a) the rate meter tracks frequency + idleFor grows when
//  quiet; (b) the dirty trigger fires once per bump, rev increments, a
//  consumer can poll rev and pull only when it changed (stat-then-hash);
//  (c) adaptiveWatch promotes a HOT leaf to fine-grained onHotLeaf and
//  leaves a COLD sibling on the coarse path; (d) a cooled hot leaf is
//  DEMOTED back to coarse (hysteresis); (e) equals confirms a "real
//  update" (a no-op re-set of an equal value does not count).
// ============================================================
if (require.main === module) {
    const {createTransportStore} = require('./store') as typeof import('./store')
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    const J = (v: any) => JSON.stringify(v)

    // a controllable clock — every test advances it explicitly, no wall time.
    function makeClock(t0 = 0) {
        let t = t0
        return {now: () => t, advance: (dt: number) => { t += dt }, set: (v: number) => { t = v }}
    }

    // ── (a) rate meter tracks frequency; idleFor grows when quiet ──
    console.log('\n[meter] rate meter tracks frequency; idleFor grows when idle')
    {
        const clk = makeClock()
        const m = createRateMeter({now: clk.now, halfLife: 1000})
        assert(m.rate() == 0 && m.count() == 0, 'cold meter: 0 rate, 0 count')
        assert(m.idleFor() == Infinity, 'never ticked → idleFor Infinity')

        // tick once every 100ms = ~10 events/sec; advance BEFORE the next tick so the
        // clock sits exactly on the last tick when we read (no trailing decay step).
        m.tick()
        for (let i = 1; i < 30; i++) { clk.advance(100); m.tick() }
        const fast = m.rate()
        assert(m.count() == 30, 'counted every tick: ' + m.count())
        assert(fast > 7 && fast < 13, 'fast stream ~10 ev/s (EWMA): ' + fast.toFixed(2))

        // now go quiet — rate decays, idleFor grows
        clk.advance(100)
        assert(m.idleFor() == 100, 'idleFor = ms since last tick: ' + m.idleFor())
        clk.advance(2900)        // total 3s idle (3 half-lives)
        const cold = m.rate()
        assert(m.idleFor() == 3000, 'idleFor grows while quiet: ' + m.idleFor())
        assert(cold < fast / 5, 'rate decays toward 0 when idle: ' + cold.toFixed(3) + ' << ' + fast.toFixed(2))

        // a slow stream meters a lower rate than a fast one (clean clocks each)
        const c2 = makeClock()
        const slow = createRateMeter({now: c2.now, halfLife: 1000})
        slow.tick()
        for (let i = 1; i < 30; i++) { c2.advance(1000); slow.tick() }   // 1 ev/s
        assert(slow.rate() < fast, 'slow stream meters a lower rate than fast: ' + slow.rate().toFixed(2) + ' < ' + fast.toFixed(2))
    }

    // ── (b) dirty trigger: one fire per bump, rev increments, stat-then-hash poll ──
    console.log('\n[meter] dirty trigger: fires once per bump; rev increments; poll-then-pull')
    {
        const dt = createDirtyTrigger()
        let fired = 0
        const off = dt.onDirty(() => fired++)
        assert(dt.rev() == 0, 'rev starts at 0')
        dt.bump(); dt.bump(); dt.bump()
        assert(fired == 3, 'onDirty fired once per bump: ' + fired)
        assert(dt.rev() == 3, 'rev incremented per bump: ' + dt.rev())
        off()
        dt.bump()
        assert(fired == 3, 'unsubscribed handler stops firing: ' + fired)
        assert(dt.rev() == 4, 'rev still advances after unsubscribe: ' + dt.rev())

        // STAT-THEN-HASH: a consumer polls rev (cheap stat) and only "hashes"
        // (pulls + compares) when it moved since last seen.
        let seen = dt.rev()
        let hashes = 0
        function pullIfDirty() {
            const r = dt.rev()
            if (r == seen) return false     // stat says nothing moved → skip the expensive pull
            seen = r
            hashes++                         // the "hash" step (would deepEqual a snapshot here)
            return true
        }
        assert(!pullIfDirty(), 'poll: clean → no pull')
        dt.bump()
        assert(pullIfDirty() && hashes == 1, 'poll: dirty → exactly one pull')
        assert(!pullIfDirty(), 'poll again: clean → no second pull')
    }

    // ── store hook: rev()/onRev() ride the deep stream additively ──
    console.log('\n[meter] store rev()/onRev() — additive coarse epoch on the node facade')
    {
        const s = createTransportStore({a: 1, b: 2})
        const r0 = s.rev()
        let coarse = 0
        const off = s.onRev(() => coarse++)
        s.set('a', 10)
        s.set('b', 20)
        assert(s.rev() == r0 + 2, 'rev() bumped on each subtree change: ' + (s.rev() - r0))
        assert(coarse == 2, 'onRev fired the bare FACT (args dropped): ' + coarse)
        off()
        s.set('a', 11)
        assert(coarse == 2, 'onRev unsub stops the trigger: ' + coarse)
        assert(s.rev() == r0 + 3, 'rev() keeps advancing regardless of listeners')
    }

    // ── (c)+(d)+(e) adaptiveWatch: promote HOT leaf, keep COLD sibling coarse,
    //               demote on cool-down (hysteresis), equals gates real updates ──
    console.log('\n[meter] adaptiveWatch: promote hot leaf, coarse cold sibling, demote on cool, equals gate')
    {
        const clk = makeClock()
        // p = a hot ticking price; meta = a cold sibling that rarely moves.
        const s = createTransportStore({p: 0, meta: 'x'})
        const hot: Array<[string, any]> = []
        const coarseRevs: number[] = []
        const w = createAdaptiveWatch(s as any, {
            now: clk.now,
            hotRate: 5,            // promote above 5 ev/s
            coolRatio: 0.4,        // demote below 2 ev/s (hysteresis margin)
            coolFor: 1000,         // …or after 1s idle
            halfLife: 500,
            sampleEvery: 0,
            onHotLeaf: (k, v) => hot.push([k, v]),
            onCoarse: r => coarseRevs.push(r),
        })
        w.control.start()

        // (e) equals gate: a NO-OP re-set of an equal value must not count as an update.
        s.set('meta', 'x')        // same value → store itself suppresses; rate stays 0
        assert(w.api.rateOf('meta') == 0, 'no-op re-set does not count toward rate (equals gate): ' + w.api.rateOf('meta'))

        // drive p HOT: ~20 ev/s for a while (tick every 50ms). Advance BEFORE the
        // next set so the clock sits on the last tick when we read the rate.
        s.set('p', 0)
        for (let i = 1; i <= 40; i++) { clk.advance(50); s.set('p', i) }
        assert(w.api.isPromoted('p'), 'HOT leaf p promoted to a fine-grained value() sub: rate=' + w.api.rateOf('p').toFixed(1))
        assert(w.api.rateOf('p') >= 5, 'p metered above hotRate: ' + w.api.rateOf('p').toFixed(1))
        assert(hot.some(([k]) => k == 'p'), 'onHotLeaf delivered p values directly: ' + J(hot.slice(-2)))

        // (c) the COLD sibling meta moves ONCE → stays on the coarse path, never promoted.
        const hotBefore = hot.length
        s.set('meta', 'y')        // a real, rare change
        assert(!w.api.isPromoted('meta'), 'COLD sibling meta NOT promoted (stays coarse)')
        assert(!hot.some(([k]) => k == 'meta'), 'meta never delivered via onHotLeaf')
        assert(coarseRevs.length > 0, 'coarse trigger fired the FACT for cold/structural churn: ' + coarseRevs.length)
        assert(hot.length == hotBefore, 'cold change added nothing to the hot stream')

        // (d) p COOLS: go idle long enough that its metered rate drops + idleFor passes coolFor.
        const wasPromoted = w.api.isPromoted('p')
        clk.advance(3000)         // 6 half-lives idle → rate ≈ 0, idleFor 3000 > coolFor
        // a single straggler delta (on the COLD sibling) triggers reevaluation;
        // p is now cold → DEMOTED back to the coarse path (hysteresis).
        s.set('meta', 'z')
        assert(wasPromoted && !w.api.isPromoted('p'), 'cooled hot leaf p DEMOTED back to coarse (hysteresis)')
        assert(w.api.promoted().length == 0, 'nothing promoted after demotion: ' + J(w.api.promoted()))

        // re-heating p promotes it again (the loop is symmetric)
        for (let i = 1; i <= 40; i++) { clk.advance(40); s.set('p', 1000 + i) }
        assert(w.api.isPromoted('p'), 'p re-promoted after re-heating (symmetric promote/demote)')

        w.control.stop()
        assert(w.api.promoted().length == 0, 'stop() tears down all promoted subs')
    }

    // (f) a LONE hot leaf that cools with NO sibling activity must still demote via poll()
    console.log('\n[meter] lone cooled leaf demotes via control.poll() (no sibling traffic)')
    {
        const clk = makeClock()
        const s = createTransportStore({only: 0})
        const w = createAdaptiveWatch(s as any, {now: clk.now, hotRate: 5, coolFor: 1000, halfLife: 1000})
        w.control.start()
        for (let i = 1; i <= 40; i++) { clk.advance(50); s.set('only', i) }
        assert(w.api.isPromoted('only'), 'lone leaf heated → promoted')
        // go fully idle: NO further set() anywhere, so no events fire at all
        clk.advance(5000)
        assert(w.api.isPromoted('only'), 'still promoted while no one re-checks (no events)')
        w.control.poll()          // owner drives the re-check on its own cadence
        assert(!w.api.isPromoted('only'), 'poll() demotes the cooled lone leaf')
        assert(w.api.promoted().length == 0, 'no leaked value() sub after idle demotion')
        w.control.stop()
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
    process.exit(fails == 0 ? 0 : 1)
}
