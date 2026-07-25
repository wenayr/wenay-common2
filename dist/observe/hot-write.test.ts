// ============================================================
//  observe/hot-write.test.ts
//
//  Hot-write scaling of reactive: ticking quotes map
//  (state[symbol] = quote, thousands of different keys per drain window) with
//  connected changedPaths consumer (pathLive > 0).
//  Oracle: dedup dirty-paths via keyed structure (not linear scan) →
//  window of 4x keys costs ~4x time, NOT ~16x. Plus correctness:
//  dedup in window, symbol-identity of keys, no string segment concatenation
//  string segments.
//  Run:
//      npx tsx observe/hot-write.test.ts
// ============================================================

import {reactive, onUpdatePaths, flushReactive} from '../src/Common/Observe/reactive'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function benchWindow(n: number, rounds: number) {
    const state = reactive<any>({quotes: {}}, {drain: 'micro'})
    for (let i = 0; i < n; i++) state.quotes['s' + i] = 0    // keys pre-created: measure pure writes
    const off = onUpdatePaths(state, () => {})
    await flushReactive(state)
    let best = Infinity
    for (let r = 1; r <= rounds; r++) {
        const t0 = process.hrtime.bigint()
        for (let i = 0; i < n; i++) state.quotes['s' + i] = r * n + i
        await flushReactive(state)
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6)
    }
    off()
    return best
}

async function main() {
    console.log('\n[hot-write] changedPaths correctness under a hot window')
    {
        const state = reactive<any>({quotes: {}}, {drain: 'micro'})
        const windows: PropertyKey[][][] = []
        const off = onUpdatePaths(state, ch => windows.push(ch.paths))
        for (let i = 0; i < 5; i++) state.quotes['s' + i] = i
        for (let i = 0; i < 5; i++) state.quotes['s' + i] = i + 100   // repeated touch of the same keys
        await flushReactive(state)
        ok(windows.length == 1, 'one settled batch')
        ok(windows[0].length == 5, `same key touched twice dedups to one path (got ${windows[0].length})`)
        ok(windows[0].every(p => p.length == 2 && p[0] == 'quotes'), 'paths are root-relative [quotes, key]')
        off()
    }

    console.log('\n[hot-write] symbol keys stay identity-safe in the dedup')
    {
        const s1 = Symbol('k'), s2 = Symbol('k')                      // same description, different identity
        const state = reactive<any>({}, {drain: 'micro'})
        const windows: PropertyKey[][][] = []
        const off = onUpdatePaths(state, ch => windows.push(ch.paths))
        state[s1] = 1
        state[s2] = 2
        state[s1] = 3                                                 // repeat of the first symbol
        await flushReactive(state)
        ok(windows[0].length == 2, `two same-description symbols = two paths, repeat dedups (got ${windows[0].length})`)
        off()
    }

    console.log('\n[hot-write] string segments cannot glue across boundaries')
    {
        const state = reactive<any>({'a': {'b|c': 0}, 'a|b': {'c': 0}}, {drain: 'micro'})
        const windows: PropertyKey[][][] = []
        const off = onUpdatePaths(state, ch => windows.push(ch.paths))
        state['a']['b|c'] = 1
        state['a|b']['c'] = 2
        await flushReactive(state)
        ok(windows[0].length == 2, `[a][b|c] and [a|b][c] are distinct paths (got ${windows[0].length})`)
        off()
    }

    console.log('\n[hot-write] near-linear scaling with a changedPaths subscriber')
    {
        await benchWindow(200, 2)                                     // warmup (JIT)
        const n = 500, m = 2000, rounds = 5
        const tN = await benchWindow(n, rounds)
        const tM = await benchWindow(m, rounds)
        const ratio = tM / tN
        console.log(`  [bench] ${n} keys/window: ${tN.toFixed(2)}ms · ${m} keys/window: ${tM.toFixed(2)}ms · ratio ${ratio.toFixed(1)}x`)
        ok(ratio < 10, `4x keys cost ~4x, not ~16x (ratio ${ratio.toFixed(1)}x < 10x)`)
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
