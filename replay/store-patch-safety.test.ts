// =====================================================================
// Store patch trust-boundary safety oracle
// =====================================================================

import {
    applyStorePatch, applyStorePatches, createStore, exposeStore, StorePatch,
} from '../src/Common/Observe/store'
import {syncStoreReplay} from '../src/Common/Observe/store-replay'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function json(value: any) {
    return JSON.stringify(value)
}

async function main() {
    console.log('\n[store-patch-safety] validate before mutation')
    const store = createStore<Record<string, any>>({})
    const invalid: StorePatch = {
        path: ['A', {} as any],
        exists: true,
        value: 'YES',
    }
    let rejected = false
    try {
        applyStorePatches(store, [
            {path: ['SAFE'], exists: true, value: 1},
            invalid,
        ])
    } catch {
        rejected = true
    }
    ok(rejected, 'an envelope with a non-property path key is rejected')
    ok(json(store.snapshot()) == '{}', 'the complete invalid envelope is rejected before mutation')

    const sparseEnvelope = Array(2) as StorePatch[]
    sparseEnvelope[0] = {path: ['SAFE'], exists: true, value: 1}
    let sparseEnvelopeRejected = false
    try { applyStorePatches(store, sparseEnvelope) }
    catch { sparseEnvelopeRejected = true }
    ok(sparseEnvelopeRejected && json(store.snapshot()) == '{}',
        'a sparse envelope is rejected completely before its valid prefix can mutate Store')

    const sparsePath = Array(2) as PropertyKey[]
    sparsePath[1] = 'value'
    let sparsePathRejected = false
    try { applyStorePatch(store, {path: sparsePath, exists: true, value: 1}) }
    catch { sparsePathRejected = true }
    ok(sparsePathRejected && json(store.snapshot()) == '{}',
        'a sparse path is rejected instead of coercing its hole into an undefined key')

    applyStorePatch(store, {path: ['DICT', '__proto__', 'localOnly'], exists: true, value: 1})
    const dictionary = store.snapshot() as any
    ok(Object.prototype.hasOwnProperty.call(dictionary.DICT, '__proto__')
        && dictionary.DICT.__proto__.localOnly == 1 && ({} as any).localOnly == undefined,
    'prototype-sensitive data keys are stored as own properties without prototype mutation')

    const root = JSON.parse('{"__proto__":{"localOnly":1},"safe":2}')
    applyStorePatch(store, {path: [], exists: true, value: root})
    const raw = store.snapshot() as any
    ok(Object.prototype.hasOwnProperty.call(raw, '__proto__') && raw.safe == 2
        && ({} as any).localOnly == undefined,
    'root data keeps an own reserved-looking field without changing its prototype')

    const exposed = exposeStore(store)
    exposed.set(['__proto__', 'remoteValue'], true)
    const exposedSnapshot = store.snapshot() as any
    ok(exposedSnapshot.__proto__.remoteValue == true && ({} as any).remoteValue == undefined,
        'the regular exposed Store path keeps reserved business keys safe and compatible')

    console.log('\n[store-patch-safety] binary values clone without deprecated Buffer construction')
    const sourceBuffer = Buffer.from([1, 2, 3])
    const binaryStore = createStore<{bytes: Buffer}>({bytes: Buffer.alloc(0)})
    applyStorePatch(binaryStore, {path: ['bytes'], exists: true, value: sourceBuffer})
    const clonedBuffer = binaryStore.snapshot().bytes
    sourceBuffer[0] = 9
    ok(Buffer.isBuffer(clonedBuffer) && clonedBuffer[0] == 1 && clonedBuffer !== sourceBuffer,
        'Buffer keeps its type and detached bytes at the Store ownership boundary')

    console.log('\n[store-patch-safety] failed materialization keeps replay seq honest')
    const mirror = createStore<Record<string, any>>({})
    let failure: unknown = null
    const remote = {
        line: {on() { return function offLine() {} }},
        since() { return [{seq: 1, ts: 1, event: [invalid] as [StorePatch]}] },
        keyframe() { return null },
    }
    const sync = syncStoreReplay(mirror, remote, {
        since: 0,
        catchUp: 'tail',
        gapPolicy: 'error',
        onError(error) { failure = error },
    })
    await sync.ready

    ok(failure instanceof Error, 'materialization failure is reported through replay onError')
    ok(sync.seq() == 0 && json(mirror.snapshot()) == '{}',
        'failed callback does not advance seq or partially mutate the mirror')

    sync()
    console.log(fails ? `\n${fails} failed` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function storePatchSafetyFailed(error) {
    console.error(error)
    process.exit(1)
})
