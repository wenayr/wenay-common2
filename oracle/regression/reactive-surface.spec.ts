// =====================================================================
//  The visible surface of a reactive proxy, pinned.
//
//  A reactive proxy stands in for a plain object or array. User code reads its keys, descriptors,
//  prototype, JSON, integrity levels, inspection and error texts; subscribers read dirty paths;
//  the Store's private mutation hook reads the path of every write, detached nodes included. How
//  the engine builds a node (its handler, its dummy target, its path bookkeeping) is free to
//  change, and none of it may show through any of these.
//
//  Each probe renders what one operation returns, or the error it throws. The rendering of all
//  probes is pinned below (PINNED) as the engine produced it at 3.1.0. A difference is a behavior
//  change: review it, and re-pin a line only when the change is intended. Error texts and
//  inspect output are V8's and Node's: an upgrade that rewords one needs that line re-pinned.
// =====================================================================
import assert from 'node:assert/strict'
import {inspect, types} from 'node:util'
import {reactive, isReactive, toRaw, onUpdate, onUpdatePaths, flushReactive, flushReactiveNow} from '../../src/Common/Observe/reactive'
import {createStore} from '../../src/Common/Observe/store'
import {REACTIVE_ARRAY_MUTATIONS, type ReactiveArrayMutations} from '../../src/Common/Observe/observe-private'
import {runOracle} from '../run-oracle'

type Fn = () => void

// ============================================================
//  rendering
// ============================================================

const rendered: {label: string, out: string}[] = []

function show(v: any): string {
    if (typeof v == 'symbol') return v.toString()
    if (typeof v == 'function') return 'function ' + v.name
    if (typeof v == 'bigint') return v.toString() + 'n'
    if (v === undefined) return 'undefined'
    if (v != null && typeof v == 'object') {
        if (Array.isArray(v)) return '[' + v.map(show).join(', ') + ']'
        const keys = Reflect.ownKeys(v)
        return (isReactive(v) ? 'R' : '') + '{' + keys.map(k => show(k) + ': ' + show((v as any)[k])).join(', ') + '}'
    }
    return JSON.stringify(v)
}

function probe(label: string, run: () => any) {
    let out: string
    try { out = show(run()) }
    catch (e: any) { out = 'THROWS ' + (e?.constructor?.name ?? '?') + ': ' + String(e?.message ?? e) }
    rendered.push({label, out})
}

function manual() {
    const queue: Fn[] = []
    return {
        opts: {drain: (f: Fn) => { queue.push(f) }},
        flush() { let n = 0; while (queue.length && ++n < 50) queue.shift()!() },
    }
}

// tsx runs this file sloppy; consumers' compiled code is strict, where a refused write or delete throws
function strictSet(target: any, key: PropertyKey, value: unknown) {
    'use strict'
    target[key] = value
}
function strictDelete(target: any, key: PropertyKey) {
    'use strict'
    delete target[key]
}

function pathText(path: PropertyKey[]) { return path.map(String).join('/') || '<root>' }

const sym = Symbol('user')
function fresh() {
    const raw: any = {a: 1, b: {c: 2, d: {e: 3}}, arr: [1, {x: 1}], [sym]: 's', empty: {}, nested: [[1], [2]]}
    const d = manual()
    return {raw, s: reactive<any>(raw, d.opts), d}
}

// ============================================================
//  probes
// ============================================================

function readProbes() {
    const {raw, s} = fresh()
    probe('keys', () => Object.keys(s))
    probe('ownKeys', () => Reflect.ownKeys(s))
    probe('names', () => Object.getOwnPropertyNames(s))
    probe('symbols', () => Object.getOwnPropertySymbols(s))
    probe('symbols(b)', () => Object.getOwnPropertySymbols(s.b))
    probe('symbols(arr)', () => Object.getOwnPropertySymbols(s.arr))
    probe('desc a', () => Object.getOwnPropertyDescriptor(s, 'a'))
    probe('desc b (raw value)', () => { const d = Object.getOwnPropertyDescriptor(s, 'b')!; return {...d, value: d.value == raw.b ? 'RAW' : isReactive(d.value) ? 'PROXY' : 'other'} })
    probe('desc missing', () => Object.getOwnPropertyDescriptor(s, 'zz'))
    probe('desc sym', () => Object.getOwnPropertyDescriptor(s, sym))
    probe('descriptors keys', () => Object.keys(Object.getOwnPropertyDescriptors(s)))
    probe('descriptors symbols', () => Object.getOwnPropertySymbols(Object.getOwnPropertyDescriptors(s)))
    probe('in a', () => 'a' in s)
    probe('in zz', () => 'zz' in s)
    probe('in toJSON', () => 'toJSON' in s)
    probe('in constructor', () => 'constructor' in s)
    probe('in sym', () => sym in s)
    probe('hasOwn', () => [Object.hasOwn(s, 'a'), Object.hasOwn(s, 'zz'), s.hasOwnProperty('b')])
    probe('entries', () => Object.entries(s).map(([k, v]) => k + ':' + (isReactive(v) ? 'P' : typeof v)))
    probe('for-in', () => { const ks: string[] = []; for (const k in s) ks.push(k); return ks })
    probe('assign', () => Object.keys(Object.assign({}, s)))
    probe('spread proxy', () => { const c = {...s}; return Reflect.ownKeys(c).map(k => show(k) + (isReactive(c[k as any]) ? ':P' : ':' + typeof c[k as any])) })
    probe('spread raw', () => Reflect.ownKeys({...toRaw(s)}))
    probe('spread arr', () => [...s.arr].map(v => isReactive(v) ? 'P' : v))
    probe('json', () => JSON.stringify(s))
    probe('json arr', () => JSON.stringify(s.arr))
    probe('json nested', () => JSON.stringify(s.nested))
    probe('structuredClone(toRaw)', () => JSON.stringify(structuredClone(toRaw(s))))
    probe('structuredClone(proxy)', () => structuredClone(s))
    probe('structuredClone(toRaw(arr))', () => structuredClone(toRaw(s.arr)))
    probe('isArray', () => [Array.isArray(s.arr), Array.isArray(s), Array.isArray(s.b), Array.isArray(s.nested[0])])
    probe('toString tags', () => [Object.prototype.toString.call(s), Object.prototype.toString.call(s.arr)])
    probe('proto', () => [Object.getPrototypeOf(s) == Object.prototype, Object.getPrototypeOf(s.arr) == Array.prototype, Object.getPrototypeOf(s.b) == Object.prototype])
    probe('instanceof', () => [s instanceof Object, s.arr instanceof Array, s.arr instanceof Object])
    probe('constructor', () => [s.constructor == Object, s.arr.constructor == Array])
    probe('proto methods', () => [s.hasOwnProperty == Object.prototype.hasOwnProperty, typeof s.arr.map, s.toString == Object.prototype.toString])
    probe('array methods', () => [s.arr.map((v: any) => isReactive(v) ? 'P' : v), s.arr.indexOf(1), s.arr.includes(1), s.arr.slice(0, 1), Array.from(s.arr).length, [...s.arr.keys()]])
    probe('array iter identity', () => { const items = [...s.arr]; return items[1] == s.arr[1] })
    probe('child identity', () => [s.b == s.b, s.b.d == s.b.d, s.arr[1] == s.arr[1]])
    probe('isReactive', () => [isReactive(s), isReactive(s.b), isReactive(s.arr), isReactive(s.arr[1]), isReactive(raw), isReactive(1), isReactive(null), isReactive(undefined), isReactive('x'), isReactive(() => 1), isReactive(s.a)])
    probe('toRaw', () => [toRaw(s) == raw, toRaw(s.b) == raw.b, toRaw(s.arr) == raw.arr, toRaw(1), toRaw(null), toRaw(undefined), toRaw('x'), toRaw(raw) == raw])
    probe('isExtensible/frozen/sealed', () => [Object.isExtensible(s), Object.isFrozen(s), Object.isSealed(s), Object.isExtensible(s.arr)])
    probe('proxy identity vs raw', () => [s == raw, s.b == raw.b, toRaw(s.b) == raw.b])
    probe('length', () => [s.arr.length, s.nested.length, Object.getOwnPropertyDescriptor(s.arr, 'length')])
    probe('desc index', () => Object.getOwnPropertyDescriptor(s.arr, '1'))
    probe('array keys', () => [Object.keys(s.arr), Reflect.ownKeys(s.arr)])
    probe('reactive(reactive)', () => { const r2 = reactive(s); return [r2 == s, toRaw(r2) == raw, isReactive(r2)] })
}

