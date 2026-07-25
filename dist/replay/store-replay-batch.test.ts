// ============================================================
// Store Replay V2 batch contract
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStore, type StorePatch} from '../src/Common/Observe/store'
import {
    exposeStoreReplay,
    type StoreReplayRemote,
    syncStoreReplay,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatchV2,
    decodeStoreReplayPatchV2,
    encodeStoreReplayBatchV2,
    encodeStoreReplayPatchV2,
} from '../src/Common/Observe/store-replay-codec'

let failures = 0

function ok(condition: unknown, message: string) {
    if (condition) console.log('  OK  ', message)
    else {
        failures++
        console.log('  FAIL', message)
    }
}

async function main() {
    console.log('\n[store-replay-v2] patch tuples')
    const patches: StorePatch[] = [
        {path: ['BTC'], exists: true, value: {c: 1}},
        {path: ['BTC'], exists: false, value: undefined},
        {path: ['BTC', 'c'], exists: true, value: 2},
        {path: ['BTC', 'c'], exists: false, value: undefined},
        {path: [], exists: true, value: {BTC: {c: 3}}},
        {path: [], exists: false, value: undefined},
        {path: ['UNDEF'], exists: true, value: undefined},
    ]
    for (const patch of patches) {
        const decoded = decodeStoreReplayPatchV2(encodeStoreReplayPatchV2(patch))
        ok(isDeepStrictEqual(decoded, patch), 'round-trips ' + JSON.stringify(patch.path))
    }

    const explicitUndefined = encodeStoreReplayBatchV2({
        seq: 7,
        ts: 8,
        event: [[{path: ['UNDEF'], exists: true, value: undefined}]],
    })
    const jsonWire = JSON.parse(JSON.stringify(explicitUndefined))
    const decodedUndefined = decodeStoreReplayBatchV2(jsonWire).event[0][0]
    ok(decodedUndefined.exists && decodedUndefined.value === undefined,
        'preserves an explicit undefined patch through JSON')

    console.log('\n[store-replay-v2] direct facade and mirror')
    type Quotes = Record<string, {c: number, t: number}>
    const source = createStore<Quotes>({}, {drain: 'micro'})
    const exposed = exposeStoreReplay(source, {
        history: 32,
        maxItems: 2,
        maxBytes: 64 * 1024,
    })
    const remote = exposed.api.replay as StoreReplayRemote
    const versionKeys = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']
        .filter(key => Object.prototype.hasOwnProperty.call(remote, key))
    ok(versionKeys.length == 0, 'exposes one direct V2 batch facade without generation members')

    const live: ReturnType<typeof encodeStoreReplayBatchV2>[] = []
    const offLive = remote.line.on(function collectV2Batch(wire) { live.push(wire) })
    const mirror = createStore<Quotes>({}, {drain: 'micro'})
    const sync = syncStoreReplay(mirror, remote)
    await sync.ready

    for (let index = 0; index < 5; index++) {
        source.state['Q' + index] = {c: index, t: index + 10}
    }
    await flushReactive(source.state)
    await flushReactive(mirror.state)

    ok(live.length == 3 && live.every(wire => wire[0] == 2),
        'maxItems splits one drain into V2 envelopes only')
    ok(live.map(wire => wire[3].length).join(',') == '2,2,1',
        'split envelopes preserve the configured item bound')
    ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
        'V2 mirror converges to the source')

    const since = sync.seq()
    source.state.Q2 = {c: 22, t: 22}
    delete source.state.Q4
    await flushReactive(source.state)
    await flushReactive(mirror.state)
    ok(sync.seq() > since && isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
        'V2 live update and delete advance seq and converge')

    let malformedRejected = false
    try {
        decodeStoreReplayBatchV2([3, 1, 2, []])
    } catch {
        malformedRejected = true
    }
    ok(malformedRejected, 'rejects a non-V2 envelope')

    sync()
    offLive()
    exposed.close()
    console.log(failures == 0 ? '\nStore Replay V2 tests: OK' : `\nStore Replay V2 tests: ${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}

main().catch(function fail(error) {
    console.error(error)
    process.exit(1)
})
