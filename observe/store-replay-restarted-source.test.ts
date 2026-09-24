import assert from 'node:assert/strict'
import {createStore} from '../src/Common/Observe/store'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {createTransportLifecycle, RPC_TRANSPORT_LIFECYCLE} from '../src/Common/events/transport-lifecycle'
import {runOracle} from '../oracle/run-oracle'

async function checkCatchUp(reset: boolean) {
    const lifecycle = createTransportLifecycle(true)
    let source = exposeStoreReplay(createStore({reading: 'before restart'}), {firstSeq: 20})
    const remote = {
        line: {on: function subscribe(cb: Parameters<typeof source.api.replay.line.on>[0]) {
            return source.api.replay.line.on(cb)
        }},
        since: function since(seq: number) { return source.api.replay.since(seq) },
        keyframe: function keyframe() { return source.api.replay.keyframe() },
    }
    Object.defineProperty(remote, RPC_TRANSPORT_LIFECYCLE, {value: lifecycle.api})
    const mirror = createStore({reading: ''})
    let live = 0
    const sync = syncStoreReplay(mirror, remote, {
        prepareCatchUp: reset ? function resetServingLifetime() { return {reset: true} } : undefined,
        onLive: function caughtUp() { live++ },
    })
    try {
        await sync.ready
        assert.equal(mirror.state.reading, 'before restart')
        assert.equal(sync.seq(), 20)
        lifecycle.control.disconnect('serving process restarted')
        source.close()
        source = exposeStoreReplay(createStore({reading: 'after restart'}))
        lifecycle.control.connect()
        for (let attempt = 0; live < 2 && attempt < 100; attempt++) {
            await new Promise<void>(function nextTurn(resolve) { setTimeout(resolve, 1) })
        }
        assert.equal(live, 2, 'reconnect catch-up completed')
        if (reset) {
            assert.equal(mirror.state.reading, 'after restart', 'explicit reset installs a fresh lower-sequence snapshot')
            assert.equal(sync.seq(), 0)
        } else {
            assert.equal(mirror.state.reading, 'before restart', 'ordinary resume remains anchored to its previous sequence lifetime')
            assert.equal(sync.seq(), 20)
        }
    } finally {
        sync()
        source.close()
        lifecycle.control.close('test done')
    }
}

async function main() {
    // This isolates catch-up coordinates; real RPC owns subscription replacement after reconnect.
    await checkCatchUp(false)
    await checkCatchUp(true)
    console.log('PASS restarted store source: anchored resume rejects a lower head; explicit reset accepts its snapshot')
}

runOracle(main)
