// ============================================================
// Raw Store mirror initial handoff: subscribe before slow get().
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {createStore, createStoreMirror, exposeStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

type State = {row: {value: number}}

function delayFirstGet(api: ReturnType<typeof exposeStore<State>>) {
    let release = function releaseNotReady() { throw new Error('get was not started') }
    let calls = 0
    return {
        remote: {
            ...api,
            get(mask?: any) {
                const snapshot = api.get(mask)
                if (calls++ > 0) return snapshot
                return new Promise<State>(function waitForRelease(resolve) {
                    release = function releaseInitialGet() { resolve(snapshot as State) }
                })
            },
        },
        release: () => release(),
    }
}

async function settle(...stores: {state: object}[]) {
    for (const store of stores) await flushReactive(store.state)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const store of stores) await flushReactive(store.state)
}

async function runMode(mode: 'pull' | 'patches' | 'changedData') {
    const source = createStore<State>({row: {value: 0}}, {drain: 'micro'})
    const api = exposeStore(source, {push: true})
    const delayed = delayFirstGet(api)
    const mirror = createStoreMirror<State>(delayed.remote, {row: {value: -1}}, {drain: 'micro'})
    const pending = mode == 'pull'
        ? mirror.sync(true)
        : mode == 'patches'
            ? mirror.syncPatches(true)
            : mirror.syncChangedData(true)

    source.state.row = {value: 1}
    await flushReactive(source.state)
    delayed.release()
    const off = await pending
    await settle(source, mirror)

    const converged = isDeepStrictEqual(mirror.snapshot(), source.snapshot())
    off()
    return converged
}

async function main() {
    console.log('\n[store-mirror-race] changes during initial get are not lost')
    ok(await runMode('pull'), 'changed/changedPaths queues a follow-up pull')
    ok(await runMode('patches'), 'patchesBatch buffers absolutes until the snapshot lands')
    ok(await runMode('changedData'), 'changedData buffers data until the snapshot lands')

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
