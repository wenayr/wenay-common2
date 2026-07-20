// ============================================================
//  observe/node-health.test.ts
//
//  Node health aggregator: register(name, probe) → one reactive store,
//  refresh() resamples, a throwing probe records {error} without breaking
//  the rest, and the store mirrors through the ordinary replay wire —
//  monitoring of the replication IS replication.
//  Run: npx ts-node observe/node-health.test.ts
// ============================================================

import {createNodeHealth} from '../src/Common/Observe/node-health'
import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {ReplayRemote} from '../src/Common/events/replay-wire'
import {StorePatch} from '../src/Common/Observe/store'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const json = (v: any) => JSON.stringify(v)

async function main() {
    let t = 5000
    let seq = 7
    const health = createNodeHealth({node: 'n1', now: () => t})
    const offFollower = health.register('follower', () => ({seq, upstream: 'live'}))
    health.register('archiver', () => { throw new Error('probe boom') })

    ok(json(health.store.state.parts['follower']) == json({seq: 7, upstream: 'live'}), 'probe sampled at register')
    const broken = health.store.state.parts['archiver'] as any
    ok(typeof broken?.error == 'string' && broken.error.includes('probe boom'), 'throwing probe recorded as {error}')
    ok(json(health.store.state.parts['follower']) == json({seq: 7, upstream: 'live'}), 'other parts unaffected by the throwing probe')

    seq = 9; t = 6000
    health.refresh()
    ok((health.store.state.parts['follower'] as any)?.seq == 9, 'refresh resamples probes')
    ok(health.store.state.refreshedTs == 6000, 'refresh stamps refreshedTs')

    // mirrors through the ordinary wire — no special monitoring transport
    const exposed = exposeStoreReplay(health.store)
    const mirror = createStore<any>({}, {drain: 'micro'})
    const sub = syncStoreReplay(mirror, exposed.api.replay as unknown as ReplayRemote<[StorePatch]>)
    await sub.ready
    await tick()
    ok((mirror.snapshot() as any)?.parts?.follower?.seq == 9, 'health store mirrors through the replay wire')

    offFollower()
    await flushReactive(health.store.state); await tick()
    ok(!('follower' in health.store.state.parts), 'off removes the part')
    ok(!('follower' in ((mirror.snapshot() as any)?.parts ?? {})), 'removal reaches the mirror')

    sub()
    exposed.close()
    health.close()
    console.log(fails ? `node-health: ${fails} FAILED` : 'node-health: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