function writeProbes() {
    const {raw, s, d} = fresh()
    s.arr.push(3)
    probe('after push', () => [s.arr.length, raw.arr.length, Object.getOwnPropertyDescriptor(s.arr, 'length')!.value, Object.keys(s.arr)])
    s.arr.splice(0, 1)
    probe('after splice', () => [s.arr.length, raw.arr.length, JSON.stringify(s.arr), Object.getOwnPropertyDescriptor(s.arr, 'length')!.value])
    s.arr.length = 1
    probe('after truncate', () => [s.arr.length, raw.arr.length, JSON.stringify(s.arr), Object.getOwnPropertyDescriptor(s.arr, 'length')!.value, Object.keys(s.arr)])
    s.arr.unshift(0)
    probe('after unshift', () => [s.arr.length, JSON.stringify(s.arr)])
    s.arr[5] = 5
    probe('after hole write', () => [s.arr.length, JSON.stringify(s.arr), Object.keys(s.arr), 3 in s.arr])
    s.arr.length = 0
    probe('after empty', () => [s.arr.length, JSON.stringify(s.arr), Object.getOwnPropertyDescriptor(s.arr, 'length')])
    s[sym] = 'changed'
    probe('sym write', () => [s[sym], raw[sym], Reflect.ownKeys(s).length])
    delete s[sym]
    probe('sym delete', () => [s[sym], sym in s, Reflect.ownKeys(s).length])
    probe('define fixed', () => Object.defineProperty(s, 'fixed', {value: 1, configurable: false, enumerable: true, writable: false}) == s)
    probe('fixed visible', () => [Object.keys(s).includes('fixed'), Object.getOwnPropertyDescriptor(s, 'fixed'), 'fixed' in s, s.fixed])
    probe('delete fixed', () => Reflect.deleteProperty(s, 'fixed'))
    probe('delete fixed strict', () => { delete s.fixed })
    probe('redefine fixed', () => Reflect.defineProperty(s, 'fixed', {value: 2}))
    probe('define accessor', () => { Object.defineProperty(s, 'acc', {get() { return 42 }, configurable: true, enumerable: true}); return [s.acc, Object.keys(s).includes('acc'), 'acc' in s] })
    probe('raw keys', () => Reflect.ownKeys(raw))
    // array <-> object rebinds
    const a = s.arr
    s.arr = {x: 1}
    probe('arr->obj json', () => JSON.stringify(a))
    probe('arr->obj keys', () => [Object.keys(a), Reflect.ownKeys(a), Array.isArray(a), a.length, Object.getOwnPropertyDescriptor(a, 'length')])
    probe('arr->obj in', () => ['length' in a, 'x' in a, 'toJSON' in a, typeof a.toJSON])
    probe('arr->obj identity', () => [s.arr == a, isReactive(a), toRaw(a) == raw.arr])
    s.arr = [7, 8]
    probe('obj->arr back', () => [JSON.stringify(a), a.length, Array.isArray(a), typeof a.toJSON, Object.keys(a)])
    const b = s.b
    s.b = [1, 2, 3]
    probe('obj->arr json', () => [JSON.stringify(b), Array.isArray(b), b.length, Object.keys(b), 'length' in b, Object.getOwnPropertyDescriptor(b, 'length')])
    probe('obj->arr toString', () => Object.prototype.toString.call(b))
    s.b = {c: 9}
    probe('obj restored', () => [JSON.stringify(b), s.b == b, b.c])
    // toJSON on the raw target wins over the array-shape patch
    s.arr = {toJSON() { return 'custom' }}
    probe('arr->obj custom toJSON', () => JSON.stringify(a))
    d.flush()
}

