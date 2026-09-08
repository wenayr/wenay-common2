import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {createStore} from '../src/Common/Observe/store'
import {createMemoryOfflineStorage, createOfflineStore} from '../src/Common/Observe/store-offline'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'

test('offline freshness status works without a caller onStale callback', async function offlineFreshness() {
    const source = createStore({value: 1})
    const exposed = exposeStoreReplay(source)
    const offline = await createOfflineStore({
        key: 'freshness', storage: createMemoryOfflineStorage(), initial: {value: 0},
        remote: exposed.api.replay, syncOpts: {staleMs: 10},
    })
    try {
        await offline.ready
        await delay(40)
        assert.equal(offline.status().stale, true)
        source.node.value.set(2)
        await delay(0)
        assert.equal(offline.status().stale, false)
        assert.equal(offline.state.value, 2)
    } finally {
        offline.close()
        exposed.close()
    }
})
