// Microbenchmark — substantiates the "cheap until subscribed" claim.
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/bench.ts

import {createCell} from './reactive'
import {UseListen} from '../src/Common/events/Listen'

const N = 1_000_000

function time(label: string, fn: () => void) {
    fn() // warm
    if (global.gc) global.gc()
    const m0 = process.memoryUsage().heapUsed
    const t0 = process.hrtime.bigint()
    fn()
    const t1 = process.hrtime.bigint()
    const ms = Number(t1 - t0) / 1e6
    const heap = (process.memoryUsage().heapUsed - m0) / 1024 / 1024
    console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms  (${(ms * 1e6 / N).toFixed(1)} ns/op)  Δheap≈${heap.toFixed(0)}MB`)
}

console.log(`\nN = ${N.toLocaleString()} ops\n`)

// ── allocation cost (the "cheap until subscribed" core) ─────
{
    let sink: any
    const plain: any[] = []
    time('alloc plain {value}              ', () => { plain.length = 0; for (let i = 0; i < N; i++) plain.push({value: i}) })
    const cells: any[] = []
    time('alloc createCell (no subscriber) ', () => { cells.length = 0; for (let i = 0; i < N; i++) cells.push(createCell(i)) })
    const lis: any[] = []
    time('alloc UseListen (eager Listen)   ', () => { lis.length = 0; for (let i = 0; i < N; i++) lis.push(UseListen<number>()) })
    sink = [plain.length, cells.length, lis.length]
    void sink
}

// ── set() with NO subscribers (the hot, cheap path) ─────────
{
    const c = createCell(0)
    time('set() x N, 0 subscribers        ', () => { for (let i = 0; i < N; i++) c.set(i) })
}

// ── set() with 1 subscriber (emit path) ─────────────────────
{
    const c = createCell(0)
    let acc = 0
    c.subscribe(v => { acc += v })
    time('set() x N, 1 subscriber         ', () => { for (let i = 0; i < N; i++) c.set(i) })
    void acc
}

// ── set() with 3 subscribers ────────────────────────────────
{
    const c = createCell(0)
    let acc = 0
    c.subscribe(v => { acc += v }); c.subscribe(v => { acc += v }); c.subscribe(v => { acc += v })
    time('set() x N, 3 subscribers        ', () => { for (let i = 0; i < N; i++) c.set(i) })
    void acc
}

// ── subscribe + unsubscribe churn ───────────────────────────
{
    const c = createCell(0)
    time('subscribe+unsubscribe x N       ', () => { for (let i = 0; i < N; i++) { const off = c.subscribe(() => {}); off() } })
}

console.log('\n(run with --expose-gc for accurate Δheap)\n')