function unsyncedArrayProbes() {
    // a captured array proxy whose length was never synced, rebound to an object: the dummy's own length shows
    const {s} = fresh()
    const a = s.arr
    s.arr = {x: 1}
    probe('unsynced arr->obj length desc', () => [Object.getOwnPropertyDescriptor(a, 'length'), a.length, Reflect.ownKeys(a), Object.keys(a)])
    const n = s.nested
    const n0 = n[0]
    s.nested = {y: 2}
    probe('unsynced nested arr->obj', () => [Object.getOwnPropertyDescriptor(n, 'length'), JSON.stringify(n), isReactive(n0), toRaw(n0)])
    const big = reactive<any>({rows: new Array(10000).fill(0)}, manual().opts)
    const r = big.rows
    big.rows = {}
    probe('unsynced big arr->obj', () => [Object.getOwnPropertyDescriptor(r, 'length'), JSON.stringify(Reflect.ownKeys(r))])
}

// whatever the engine does on each integrity level, it must keep doing
function integrityProbes() {
    const kinds = [
        ['nonempty', () => reactive<any>({a: 1}, manual().opts)],
        ['empty', () => reactive<any>({}, manual().opts)],
        ['array', () => reactive<any>([1], manual().opts)],
    ] as const
    for (const [label, make] of kinds) {
        {
            const s = make()
            probe(label + ' preventExtensions', () => Object.preventExtensions(s) == s)
            probe(label + ' pE isExtensible', () => Object.isExtensible(s))
            probe(label + ' pE keys', () => Object.keys(s))
            probe(label + ' pE ownKeys', () => Reflect.ownKeys(s))
            probe(label + ' pE in', () => ['a' in s, 'zz' in s])
            probe(label + ' pE get', () => s.a)
            probe(label + ' pE json', () => JSON.stringify(s))
            probe(label + ' pE set existing', () => { s.a = 2; return s.a })
            probe(label + ' pE set new', () => { s.z = 1; return s.z })
            probe(label + ' pE desc', () => Object.getOwnPropertyDescriptor(s, 'a'))
            probe(label + ' pE isReactive/toRaw', () => [isReactive(s), Reflect.ownKeys(toRaw(s))])
            probe(label + ' pE strict set new', () => { strictSet(s, 'y', 1); return s.y })
            probe(label + ' pE define new', () => Object.defineProperty(s, 'w', {value: 1, configurable: true}) == s)
            probe(label + ' pE setPrototypeOf', () => Object.setPrototypeOf(s, {}) == s)
            probe(label + ' pE inspect', () => inspect(s))
        }
        {
            const s = make()
            probe(label + ' freeze', () => Object.freeze(s) == s)
            probe(label + ' fr keys', () => Object.keys(s))
            probe(label + ' fr isFrozen', () => Object.isFrozen(s))
            probe(label + ' fr raw', () => [Object.isFrozen(toRaw(s)), Reflect.ownKeys(toRaw(s))])
            probe(label + ' fr strict set', () => { strictSet(s, 'a', 5); return s.a })
            probe(label + ' fr strict delete', () => { strictDelete(s, 'a'); return s.a })
            probe(label + ' fr inspect', () => inspect(s))
        }
        {
            const s = make()
            probe(label + ' seal', () => Object.seal(s) == s)
            probe(label + ' se keys', () => Object.keys(s))
            probe(label + ' se isSealed', () => [Object.isSealed(s), Object.isFrozen(s)])
            probe(label + ' se strict delete', () => { strictDelete(s, 'a'); return s.a })
        }
        {
            const s = make()
            probe(label + ' setPrototypeOf null', () => Reflect.setPrototypeOf(s, null))
            probe(label + ' sPO proto', () => Object.getPrototypeOf(s))
            probe(label + ' sPO raw proto', () => Object.getPrototypeOf(toRaw(s)) == Object.prototype || Object.getPrototypeOf(toRaw(s)) == Array.prototype)
            probe(label + ' sPO keys/json', () => [Object.keys(s), JSON.stringify(s), isReactive(s)])
        }
    }
}

// a fixed (non-configurable) key is mirrored onto the dummy target; refused writes surface as errors
function fixedKeyErrorProbes() {
    const {s} = fresh()
    Object.defineProperty(s, 'fixed', {value: 1, configurable: false, enumerable: true, writable: false})
    probe('fixed strict set', () => { strictSet(s, 'fixed', 5); return s.fixed })
    probe('fixed strict delete', () => { strictDelete(s, 'fixed'); return s.fixed })
    probe('fixed redefine', () => Object.defineProperty(s, 'fixed', {value: 3}))
    probe('fixed inspect', () => inspect(s))
    probe('fixed ownKeys', () => Reflect.ownKeys(s))
    const arr = reactive<any>([1, 2], manual().opts)
    probe('array freeze attempt', () => Object.freeze(arr) == arr)
    probe('array after freeze attempt', () => [Object.isExtensible(arr), Object.isFrozen(toRaw(arr)), JSON.stringify(arr)])
    probe('array push after freeze attempt', () => arr.push(3))
    probe('array strict length after freeze attempt', () => { strictSet(arr, 'length', 0); return arr.length })
}

