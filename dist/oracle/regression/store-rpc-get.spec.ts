import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createStore} from '../../src/Common/Observe/store'
import {exposeStoreReplay} from '../../src/Common/Observe/store-replay'
import {createRpcInProc} from '../../src/Common/rcp/rpc-inproc'

test('typed Store get projections match the existing RPC full/masked wire behavior', async function () {
    const store = createStore({user: {name: 'Ada', score: 3}, get: 7})
    const exposed = exposeStoreReplay(store)
    const client = createRpcInProc({object: exposed.api})
    try {
        await client.readyStrict()
        const full = await client.func.get()
        const score: number = full.user.score
        assert.equal(score, 3)
        assert.deepEqual(await client.func.get({user: {name: true}}), {user: {name: 'Ada'}})
        assert.deepEqual(await client.strict.get({user: {score: true}}), {user: {score: 3}})
        assert.deepEqual(await client.pipe.get({get: true}), {get: 7})
        store.node.at('get').set(8)
        assert.equal((await client.func.get()).get, 8)
        assert.equal(Object.getOwnPropertySymbols(exposed.api.get).length, 0, 'getter metadata is type-only')
    } finally {
        client.close()
        exposed.close()
    }
})
