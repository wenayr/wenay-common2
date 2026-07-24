// ============================================================
// Raw Store push: additive patchesBatch and legacy fallback.
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {createStore, createStoreMirror, exposeStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {rpcResultWireByteLength} from '../src/Common/rcp/rpc-wire-size'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

type State = Record<string, {value: number}>

async function settle(...stores: {state: object}[]) {
    for (const store of stores) await flushReactive(store.state)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const store of stores) await flushReactive(store.state)
}

async function main() {
    console.log('\n[store-patches-batch] new server serves old and new clients')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const api = exposeStore(source, {push: true})
        let legacyEvents = 0
        let batchEvents = 0
        let batchItems = 0
        const oldOff = api.patches.on(function oldClientPatch() { legacyEvents++ })
        const remote = {
            ...api,
            patches: {
                on(cb: (patch: StorePatch) => void) {
                    return api.patches.on(function countUnexpectedLegacy(patch: StorePatch) { cb(patch) })
                },
            },
            patchesBatch: {
                on(cb: (patches: readonly StorePatch[]) => void) {
                    return api.patchesBatch.on(function countBatch(patches: readonly StorePatch[]) {
                        batchEvents++
                        batchItems += patches.length
                        cb(patches)
                    })
                },
            },
        }
        const mirror = createStoreMirror<State>(remote, {}, {drain: 'micro'})
        const off = await mirror.syncPatches(true)

        for (let i = 0; i < 18; i++) source.state['K' + i] = {value: i}
        await settle(source, mirror)

        ok(legacyEvents == 18, `old client still receives the legacy line (${legacyEvents})`)
        ok(batchEvents == 1 && batchItems == 18, `new mirror receives one natural batch (${batchEvents}/${batchItems})`)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'batch mirror converges')
        off()
        oldOff()
    }

    console.log('\n[store-patches-batch] old server fallback stays lossless')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const api = exposeStore(source, {push: true})
        let legacyEvents = 0
        const oldRemote = {
            get: api.get,
            changed: api.changed,
            changedPaths: api.changedPaths,
            patches: {
                on(cb: (patch: StorePatch) => void) {
                    return api.patches.on(function countFallback(patch: StorePatch) {
                        legacyEvents++
                        cb(patch)
                    })
                },
            },
        }
        const mirror = createStoreMirror<State>(oldRemote, {}, {drain: 'micro'})
        const off = await mirror.syncPatches(true, {batch: true})
        for (let i = 0; i < 11; i++) source.state['L' + i] = {value: i}
        await settle(source, mirror)

        ok(legacyEvents == 11, `new mirror falls back to all legacy patches (${legacyEvents})`)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'legacy fallback converges')
        off()
    }

    console.log('\n[store-patches-batch] raw batch bounds use the packed RPC representation')
    {
        const source = createStore<any>({}, {drain: 'micro'})
        const api = exposeStore(source, {push: {maxItems: 10, maxBytes: 1_000_000}})
        const sizes: number[] = []
        const off = api.patchesBatch.on(function countBoundedItems(patches: readonly StorePatch[]) {
            sizes.push(patches.length)
        })
        for (let i = 0; i < 23; i++) source.state['I' + i] = {value: i}
        await settle(source)
        ok(JSON.stringify(sizes) == JSON.stringify([10, 10, 3]),
            `raw maxItems is a hard callback ceiling (${sizes.join(',')})`)
        off()

        const richSource = createStore<any>({}, {drain: 'micro'})
        const richApi = exposeStore(richSource, {push: {maxItems: 100, maxBytes: 800}})
        const bytes: number[] = []
        const richSizes: number[] = []
        const offRich = richApi.patchesBatch.on(function measurePackedBatch(patches: readonly StorePatch[]) {
            bytes.push(rpcResultWireByteLength(patches))
            richSizes.push(patches.length)
        })
        richSource.state.MAP1 = new Map(Array.from({length: 40}, (_, i) => ['K' + i, i]))
        richSource.state.MAP2 = new Map(Array.from({length: 40}, (_, i) => ['L' + i, i]))
        // 900 bytes is deliberately above the 800-byte envelope target even
        // after RPC keeps the value binary instead of expanding numeric keys.
        richSource.state.BIN1 = new Uint8Array(900)
        richSource.state.BIN2 = new Uint8Array(900)
        await settle(richSource)
        ok(bytes.length == 4 && richSizes.every(size => size == 1) && bytes.filter(size => size > 800).length == 2,
            `raw maxBytes isolates indivisible rich/binary oversize patches (${bytes.join(',')})`)
        offRich()

        const binaryPatches: StorePatch[] = Array.from({length: 256}, function makeBinaryPatch(_, index) {
            return {path: ['B' + index], exists: true, value: new Uint8Array([index & 255])}
        })
        const independentPatchLimit = 48 + binaryPatches.reduce(function sumIndependentPatchBytes(total, patch) {
            return total + rpcResultWireByteLength(patch) + 1
        }, 0)
        const binarySource = createStore<any>({}, {drain: 'micro'})
        const binaryApi = exposeStore(binarySource, {
            push: {maxItems: 256, maxBytes: independentPatchLimit},
        })
        const binaryBatchBytes: number[] = []
        const offBinary = binaryApi.patchesBatch.on(function measureBinaryBatch(patches: readonly StorePatch[]) {
            binaryBatchBytes.push(rpcResultWireByteLength(patches))
        })
        for (let index = 0; index < 256; index++) {
            binarySource.state['B' + index] = new Uint8Array([index & 255])
        }
        await settle(binarySource)
        ok(rpcResultWireByteLength(binaryPatches) > independentPatchLimit
            && binaryBatchBytes.length > 1 && binaryBatchBytes.every(size => size <= independentPatchLimit),
        'raw maxBytes counts growing binary placeholder indices across the complete batch')
        offBinary()
    }

    console.log('\n[store-patches-batch] legacy and batch consumers share one sampled drain')
    {
        const source = createStore<any>({}, {drain: 'micro'})
        const api = exposeStore(source, {push: true})
        const legacyValues: number[] = []
        const batchValues: number[] = []
        const offLegacy = api.patches.on(function mutateAfterLegacyRead(patch: StorePatch) {
            if (patch.path[0] != 'A') return
            legacyValues.push(patch.value)
            if (patch.value == 1) source.state.A = 2
        })
        const offBatch = api.patchesBatch.on(function readSameSample(patches: readonly StorePatch[]) {
            for (const patch of patches) if (patch.path[0] == 'A') batchValues.push(patch.value)
        })
        source.state.A = 1
        await settle(source)
        ok(JSON.stringify(legacyValues) == JSON.stringify([1, 2]), 'legacy sees both re-entrant values in order')
        ok(JSON.stringify(batchValues) == JSON.stringify([1, 2]), 'batch sees the exact same sampled values')
        offLegacy()
        offBatch()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