// inspection and reflection see a plain object or array, never the engine
function reflectionProbes() {
    const {raw, s} = fresh()
    probe('inspect object', () => inspect(s))
    probe('inspect array', () => inspect(s.arr))
    probe('inspect nested', () => [inspect(s.b), inspect(s.empty), inspect(s.nested)])
    probe('inspect deep', () => inspect(s, {depth: 5}))
    probe('util.types.isProxy', () => [types.isProxy(s), types.isProxy(s.arr), types.isProxy(toRaw(s))])
    probe('constructor names', () => [s.constructor.name, s.arr.constructor.name, s.b.constructor.name, Object.getOwnPropertyDescriptor(s, 'constructor')])
    probe('string forms', () => [String(s), `${s.b}`, s.arr.toString(), s.nested.join(';'), Object.prototype.toString.call(s.empty)])
    probe('private symbol unreachable', () => [s[Symbol('reactive.node')], s[Symbol.for('reactive.node')], Object.getOwnPropertySymbols(s).length])
    probe('thenable', () => [typeof s.then, typeof s.arr.then])
    probe('inherit through proxy', () => { const child = Object.create(s); return [child.a, child.b == s.b, 'a' in child, Object.keys(child), isReactive(child)] })
    probe('write through inheritor', () => { const child = Object.create(s); child.q = 1; return [Object.hasOwn(child, 'q'), raw.q, s.q] })
    probe('proxy of proxy', () => { const wrapped = new Proxy(s, {}); return [wrapped.a, isReactive(wrapped), toRaw(wrapped) == raw, wrapped.b == s.b] })
    probe('Reflect.get receiver', () => [Reflect.get(s, 'a', {}), Reflect.get(s, 'b', {}) == s.b])
    probe('foreign values', () => { const foreign = new Proxy({x: 1}, {}); const fn = function plain() {}; return [isReactive(foreign), toRaw(foreign) == foreign, isReactive(fn), toRaw(fn) == fn] })
    probe('array concat spread', () => [Array.prototype.concat.call([], s.arr).length, [0].concat(s.nested).length])
    probe('onUpdate plain', () => onUpdate({}, () => {}))
    probe('onUpdatePaths primitive', () => onUpdatePaths(1, () => {}))
    probe('flushReactive null', () => flushReactive(null))
    probe('flushReactiveNow string', () => flushReactiveNow('x'))
}

// trap names and node field names planted on Object.prototype: the engine's own lookups are unaffected
function pollutionProbes() {
    let trapCalls = 0
    Object.defineProperty(Object.prototype, 'isExtensible', {
        configurable: true, writable: true,
        value: function pollutedIsExtensible(target: object) { trapCalls++; return Reflect.isExtensible(target) },
    })
    let extensible: unknown
    try { extensible = Object.isExtensible(reactive<any>({a: 1}, manual().opts)) }
    finally { Reflect.deleteProperty(Object.prototype, 'isExtensible') }
    probe('polluted trap name', () => [trapCalls, extensible])

    const fields = ['target', 'parent', 'key', 'path', 'level', 'active', 'subs', 'pathSubs', 'kids', 'proxy', 'eng']
    let fieldHits = 0
    const facts: string[] = []
    const paths: string[] = []
    let json = ''
    let reactiveList = false
    for (const field of fields) {
        Object.defineProperty(Object.prototype, field, {
            configurable: true,
            get() { fieldHits++; return 'polluted' },
            set() { fieldHits++ },
        })
    }
    try {
        const d = manual()
        const s = reactive<any>({a: {b: 1}, list: [1]}, d.opts)
        onUpdate(s, () => facts.push('root'))
        onUpdatePaths(s, change => paths.push(change.paths.map(pathText).join('|')))
        s.a.b = 2
        s.list.push(2)
        const a = s.a
        delete s.a
        a.b = 3
        d.flush()
        json = JSON.stringify(s)
        reactiveList = isReactive(s.list)
    } finally {
        for (const field of fields) Reflect.deleteProperty(Object.prototype, field)
    }
    probe('polluted field names', () => [fieldHits, facts, paths, json, reactiveList])
}

function subscriptionProbes() {
    const d = manual()
    const s = reactive<any>({a: {b: {c: 1}}, arr: [{x: 1}], list: [1, 2]}, d.opts)
    const rootPaths: string[] = []
    const bPaths: string[] = []
    const facts: string[] = []
    onUpdatePaths(s, ch => rootPaths.push(ch.paths.map(p => p.join('/')).sort().join('|')))
    const b = s.a.b
    onUpdatePaths(b, ch => bPaths.push(ch.paths.map(p => p.join('/')).sort().join('|')))
    onUpdate(b, () => facts.push('b'))
    onUpdate(s.arr, () => facts.push('arr'))
    s.a.b.c = 2
    d.flush()
    s.arr[0].x = 2; s.arr.push({x: 3}); s.list.push(3)
    d.flush()
    delete s.a.b
    d.flush()
    b.c = 3                       // write on a detached proxy: the engine still resolves its (frozen) path
    d.flush()
    s.a = {b: {c: 4}}
    d.flush()
    s.list.length = 1
    d.flush()
    s.arr = {x: 1}
    d.flush()
    probe('paths root', () => rootPaths)
    probe('paths b (detached keeps its path)', () => bPaths)
    probe('facts', () => facts)
    probe('detached', () => [isReactive(b), b.c, toRaw(b), isReactive(s.a.b), s.a.b == b])
    probe('detached kid', () => { const kid = b.c = {z: 1}; return [isReactive(b.c), toRaw(b.c) == toRaw(kid)] })
    probe('detached subscribe', () => [onUpdate(b, () => {}), onUpdatePaths(b, () => {})])
}

// a node read under a detached node is live: its subscribers resolve paths through the frozen prefix
function lateKidProbes() {
    const d = manual()
    const s = reactive<any>({a: {b: {c: {x: 1}}}}, d.opts)
    const b = s.a.b
    const c = b.c
    delete s.a
    d.flush()
    b.late = {x: 1}
    const late = b.late
    const latePaths: string[] = []
    const lateFacts: string[] = []
    onUpdatePaths(late, ch => latePaths.push(ch.paths.map(pathText).join('|')))
    onUpdate(late, () => lateFacts.push('late'))
    late.x = 2
    late.y = {z: 1}
    d.flush()
    late.y.z = 2
    d.flush()
    late.y = 5
    d.flush()
    probe('late kid under detached', () => [isReactive(b), isReactive(c), isReactive(late), latePaths, lateFacts])
    probe('late kid identity', () => [b.late == late, toRaw(late), JSON.stringify(b)])
}

