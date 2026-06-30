// ===========================================================================
// usage.ts — realistic usage examples (not assertions; just runnable prose).
//   node node_modules/ts-node/dist/bin.js --transpile-only observable/usage.ts
// ===========================================================================

import {createCell, createRObject, createRMap, combine, computed} from './reactive'
import {createReactive, onKey, onValue, onChange, onDeep, listen, listenValue, snapshot} from './native'

// ── 0. THE NATIVE WAY (start here) ──────────────────────────
// Work with a reactive tree as a plain object, at any depth. Plain
// assignment emits; subscription is via free functions so the object
// stays pure data. This is the recommended surface.
function example_native() {
    const p = createReactive({price: 0, balances: {BTC: 1, ETH: 10}})

    onKey<number>(p, 'price', v => console.log('price →', v))
    onChange(p.balances, (sym, amt) => console.log('balance', sym, '=', amt))
    onValue(p, ['balances', 'BTC'], v => console.log('BTC →', v))

    p.price = 100               // logs price → 100
    p.balances.BTC = 2          // logs balance BTC = 2  AND  BTC → 2
    p.balances = {BTC: 2, ETH: 11, SOL: 3}  // only ETH+SOL deltas fire (BTC unchanged)
    delete p.balances.ETH       // logs balance ETH = undefined

    console.log('snapshot:', snapshot(p, 'balances'))   // plain detached copy
    onDeep(p, (path, v) => console.log('deep', path.join('.'), '=', v))
    listenValue(p, 'price')     // RPC-ready Listen for the price FIELD
    listen(p, 'balances')       // RPC-ready Listen for the balances COLLECTION
}

// ── 1. A plain reactive variable ────────────────────────────
// Read/write like a normal value; subscribe for *future* changes only.
function example_variable() {
    const temperature = createCell(20)

    const off = temperature.subscribe(t => console.log('temp changed →', t))
    temperature.set(21)          // logs 21
    temperature.set(21)          // no log (unchanged)
    temperature.set(25)          // logs 25
    console.log('current temp:', temperature.get())   // 25, read any time
    off()                        // stop listening; cell is cheap again
}

// ── 2. Opt-in current value on subscribe ────────────────────
// Default is new-updates-only. Pass {current:true} to also get the value now.
function example_current() {
    const status = createCell<'idle' | 'busy'>('idle')
    status.subscribe(s => console.log('status:', s), {current: true})  // logs idle now
    status.set('busy')                                                  // logs busy
}

// ── 3. Reactive object: per-key vs whole ────────────────────
function example_object() {
    const user = createRObject({name: 'alice', age: 30})

    // listen to ONE field
    user.key('age').subscribe(age => console.log('age →', age))
    // listen to ANY field change
    user.subscribe((key, value) => console.log('field', key, '=', value))

    user.set('age', 31)          // both fire
    user.set('name', 'bob')      // only the whole-object listener fires
    console.log('snapshot:', user.snapshot())
}

// ── 4. Reactive map: dynamic keys ───────────────────────────
function example_map() {
    const prices = createRMap<string, number>([['BTC', 60000]])

    prices.key('BTC').subscribe(p => console.log('BTC →', p))
    prices.subscribe((sym, p) => console.log('tick', sym, p))

    prices.set('BTC', 61000)     // both fire
    prices.set('ETH', 3000)      // only whole-map listener
    prices.delete('BTC')         // emits undefined for BTC
    console.log('size:', prices.size)
}

// ── 5. Derived values (cheap graph) ─────────────────────────
// get() pulls without subscribing; the graph only wires upstream
// while someone is listening to the result.
function example_derived() {
    const width = createCell(4)
    const height = createCell(3)
    const area = combine([width, height], ([w, h]) => w * h)

    console.log('area (pulled, no subscribers):', area.get())   // 12

    const off = area.subscribe(a => console.log('area →', a))   // connects width+height
    width.set(10)                                               // logs 40
    off()                                                       // disconnects upstream

    // chaining
    const label = area.map(a => `area=${a}`)
    label.subscribe(s => console.log(s), {current: true})       // logs current
    height.set(5)                                               // logs area=50
}

// ── 6. Single-source computed ───────────────────────────────
function example_computed() {
    const celsius = createCell(0)
    const fahrenheit = computed(celsius, c => c * 9 / 5 + 32)
    fahrenheit.subscribe(f => console.log(f, '°F'))
    celsius.set(100)             // logs 212 °F
}

// ── 7. Bridging to RPC (in-process source → over the wire) ──
// Anything you expose as a server method can be `cell.listen()` — it is the
// exact funcListenCallbackBase shape rpc-server-auto expects, so remote
// clients can `.callback(...)` it. (See observable/test.ts for a live run.)
function example_rpc_shape() {
    const feed = createCell(0)
    const serverObject = {
        liveValue: feed.listen(),            // remote: client.func.liveValue.callback(v => ...)
        nested: {squared: feed.map(v => v * v).listen()},
    }
    feed.set(7)                              // would stream 7 (and 49) to subscribed clients
    return serverObject
}

for (const fn of [
    example_native,
    example_variable, example_current, example_object, example_map,
    example_derived, example_computed, example_rpc_shape,
]) {
    console.log(`\n=== ${fn.name} ===`)
    fn()
}
