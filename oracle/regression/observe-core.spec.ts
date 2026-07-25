import * as srcApi from '../../src/Common/Observe/reactive'
import * as observeApi from '../../observe/reactive'

type Fn = () => void
type Api = typeof srcApi

let failures = 0
const tests: Array<{name: string; run: () => void | Promise<void>}> = []

function test(name: string, run: () => void | Promise<void>) {
    tests.push({name, run})
}

function assert(cond: unknown, message: string) {
    if (!cond) throw new Error(message)
}

function assertEq<T>(actual: T, expected: T, message: string) {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
    }
}

function assertDeepEq(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`)
}

function assertThrows(run: () => void, match: RegExp, message: string) {
    try {
        run()
    } catch (e: any) {
        assert(match.test(String(e?.message ?? e)), `${message}: wrong error ${String(e?.message ?? e)}`)
        return
    }
    throw new Error(`${message}: did not throw`)
}

function createManualDrain() {
    const queue: Fn[] = []
    return {
        opts: {drain: (f: Fn) => { queue.push(f) }},
        get pending() { return queue.length },
        flushOne() {
            const f = queue.shift()
            if (f) f()
        },
        flushAll(limit = 20) {
            let count = 0
            while (queue.length) {
                if (++count > limit) throw new Error('manual drain did not settle')
                queue.shift()!()
            }
        },
        clear() { queue.length = 0 },
    }
}

async function tick() {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function addCoreSuite(label: string, api: Api) {
    const {reactive, onUpdate, flushReactive, listenUpdate} = api

    test(`${label}: nested subscriptions fire only for affected branches`, () => {
        const drain = createManualDrain()
        const s = reactive<any>({a: {b: {c: 1}, d: 1}, z: 1}, drain.opts)
        let root = 0, a = 0, b = 0
        onUpdate(s, () => root++)
        onUpdate(s.a, () => a++)
        onUpdate(s.a.b, () => b++)

        s.a.b.c = 2
        drain.flushAll()
        assertDeepEq({root, a, b}, {root: 1, a: 1, b: 1}, 'deep child update reaches root, parent, and child')

        s.a.d = 2
        drain.flushAll()
        assertDeepEq({root, a, b}, {root: 2, a: 2, b: 1}, 'sibling update does not notify nested child subscriber')
    })

    test(`${label}: whole-branch replacement preserves captured subscriptions`, () => {
        const drain = createManualDrain()
        const s = reactive<any>({branch: {leaf: {value: 1}, other: 1}}, drain.opts)
        const branch = s.branch
        const leaf = s.branch.leaf
        let branchHits = 0, leafHits = 0
        onUpdate(branch, () => branchHits++)
        onUpdate(leaf, () => leafHits++)

        s.branch = {leaf: {value: 2}, other: 9}
        drain.flushAll()
        assertEq(branch.valueOf(), branch, 'captured branch proxy remains usable')
        assertEq(branch.leaf.value, 2, 'captured branch reads replacement target')
        assertEq(leaf.value, 2, 'captured leaf reads replacement target')
        assertDeepEq({branchHits, leafHits}, {branchHits: 1, leafHits: 1}, 'replacement notifies existing branch and leaf watchers')

        leaf.value = 3
        drain.flushAll()
        assertEq(s.branch.leaf.value, 3, 'captured leaf writes through to replacement branch')
        assertDeepEq({branchHits, leafHits}, {branchHits: 2, leafHits: 2}, 'post-replacement deep write still bubbles')
    })

    test(`${label}: delete detaches captured child proxies`, () => {
        const drain = createManualDrain()
        const manual = reactive<any>({child: {x: 1}}, drain.opts)
        const oldChild = manual.child
        let rootHits = 0, childHits = 0
        onUpdate(manual, () => rootHits++)
        onUpdate(oldChild, () => childHits++)

        delete manual.child
        drain.flushAll()
        assertDeepEq({rootHits, childHits, hasChild: 'child' in manual}, {rootHits: 1, childHits: 1, hasChild: false}, 'delete notifies live root and deleted child once')

        oldChild.x = 2
        drain.flushAll()
        assertDeepEq({rootHits, childHits}, {rootHits: 1, childHits: 1}, 'mutating detached child no longer bubbles')
        assertThrows(() => onUpdate(oldChild, () => {}), /detached/, 'new subscription to detached proxy is rejected after delete')
    })

    test(`${label}: defineProperty handles configurable and non-configurable descriptors`, () => {
        const drain = createManualDrain()
        const s = reactive<any>({}, drain.opts)
        let hits = 0
        onUpdate(s, () => hits++)

        Object.defineProperty(s, 'open', {value: {x: 1}, enumerable: true, configurable: true, writable: true})
        const open = s.open
        drain.flushAll()
        assertEq(hits, 1, 'configurable defineProperty notifies once')
        assertEq(open.x, 1, 'configurable object property is reactive on read')

        Object.defineProperty(s, 'open', {value: {x: 2}, enumerable: true, configurable: true, writable: true})
        drain.flushAll()
        assertEq(open.x, 2, 'configurable descriptor replacement rebinds captured child')

        Object.defineProperty(s, 'fixed', {value: 7, enumerable: true, configurable: false, writable: false})
        drain.flushAll()
        assertEq(hits, 3, 'non-configurable defineProperty notifies once')
        assertDeepEq(Object.keys(s).sort(), ['fixed', 'open'], 'non-configurable key remains enumerable through proxy invariants')
        assertThrows(function rejectFixedWrite() {
            'use strict'
            s.fixed = 8
        }, /read only|trap returned falsish|Cannot assign/i, 'non-writable non-configurable property rejects writes')
        drain.flushAll()
        assertEq(s.fixed, 7, 'failed non-configurable write leaves value unchanged')
        assertEq(hits, 3, 'failed non-configurable write does not notify')
    })

    test(`${label}: arrays are reactive containers and survive replacement`, () => {
        const drain = createManualDrain()
        const s = reactive<any>({items: [{v: 1}]}, drain.opts)
        const arr = s.items
        const first = s.items[0]
        let rootHits = 0, arrHits = 0, firstHits = 0
        onUpdate(s, () => rootHits++)
        onUpdate(arr, () => arrHits++)
        onUpdate(first, () => firstHits++)

        s.items[0].v = 2
        s.items.push({v: 3})
        drain.flushAll()
        assertDeepEq({rootHits, arrHits, firstHits}, {rootHits: 1, arrHits: 1, firstHits: 1}, 'index write and push coalesce')
        assert(Array.isArray(s.items), 'wrapped array passes Array.isArray')
        assertEq(JSON.stringify(s.items), '[{"v":2},{"v":3}]', 'wrapped array serializes as an array')

        s.items = [{v: 4}]
        drain.flushAll()
        assertEq(arr[0].v, 4, 'captured array proxy follows replacement')
        assertEq(first.v, 4, 'captured array element proxy follows replacement element')
    })

    test(`${label}: listenUpdate is cold until first listener and cold again after last off`, () => {
        const drain = createManualDrain()
        const s = reactive<any>({node: {x: 1}}, drain.opts)
        const updates = listenUpdate(s.node)
        let hits = 0

        s.node.x = 2
        assertEq(drain.pending, 0, 'listenUpdate without downstream listeners does not schedule')

        const off = updates.on(() => hits++)
        s.node.x = 3
        assertEq(drain.pending, 1, 'first listener makes listenUpdate hot')
        drain.flushAll()
        assertEq(hits, 1, 'hot listenUpdate emits update')

        off()
        drain.clear()
        s.node.x = 4
        assertEq(drain.pending, 0, 'last off makes listenUpdate cold again')
        drain.flushAll()
        assertEq(hits, 1, 'cold listenUpdate no longer emits')
    })

    test(`${label}: duplicate onUpdate callbacks are independent subscriptions`, () => {
        const drain = createManualDrain()
        const s = reactive({x: 0}, drain.opts)
        let hits = 0
        const cb = () => hits++
        const off1 = onUpdate(s, cb)
        const off2 = onUpdate(s, cb)

        off1()
        s.x = 1
        drain.flushAll()
        assertEq(hits, 1, 'second duplicate subscription remains after first off')

        off2()
        s.x = 2
        drain.flushAll()
        assertEq(hits, 1, 'second off removes remaining duplicate subscription')
    })

    test(`${label}: flushReactive waits for batching and follow-up drains`, async () => {
        const drain = createManualDrain()
        const s = reactive({x: 0}, drain.opts)
        let hits = 0
        let resolved = false
        onUpdate(s, () => {
            hits++
            if (hits === 1) s.x = 2
        })

        s.x = 1
        const done = flushReactive(s).then(() => { resolved = true })
        assertEq(hits, 0, 'callbacks do not run synchronously')
        drain.flushOne()
        assertEq(resolved, false, 'flushReactive waits for callback-triggered follow-up drain')
        drain.flushAll()
        await done
        assertDeepEq({hits, value: s.x, resolved}, {hits: 2, value: 2, resolved: true}, 'flushReactive resolves after settled state')
    })

    test(`${label}: subscriber errors are isolated and rethrown asynchronously`, async () => {
        const drain = createManualDrain()
        const s = reactive({x: 0}, drain.opts)
        let siblingHits = 0
        let uncaught: any = null
        const onUncaught = (e: any) => { uncaught = e }
        process.once('uncaughtException', onUncaught)

        onUpdate(s, () => { throw new Error(`${label} boom`) })
        onUpdate(s, () => siblingHits++)
        s.x = 1
        const done = flushReactive(s)
        drain.flushAll()
        await done
        await tick()
        process.removeListener('uncaughtException', onUncaught)

        assertEq(siblingHits, 1, 'sibling subscriber still runs after another subscriber throws')
        assertEq(uncaught?.message, `${label} boom`, 'subscriber error is rethrown asynchronously')
    })
}

addCoreSuite('src/Common/Observe/reactive', srcApi)
addCoreSuite('observe/reactive', observeApi)

async function main() {
    for (const t of tests) {
        try {
            await t.run()
            console.log(`OK ${t.name}`)
        } catch (e: any) {
            failures++
            console.error(`FAIL ${t.name}`)
            console.error(e?.stack ?? e)
        }
    }
    console.log(failures === 0 ? `ALL GREEN (${tests.length})` : `${failures} FAILURE(S) / ${tests.length}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
    console.error(e?.stack ?? e)
    process.exit(1)
})