function arrayMutationProbes() {
    const d = manual()
    const s = reactive<any>({grid: {rows: [{id: 1}, {id: 2}], cols: [3, 1, 2]}, flag: {on: true}}, d.opts)
    const changes: string[] = []
    onUpdatePaths(s, function recordChange(change) {
        const arrays = (change as any)[REACTIVE_ARRAY_MUTATIONS] as ReactiveArrayMutations | undefined
        changes.push(change.paths.map(pathText).join('|')
            + ' ; mutations ' + (arrays?.paths.map(pathText).join('|') ?? '-')
            + ' ; replacements ' + (arrays?.replacements.map(pathText).join('|') ?? '-'))
    })
    s.grid.rows.push({id: 3})
    d.flush()
    s.grid.rows[0].id = 9
    d.flush()
    s.grid.cols.sort()
    d.flush()
    s.grid.cols.reverse()
    d.flush()
    s.grid.cols.fill(0, 1)
    d.flush()
    s.grid.rows.splice(1, 1)
    d.flush()
    s.grid.cols = {n: 1}
    d.flush()
    s.flag = [1, 2]
    d.flush()
    s.flag.push(3)
    d.flush()
    probe('array mutation paths', () => changes)
}

function mutationHookProbes() {
    // the private Store hook: the mutation path of every write, detached nodes included
    const log: string[] = []
    const d = manual()
    const s = reactive<any>({a: {b: {c: 1}}, arr: [1, [2]], m: {}}, {...d.opts, _onMutation: (p: PropertyKey[]) => log.push(p.map(String).join('/') || '<root>')} as any)
    const b = s.a.b
    s.a.b.c = 2
    s.arr[0] = 5
    s.arr.push(6)
    s.arr[1][0] = 9
    delete s.a.b
    b.c = 7
    b.q = {w: 1}
    b.q.w = 2
    Object.defineProperty(s, 'm', {value: {z: 1}, configurable: true, enumerable: true, writable: true})
    s.m.z = 3
    s.arr.length = 1
    d.flush()
    probe('onMutation log', () => log)
}

function detachedPathProbes() {
    const log: string[] = []
    const d = manual()
    const s = reactive<any>({
        a: {b: {c: {d: 1}, e: {f: 1}}},
        list: [{v: 1}, {v: 2}, {v: 3}],
        q: {w: 0},
        rows: [{id: 'old'}],
        obj: {},
    }, {...d.opts, _onMutation: (p: PropertyKey[]) => log.push(pathText(p))} as any)
    const b = s.a.b
    const c = b.c
    delete s.a                    // detaches a whole subtree: every node keeps its own full path
    c.d = 5
    b.x = {y: 1}
    b.x.y = 2
    const e = b.e                 // read under the detached b: a live node...
    delete b.e                    // ...that detaches in turn, below a detached parent
    e.f = 3
    const el = s.list[1]
    s.list.length = 1             // truncation detaches the cut elements
    el.v = 9
    const q = s.q
    s.q = 5                       // a plain write of a leaf rebinds the node to the leaf, it stays attached
    probe('branch set to a leaf', () => [isReactive(q), q.w, toRaw(q)])
    probe('write through a leaf-bound node', () => { q.w = 1; return q.w })
    probe('keys of a leaf-bound node', () => Object.keys(q))
    const g = s.g = {h: 1}
    const gp = s.g
    Object.defineProperty(s, 'g', {value: 7, configurable: true, enumerable: true, writable: true})   // a defined leaf detaches
    gp.h = 2
    probe('branch defined as a leaf', () => [isReactive(gp), toRaw(gp) == g, gp.h, s.g])
    const r = s.rows[0]
    s.rows[0] = {id: 'new'}       // a branch replaced by a branch rebinds, it stays attached
    r.id = 'rebound'
    s[sym] = {a: 1}
    const t = s[sym]
    delete s[sym]
    t.a = 2
    s.obj[1] = {n: 1}
    s.obj[1].n = 2
    d.flush()
    probe('detached paths log', () => log)
    probe('detached state', () => [isReactive(b), isReactive(c), isReactive(e), isReactive(el), isReactive(q), isReactive(r), isReactive(t), r.id, JSON.stringify(s.rows)])
}

function depthProbes() {
    const d = manual()
    const s = reactive<any>({a: {b: {c: {d: 1}}}}, {...d.opts, depth: 2})
    probe('depth 2', () => [isReactive(s.a), isReactive(s.a.b), isReactive(s.a.b.c), isReactive(s.a.b.c.d)])
    const b = s.a.b
    delete s.a
    probe('depth 2 detached level', () => [isReactive(b), isReactive(b.c), b.c.d])
    const e = reactive<any>({a: {b: {c: {d: 1}}}}, {...d.opts, depth: 2, eager: true})
    probe('eager depth 2', () => [isReactive(e.a), isReactive(e.a.b), isReactive(e.a.b.c)])
    const z = reactive<any>({a: {b: {c: {d: 1}}}}, {...d.opts, depth: 0})
    probe('depth 0', () => [isReactive(z), isReactive(z.a)])
    const one = reactive<any>({a: {b: {c: 1}}}, {...d.opts, depth: 1})
    probe('depth 1', () => [isReactive(one.a), isReactive(one.a.b), one.a.b.c])
    const three = reactive<any>({a: {b: {c: {d: {e: 1}}}}}, {...d.opts, depth: 3})
    const tb = three.a.b
    delete three.a                // a detached node keeps its level for the depth limit
    probe('depth 3 detached, late kids', () => [isReactive(tb), isReactive(tb.c), isReactive(tb.c.d), tb.c.d.e])
    probe('depth NaN / -1', () => {
        const nan = reactive<any>({a: {b: 1}}, {...d.opts, depth: NaN})
        const neg = reactive<any>({a: {b: 1}}, {...d.opts, depth: -1})
        return [isReactive(nan), isReactive(nan.a), isReactive(neg), isReactive(neg.a)]
    })
    probe('eager cycle', () => {
        const raw: any = {a: {}}
        raw.a.self = raw
        const cyc = reactive<any>(raw, {...d.opts, eager: true})
        return [isReactive(cyc.a), isReactive(cyc.a.self), toRaw(cyc.a.self) == raw, cyc.a.self == cyc]
    })
}

