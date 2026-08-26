// =====================================================================
//  The library replaces the global JSON.stringify. It must stay indistinguishable
//  from the real one — except for the single thing it exists to do.
//
//  Importing `core/common` installs a process-wide replacement for `JSON.stringify`, so
//  every consumer of this package — and every third-party library loaded next to it —
//  serialises through it. The replacement exists for exactly one reason: a `CObjectID`
//  must travel as its numeric value rather than as `{"value":1}`.
//
//  A hand-written reimplementation of a builtin is only as good as its fidelity, and
//  fidelity is not something to assert from memory. The oracle here is the real
//  `JSON.stringify` taken from a fresh V8 realm, which the patch cannot reach: for every
//  input that contains no CObjectID, the two must produce byte-identical output, and the
//  same sequence of replacer invocations with the same holders.
//
//  The case that made this test necessary: an ARRAY replacer is a property allow-list,
//  and the spec applies it to object properties only — array elements are always kept.
//  The replacement applied it to array indices too, so `JSON.stringify({a:[1,2,3]},['a'])`
//  came back as `{"a":[null,null,null]}`. Silent data loss in a builtin, for any caller
//  in the process.
// =====================================================================
import {runInNewContext} from 'node:vm'
import {CObjectID} from '../../src/Common/core/common'

// A stringify from another realm: constructed before nothing, reachable by nothing, and
// therefore the only trustworthy statement of what the answer should be.
const pristine = runInNewContext('JSON.stringify') as typeof JSON.stringify

type Test = {name: string, fn: () => void}
const tests: Test[] = []
function test(name: string, fn: () => void) { tests.push({name, fn}) }
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

/** Both implementations on the same input; they must agree exactly. */
function agree(label: string, value: unknown, replacer?: any, space?: any) {
    const expected = pristine(value as any, replacer, space)
    const actual = JSON.stringify(value as any, replacer, space)
    assert(actual === expected, label + '\n      native: ' + expected + '\n      ours:   ' + actual)
}

// ---------------------------------------------------------------------
// Array replacer — a property allow-list, not an element filter
// ---------------------------------------------------------------------
test('array replacer keeps array elements', () => {
    agree('an array behind an allowed key', {a: [1, 2, 3]}, ['a'])
    agree('objects inside an allowed array', {a: [{b: 1, c: 2}]}, ['a', 'b'])
    agree('nested arrays', {a: [[1, 2], [3]]}, ['a'])
    agree('a top-level array', [1, 2, 3], ['0'])
    agree('array of objects at the top level', [{a: 1, b: 2}], ['a'])
})

test('array replacer filters object properties', () => {
    agree('one key of two', {a: 1, b: 2}, ['a'])
    agree('nested objects', {a: {b: 1, c: 2}, d: 3}, ['a', 'b'])
    agree('a key that is not present', {a: 1}, ['zzz'])
    agree('an empty allow-list', {a: 1}, [])
})

test('array replacer follows the spec on order, duplicates and numeric keys', () => {
    agree('output order follows the replacer, not the object', {b: 1, a: 2}, ['a', 'b'])
    agree('duplicates collapse', {a: 1, b: 2}, ['a', 'a', 'b'])
    agree('numeric entries name string keys', {1: 'x', b: 'y'}, [1])
    agree('non-string non-number entries are ignored', {a: 1, b: 2}, ['a', true, null])
})

// ---------------------------------------------------------------------
// Function replacer — same values, same holders, same order
// ---------------------------------------------------------------------
test('function replacer sees the same calls with the same holder', () => {
    const value = {a: [1, {b: 2}], c: 'x'}
    // The holder is what `this` is bound to, and it is the only way a replacer can tell an
    // array element from an object property. Describe each call without serialising it.
    const shape = (val: unknown) => val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val
    function trace(calls: string[]) {
        return function replace(this: any, key: string, val: unknown) {
            calls.push(key + ':' + shape(this) + ':' + shape(val))
            return val
        }
    }

    const nativeCalls: string[] = []
    const oursCalls: string[] = []
    const nativeOut = pristine(value, trace(nativeCalls))
    const oursOut = JSON.stringify(value, trace(oursCalls))
    assert(oursOut === nativeOut, 'output differs: ' + nativeOut + ' vs ' + oursOut)
    assert(oursCalls.join('|') === nativeCalls.join('|'),
        'replacer call sequence differs\n      native: ' + nativeCalls.join('|') + '\n      ours:   ' + oursCalls.join('|'))
})

test('function replacer can drop and rewrite values', () => {
    const drop = (key: string, val: unknown) => key == 'secret' ? undefined : val
    agree('a dropped key', {a: 1, secret: 2}, drop)
    agree('a dropped key inside an array', [{secret: 1, a: 2}], drop)
    const bump = (key: string, val: unknown) => typeof val == 'number' ? val + 1 : val
    agree('a rewritten number', {a: 1, b: [2, 3]}, bump)
})

// ---------------------------------------------------------------------
// space, toJSON and the ordinary path
// ---------------------------------------------------------------------
test('space and toJSON behave natively', () => {
    agree('numeric space', {a: {b: 1}}, undefined, 2)
    agree('string space', {a: {b: 1}}, undefined, '\t')
    agree('space with an array replacer', {a: {b: 1, c: 2}}, ['a', 'b'], 2)
    agree('toJSON is honoured', {when: new Date(0)}, undefined)
    agree('a bare value', 42, undefined)
    agree('undefined at the root', undefined, undefined)
    agree('a function at the root', function noop() {}, undefined)
})

// ---------------------------------------------------------------------
// The one intended difference
// ---------------------------------------------------------------------
test('a CObjectID still travels as its value', () => {
    const id = new CObjectID<{tag: string}, {owner: string}>({tag: 't'}, {owner: 'o'})
    const expected = '"' + id.value + '"'
    assert(JSON.stringify(id) === expected, 'at the root: ' + JSON.stringify(id))
    assert(JSON.stringify({id}) === '{"id":' + expected + '}', 'as a property: ' + JSON.stringify({id}))
    assert(JSON.stringify([id]) === '[' + expected + ']', 'inside an array: ' + JSON.stringify([id]))
    assert(JSON.stringify({a: {b: id}}) === '{"a":{"b":' + expected + '}}', 'nested: ' + JSON.stringify({a: {b: id}}))
    // The conversion happens before a user replacer sees the value, as it did before.
    const seen: unknown[] = []
    JSON.stringify({id}, function collect(key, val) { if (key == 'id') seen.push(val); return val })
    assert(seen.length == 1 && seen[0] === id.value + '', 'a replacer sees the converted value, got ' + seen[0])
    // And an allow-list still admits it.
    assert(JSON.stringify({id, other: 1}, ['id']) === '{"id":' + expected + '}',
        'with an array replacer: ' + JSON.stringify({id, other: 1}, ['id']))
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
    console.log((failed == 0 ? 'PASS' : 'FAIL') + ' json-stringify-fidelity: ' + (tests.length - failed) + '/' + tests.length)
    process.exit(failed == 0 ? 0 : 1)
}

main()
