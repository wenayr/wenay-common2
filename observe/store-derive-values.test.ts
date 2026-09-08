import assert from 'node:assert/strict'
import {storeDiffPatches, deriveStore} from '../src/Common/Observe/store-derive'
import {createStore} from '../src/Common/Observe/store'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'

async function until(check: () => boolean) {
    const deadline = Date.now() + 3000
    while (!check()) {
        assert(Date.now() < deadline, 'projection/follower did not receive the exact value')
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

async function main() {
    // Device adapters may report a number, a switch state, or an unavailable reading.
    const transitions = [[0, false], [false, 0], [0, '0'], ['0', 0], [null, undefined], [0, -0]] as const
    for (const [before, after] of transitions) {
        const patches = storeDiffPatches({reading: before}, {reading: after})
        assert.equal(patches.length, 1, `${String(before)} → ${String(after)} must emit a patch`)
        assert.deepEqual(patches[0].path, ['reading'])
        assert(Object.is(patches[0].value, after))
    }
    assert.equal(storeDiffPatches({reading: NaN}, {reading: NaN}).length, 0)
    assert.equal(storeDiffPatches({list: [0]}, {list: [-0]}).length, 1)
    assert.equal(storeDiffPatches({data: new Map([['reading', 0]])}, {data: new Map([['reading', false]])}).length, 1)
    assert.equal(storeDiffPatches({list: [NaN]}, {list: [NaN]}).length, 0)

    const source = createStore<{reading: number | boolean | string | null}>({reading: 0})
    const projection = deriveStore(source, state => ({reading: state.reading}), {keys: ['reading']})
    const line = exposeStoreReplay(projection.store)
    const follower = createStoreFollower({remote: line.api.replay})
    try {
        await until(() => follower.status.state.upstream == 'live')
        for (const reading of [false, 0, '0', null, 0] as const) {
            source.state.reading = reading
            await until(() => Object.is(projection.store.state.reading, reading))
            await until(() => Object.is(follower.store.state.reading, reading))
        }
    } finally {
        follower.close()
        line.close()
        projection.close()
    }
    console.log('PASS exact telemetry values through diff, projection and replay follower')
}

main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