type tStoreRows = {rows: Record<string, {px: number}>, list: number[], zz?: number}

function storeProbes() {
    const pending: Fn[] = []
    const flush = () => { let n = 0; while (pending.length && ++n < 50) pending.shift()!() }
    const store = createStore<tStoreRows>({rows: {k1: {px: 1}, k2: {px: 2}}, list: [1, 2]}, {drain: (f: Fn) => { pending.push(f) }})
    const seen: string[] = []
    store.node.rows.k1.px.on((v: any) => seen.push('k1.px=' + v))
    store.node.rows.on((v: any, ctx: any) => seen.push('rows keys=' + Object.keys(v).join(',') + ' exists=' + ctx.exists))
    store.each().on((k: string, v: any) => seen.push('each ' + k + '=' + JSON.stringify(v)))
    store.state.rows.k1.px = 10
    flush()
    store.state.rows = {k3: {px: 3}}
    flush()
    store.state.list.push(3)
    flush()
    store.replace({rows: {k1: {px: 5}}, list: []})
    flush()
    probe('store seen', () => seen)
    probe('store snapshot', () => JSON.stringify(store.snapshot()))
    probe('store count', () => store.count())
    probe('store node get', () => [store.node.rows.k1.px.get(), store.node.rows.k1.has(), store.node.zz.has(), JSON.stringify(store.node.rows.snapshot())])
}

// ============================================================
//  checks
// ============================================================

function renderAll() {
    rendered.length = 0
    readProbes()
    writeProbes()
    unsyncedArrayProbes()
    integrityProbes()
    fixedKeyErrorProbes()
    reflectionProbes()
    pollutionProbes()
    subscriptionProbes()
    lateKidProbes()
    arrayMutationProbes()
    mutationHookProbes()
    detachedPathProbes()
    depthProbes()
    storeProbes()
    return [...rendered]
}

function parsePinned() {
    const pinned = new Map<string, string>()
    for (const line of PINNED.split(/\r?\n/)) {
        if (!line) continue
        const at = line.indexOf(' => ')
        assert.ok(at > 0 && !pinned.has(line.slice(0, at)), 'malformed or duplicate pinned line: ' + line)
        pinned.set(line.slice(0, at), line.slice(at + 4))
    }
    return pinned
}

function surfaceMatchesPin(lines: typeof rendered) {
    const pinned = parsePinned()
    const labels = new Set<string>()
    const problems: string[] = []
    for (const {label, out} of lines) {
        if (labels.has(label)) problems.push('duplicate probe label: ' + label)
        labels.add(label)
        if (!pinned.has(label)) problems.push(label + '\n    not pinned; renders: ' + out)
        else if (pinned.get(label) != out) problems.push(label + '\n    pinned: ' + pinned.get(label) + '\n    actual: ' + out)
    }
    for (const label of pinned.keys()) if (!labels.has(label)) problems.push(label + '\n    pinned, but no probe renders it')
    assert.ok(problems.length == 0, problems.length + ' surface difference(s):\n  ' + problems.join('\n  '))
    console.log('      ' + lines.length + ' probes render as pinned')
}

// what a leaked node or dummy slot would render as: node fields, the private symbol, the dummy's class
const INTERNAL_MARKERS = [/\bpathSubs\b/, /\bkids\b/, /"eng"/, /reactive\.node/, /Dummy/, /Symbol\((?!user\))/]

function noInternalsSurface(lines: typeof rendered) {
    const leaks = lines.filter(({out}) => INTERNAL_MARKERS.some(marker => marker.test(out)))
    assert.deepEqual(leaks, [], 'engine internals surfaced through reflection or error text')
}

async function main() {
    const lines = renderAll()
    for (const check of [surfaceMatchesPin, noInternalsSurface]) {
        try { check(lines); console.log('PASS ' + check.name) }
        catch (error) { console.error('FAIL ' + check.name, error); process.exitCode = 1 }
    }
}

// ============================================================
//  the surface as the 3.1.0 engine rendered it: `label => rendering`, one probe per line
// ============================================================

