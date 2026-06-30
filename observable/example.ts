// Runnable demo / smoke check.
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/example.ts

import {createCell, createRObject, createRMap} from './reactive'
import {isListenCallback} from '../src/Common/events/Listen'

function assert(cond: boolean, msg: string) {
    if (!cond) { console.error('  FAIL:', msg); process.exitCode = 1 }
    else console.log('  ok  :', msg)
}

// ── 1. Cheap until subscribed ───────────────────────────────
console.log('\n[cell] cheap until subscribed')
{
    const n = createCell(0)
    assert(n.count() == 0, 'no listeners → count 0')
    // emit with nobody listening costs nothing and never throws
    n.set(1); n.set(2)
    assert(n.get() == 2, 'reads/writes work with zero listeners')
}

// ── 2. subscribe = new updates only ─────────────────────────
console.log('\n[cell] subscribe is new-updates-only')
{
    const n = createCell(10)
    const seen: number[] = []
    n.subscribe(v => seen.push(v))
    assert(seen.length == 0, 'no current value delivered on subscribe')
    n.set(11); n.set(11) /* deduped */; n.set(12)
    assert(JSON.stringify(seen) == '[11,12]', 'only changed future values: ' + JSON.stringify(seen))
}

// ── 3. conditional callback: opt-in current value ───────────
console.log('\n[cell] subscribe({current:true}) replays current')
{
    const n = createCell('a')
    const seen: string[] = []
    n.subscribe(v => seen.push(v), {current: true})
    n.set('b')
    assert(JSON.stringify(seen) == '["a","b"]', 'current then updates: ' + JSON.stringify(seen))
}

// ── 4. unsubscribe ──────────────────────────────────────────
console.log('\n[cell] unsubscribe')
{
    const n = createCell(0)
    const seen: number[] = []
    const off = n.subscribe(v => seen.push(v))
    n.set(1); off(); n.set(2)
    assert(JSON.stringify(seen) == '[1]', 'no events after unsubscribe: ' + JSON.stringify(seen))
}

// ── 5. RObject: per-key + whole-object ──────────────────────
console.log('\n[robject] per-key + whole')
{
    const o = createRObject({x: 1, y: 2})
    const whole: any[] = []
    const onX: number[] = []
    o.subscribe((k, v) => whole.push([k, v]))
    o.key('x').subscribe(v => onX.push(v))
    o.set('y', 20)   // whole only
    o.set('x', 10)   // whole + key x
    assert(JSON.stringify(onX) == '[10]', 'key("x") sees only x: ' + JSON.stringify(onX))
    assert(JSON.stringify(whole) == '[["y",20],["x",10]]', 'whole sees both: ' + JSON.stringify(whole))
    assert(o.get('x') == 10, 'plain read works')
}

// ── 6. RMap: set / delete ───────────────────────────────────
console.log('\n[rmap] set + delete')
{
    const m = createRMap<string, number>([['a', 1]])
    const ev: any[] = []
    m.subscribe((k, v) => ev.push([k, v]))
    m.set('b', 2)
    m.delete('a')
    assert(JSON.stringify(ev) == '[["b",2],["a",null]]', 'set then delete(undefined→null): ' + JSON.stringify(ev))
    assert(m.size == 1, 'size after delete')
}

// ── 7. RPC bridge: .listen() is a real Listen ───────────────
console.log('\n[rpc] .listen() is funcListenCallbackBase-shaped')
{
    const n = createCell(0)
    assert(isListenCallback(n.listen()), 'cell.listen() passes isListenCallback → RPC-ready')
    const o = createRObject({a: 1})
    assert(isListenCallback(o.listen()), 'robject.listen() passes isListenCallback')
    assert(isListenCallback(o.key('a').listen()), 'robject.key().listen() passes isListenCallback')
}

console.log('\ndone.')