const PINNED = String.raw`
keys => ["a", "b", "arr", "empty", "nested"]
ownKeys => ["a", "b", "arr", "empty", "nested", Symbol(user)]
names => ["a", "b", "arr", "empty", "nested"]
symbols => [Symbol(user)]
symbols(b) => []
symbols(arr) => []
desc a => {"value": 1, "writable": true, "enumerable": true, "configurable": true}
desc b (raw value) => {"value": "RAW", "writable": true, "enumerable": true, "configurable": true}
desc missing => undefined
desc sym => {"value": "s", "writable": true, "enumerable": true, "configurable": true}
descriptors keys => ["a", "b", "arr", "empty", "nested"]
descriptors symbols => [Symbol(user)]
in a => true
in zz => false
in toJSON => false
in constructor => true
in sym => true
hasOwn => [true, false, true]
entries => ["a:number", "b:P", "arr:P", "empty:P", "nested:P"]
for-in => ["a", "b", "arr", "empty", "nested"]
assign => ["a", "b", "arr", "empty", "nested"]
spread proxy => ["\"a\":number", "\"b\":P", "\"arr\":P", "\"empty\":P", "\"nested\":P", "Symbol(user):string"]
spread raw => ["a", "b", "arr", "empty", "nested", Symbol(user)]
spread arr => [1, "P"]
json => "{\"a\":1,\"b\":{\"c\":2,\"d\":{\"e\":3}},\"arr\":[1,{\"x\":1}],\"empty\":{},\"nested\":[[1],[2]]}"
json arr => "[1,{\"x\":1}]"
json nested => "[[1],[2]]"
structuredClone(toRaw) => "{\"a\":1,\"b\":{\"c\":2,\"d\":{\"e\":3}},\"arr\":[1,{\"x\":1}],\"empty\":{},\"nested\":[[1],[2]]}"
structuredClone(proxy) => THROWS DOMException: #<Object> could not be cloned.
structuredClone(toRaw(arr)) => [1, {"x": 1}]
isArray => [true, false, false, true]
toString tags => ["[object Object]", "[object Array]"]
proto => [true, true, true]
instanceof => [true, true, true]
constructor => [true, true]
proto methods => [true, "function", true]
array methods => [[1, "P"], 0, true, [1], 2, [0, 1]]
array iter identity => true
child identity => [true, true, true]
isReactive => [true, true, true, true, false, false, false, false, false, false, false]
toRaw => [true, true, true, 1, null, undefined, "x", true]
isExtensible/frozen/sealed => [true, false, false, true]
proxy identity vs raw => [false, false, true]
length => [2, 2, {"value": 2, "writable": true, "enumerable": false, "configurable": false}]
desc index => {"value": {"x": 1}, "writable": true, "enumerable": true, "configurable": true}
array keys => [["0", "1"], ["0", "1", "length"]]
reactive(reactive) => [false, true, true]
after push => [3, 3, 3, ["0", "1", "2"]]
after splice => [2, 2, "[{\"x\":1},3]", 2]
after truncate => [1, 1, "[{\"x\":1}]", 1, ["0"]]
after unshift => [2, "[0,{\"x\":1}]"]
after hole write => [6, "[0,{\"x\":1},null,null,null,5]", ["0", "1", "5"], false]
after empty => [0, "[]", {"value": 0, "writable": true, "enumerable": false, "configurable": false}]
sym write => ["changed", "changed", 6]
sym delete => [undefined, false, 5]
define fixed => true
fixed visible => [true, {"value": 1, "writable": false, "enumerable": true, "configurable": false}, true, 1]
delete fixed => false
delete fixed strict => undefined
redefine fixed => false
define accessor => [42, true, true]
raw keys => ["a", "b", "arr", "empty", "nested", "fixed", "acc"]
arr->obj json => "{\"x\":1}"
arr->obj keys => [["x"], ["x", "length"], true, undefined, {"value": 0, "writable": true, "enumerable": false, "configurable": false}]
arr->obj in => THROWS TypeError: 'has' on proxy: trap returned falsish for property 'length' which exists in the proxy target as non-configurable
arr->obj identity => [true, true, true]
obj->arr back => ["[7,8]", 2, true, "undefined", ["0", "1"]]
obj->arr json => ["{\"0\":1,\"1\":2,\"2\":3}", false, 3, ["0", "1", "2"], true, {"value": 3, "writable": true, "enumerable": false, "configurable": true}]
obj->arr toString => "[object Object]"
obj restored => ["{\"c\":9}", true, 9]
arr->obj custom toJSON => "\"custom\""
unsynced arr->obj length desc => [{"value": 2, "writable": true, "enumerable": false, "configurable": false}, undefined, ["x", "length"], ["x"]]
unsynced nested arr->obj => [{"value": 2, "writable": true, "enumerable": false, "configurable": false}, "{\"y\":2}", false, [1]]
unsynced big arr->obj => [{"value": 10000, "writable": true, "enumerable": false, "configurable": false}, "[\"length\"]"]
nonempty preventExtensions => true
nonempty pE isExtensible => false
nonempty pE keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty pE ownKeys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty pE in => [true, false]
nonempty pE get => 1
nonempty pE json => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty pE set existing => 2
nonempty pE set new => 1
nonempty pE desc => THROWS TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned descriptor for property 'a' that is incompatible with the existing property in the proxy target
nonempty pE isReactive/toRaw => [true, ["a", "z"]]
nonempty pE strict set new => 1
nonempty pE define new => THROWS TypeError: 'defineProperty' on proxy: trap returned truish for adding property 'w'  to the non-extensible proxy target
nonempty pE setPrototypeOf => THROWS TypeError: #<Object> is not extensible
nonempty pE inspect => "{}"
nonempty freeze => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty fr keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty fr isFrozen => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty fr raw => [false, ["a"]]
nonempty fr strict set => 5
nonempty fr strict delete => undefined
nonempty fr inspect => "{}"
nonempty seal => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty se keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty se isSealed => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
nonempty se strict delete => undefined
nonempty setPrototypeOf null => true
nonempty sPO proto => null
nonempty sPO raw proto => true
nonempty sPO keys/json => [["a"], "{\"a\":1}", true]
empty preventExtensions => true
empty pE isExtensible => false
empty pE keys => []
empty pE ownKeys => []
empty pE in => [false, false]
empty pE get => undefined
empty pE json => "{}"
empty pE set existing => 2
empty pE set new => 1
empty pE desc => THROWS TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned descriptor for property 'a' that is incompatible with the existing property in the proxy target
empty pE isReactive/toRaw => [true, ["a", "z"]]
empty pE strict set new => 1
empty pE define new => THROWS TypeError: 'defineProperty' on proxy: trap returned truish for adding property 'w'  to the non-extensible proxy target
empty pE setPrototypeOf => THROWS TypeError: #<Object> is not extensible
empty pE inspect => "{}"
empty freeze => true
empty fr keys => []
empty fr isFrozen => true
empty fr raw => [false, []]
empty fr strict set => 5
empty fr strict delete => undefined
empty fr inspect => "{}"
empty seal => true
empty se keys => []
empty se isSealed => [true, true]
empty se strict delete => undefined
empty setPrototypeOf null => true
empty sPO proto => null
empty sPO raw proto => true
empty sPO keys/json => [[], "{}", true]
array preventExtensions => true
array pE isExtensible => false
array pE keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array pE ownKeys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array pE in => [false, false]
array pE get => undefined
array pE json => "[1]"
array pE set existing => 2
array pE set new => 1
array pE desc => THROWS TypeError: 'getOwnPropertyDescriptor' on proxy: trap returned descriptor for property 'a' that is incompatible with the existing property in the proxy target
array pE isReactive/toRaw => [true, ["0", "length", "a", "z"]]
array pE strict set new => 1
array pE define new => THROWS TypeError: 'defineProperty' on proxy: trap returned truish for adding property 'w'  to the non-extensible proxy target
array pE setPrototypeOf => THROWS TypeError: [object Array] is not extensible
array pE inspect => "[ <1 empty item> ]"
array freeze => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array fr keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array fr isFrozen => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array fr raw => [false, ["0", "length"]]
array fr strict set => 5
array fr strict delete => undefined
array fr inspect => "[ <1 empty item> ]"
array seal => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array se keys => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array se isSealed => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array se strict delete => undefined
array setPrototypeOf null => true
array sPO proto => null
array sPO raw proto => true
array sPO keys/json => [["0"], "[1]", true]
fixed strict set => THROWS TypeError: 'set' on proxy: trap returned falsish for property 'fixed'
fixed strict delete => THROWS TypeError: 'deleteProperty' on proxy: trap returned falsish for property 'fixed'
fixed redefine => THROWS TypeError: 'defineProperty' on proxy: trap returned falsish for property 'fixed'
fixed inspect => "{ fixed: 1 }"
fixed ownKeys => ["a", "b", "arr", "empty", "nested", "fixed", Symbol(user)]
array freeze attempt => THROWS TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
array after freeze attempt => [false, false, "[1,2]"]
array push after freeze attempt => 3
array strict length after freeze attempt => 0
inspect object => "{}"
inspect array => "[ <2 empty items> ]"
inspect nested => ["{}", "{}", "[ <2 empty items> ]"]
inspect deep => "{}"
util.types.isProxy => [true, true, false]
constructor names => ["Object", "Array", "Object", undefined]
string forms => ["[object Object]", "[object Object]", "1,[object Object]", "1;2", "[object Object]"]
private symbol unreachable => [undefined, undefined, 1]
thenable => ["undefined", "undefined"]
inherit through proxy => [1, true, true, [], true]
write through inheritor => [false, 1, 1]
proxy of proxy => [1, true, true, true]
Reflect.get receiver => [1, true]
foreign values => [false, true, false, true]
array concat spread => [2, 3]
onUpdate plain => THROWS Error: onUpdate: not a reactive object
onUpdatePaths primitive => THROWS Error: onUpdatePaths: not a reactive object
flushReactive null => THROWS Error: flushReactive: not a reactive object
flushReactiveNow string => THROWS Error: flushReactiveNow: not a reactive object
polluted trap name => [1, true]
polluted field names => [0, ["root"], ["a/b|list|a"], "{\"list\":[1,2]}", true]
paths root => ["a/b/c", "arr|arr/0/x|list", "a/b", "a", "list", "arr"]
paths b (detached keeps its path) => ["c", ""]
facts => ["b", "arr", "b", "arr"]
detached => [false, 3, {"c": 3}, true, false]
detached kid => [true, true]
detached subscribe => THROWS Error: onUpdate: reactive object is detached
late kid under detached => [false, false, true, ["x|y", "y/z", "y"], ["late", "late", "late"]]
late kid identity => [true, {"x": 2, "y": 5}, "{\"c\":{\"x\":1},\"late\":{\"x\":2,\"y\":5}}"]
array mutation paths => ["grid/rows ; mutations grid/rows/2 ; replacements ", "grid/rows/0/id ; mutations  ; replacements ", "grid/cols ; mutations grid/cols/0|grid/cols/1|grid/cols/2 ; replacements ", "grid/cols ; mutations grid/cols/0|grid/cols/2 ; replacements ", "grid/cols ; mutations grid/cols/1|grid/cols/2 ; replacements ", "grid/rows ; mutations grid/rows/1|grid/rows/2|grid/rows/length ; replacements ", "grid/cols ; mutations  ; replacements grid/cols", "flag ; mutations  ; replacements flag", "flag ; mutations flag/2 ; replacements "]
onMutation log => ["a/b/c", "arr", "arr", "arr/1", "a/b", "a/b/c", "a/b/q", "a/b/q/w", "m", "m/z", "arr"]
branch set to a leaf => [true, undefined, 5]
write through a leaf-bound node => THROWS TypeError: Reflect.defineProperty called on non-object
keys of a leaf-bound node => THROWS TypeError: Reflect.ownKeys called on non-object
branch defined as a leaf => [false, true, 2, 7]
detached paths log => ["a", "a/b/c/d", "a/b/x", "a/b/x/y", "a/b/e", "a/b/e/f", "list", "list/1/v", "q", "g", "g", "g/h", "rows", "rows/0/id", "Symbol(user)", "Symbol(user)", "Symbol(user)/a", "obj/1", "obj/1/n"]
detached state => [false, false, false, false, true, true, false, "rebound", "[{\"id\":\"rebound\"}]"]
depth 2 => [true, true, false, false]
depth 2 detached level => [false, false, 1]
eager depth 2 => [true, true, false]
depth 0 => [true, false]
depth 1 => [true, false, 1]
depth 3 detached, late kids => [false, true, false, 1]
depth NaN / -1 => [true, false, true, false]
eager cycle => [true, true, true, false]
store seen => ["k1.px=10", "rows keys=k1,k2 exists=true", "each rows={\"k1\":{\"px\":10},\"k2\":{\"px\":2}}", "rows keys=k3 exists=true", "k1.px=undefined", "each rows={\"k3\":{\"px\":3}}", "each list=[1,2,3]", "rows keys=k1 exists=true", "k1.px=5", "each rows={\"k1\":{\"px\":5}}", "each list=[]"]
store snapshot => "{\"rows\":{\"k1\":{\"px\":5}},\"list\":[]}"
store count => 2
store node get => [5, true, false, "{\"k1\":{\"px\":5}}"]
`

runOracle(main)
