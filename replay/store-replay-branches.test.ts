// ============================================================
// Store Replay V2 propagation: cascade, route, offline and durability.
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreReplay, StoreReplayRemote, syncStoreReplay, syncStoreReplayRoute,
} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createOfflineStore, createMemoryOfflineStorage} from '../src/Common/Observe/store-offline'
import {createDurableStoreReplay} from '../src/Common/Observe/store-durable'
import {createMemoryReplayStorage, ReplayStorage} from '../src/Common/events/replay-history'
import {ReplayEvent} from '../src/Common/events/replay-listen'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

type State = Record<string, {value: number}>
type BatchEvent = ReplayEvent<[readonly StorePatch[]]>

async function settle(...stores: {state: object}[]) {
    for (const store of stores) await flushReactive(store.state)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const store of stores) await flushReactive(store.state)
}

function instrumentStorage(withBulk: boolean) {
    const mem = createMemoryReplayStorage<[readonly StorePatch[]]>()
    let singles = 0
    let bulks = 0
    const sizes: number[] = []
    const storage: ReplayStorage<[readonly StorePatch[]]> = {
        putEvent(ev) { singles++; mem.putEvent(ev) },
        putKeyframe: mem.putKeyframe,
        getKeyframe: mem.getKeyframe,
        getEvents: mem.getEvents,
    }
    if (withBulk) storage.putEvents = function putEvents(events) {
        bulks++
        sizes.push(events.length)
        mem.putEvents(events)
    }
    return {storage, counts: () => ({singles, bulks, sizes})}
}

async function main() {
    console.log('\n[store-replay-v2-branches] leader -> follower -> client')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const head = exposeStoreReplay(source)
        const follower = createStoreFollower<State>({remote: head.api.replay as StoreReplayRemote, initial: {}})
        await follower.ready
        const mirror = createStore<State>({}, {drain: 'micro'})
        const sub = syncStoreReplay(mirror, follower.api.replay as StoreReplayRemote)
        await sub.ready
        const downstreamSizes: number[] = []
        const offLine = (follower.api.replay as StoreReplayRemote).line.on(function countDownstream(wire) {
            downstreamSizes.push(wire[3].length)
        })

        for (let i = 0; i < 24; i++) source.state['K' + i] = {value: i}
        await settle(source, follower.store, mirror)

        ok(sub.mode == 'v2' && follower.status.state.replayMode == 'v2', 'all hops use V2 coordinates')
        ok(downstreamSizes.length == 1 && downstreamSizes[0] == 24,
            `cascade emits one V2 envelope (${downstreamSizes.join(',')})`)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'two-hop cascade converges')
        offLine()
        sub()
        follower.close()
        head.close()
    }

    console.log('\n[store-replay-v2-branches] route switch and validation')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const head = exposeStoreReplay(source)
        const mirror = createStore<State>({}, {drain: 'micro'})
        const errors: unknown[] = []
        const route = syncStoreReplayRoute(mirror, head.api.replay as StoreReplayRemote, {
            validateBatch(patches) {
                if (patches.some(patch => patch.path[0] == 'BAD')) throw new Error('route patch rejected')
            },
            onError(error) { errors.push(error) },
        })
        await route.ready
        await route.switch(head.api.replay as StoreReplayRemote, {label: 'same-v2-line'})
        source.state.A = {value: 1}
        await settle(source, mirror)
        ok(route.mode == 'v2' && isDeepStrictEqual(mirror.snapshot(), source.snapshot()),
            'route remains in the sole V2 coordinate space')

        const seq = route.seq()
        source.state.BAD = {value: 2}
        await settle(source)
        ok(errors.length == 1 && route.seq() == seq && !(mirror.state as any).BAD && !route.active(),
            'validation fails before mutation and acknowledgement')
        route()
        head.close()
    }

    console.log('\n[store-replay-v2-branches] offline cache rejects old coordinates')
    {
        const cache = createMemoryOfflineStorage({
            quote: {version: 1, seq: 7, replayMode: 'legacy', snapshot: {STALE: {value: 7}}, savedAt: 1},
        })
        const source = createStore<State>({FRESH: {value: 8}})
        const head = exposeStoreReplay(source)
        const offline = await createOfflineStore<State>({
            key: 'quote', storage: cache, initial: {}, remote: head.api.replay as StoreReplayRemote, debounceMs: 0,
        })
        await offline.ready
        await settle(offline)
        await offline.flush()
        const saved = cache.dump().quote as any

        ok(isDeepStrictEqual(offline.snapshot(), source.snapshot()), 'old coordinate resumes from a fresh V2 keyframe')
        ok(saved.replayMode == 'v2', 'cache persists only the V2 coordinate marker')
        offline.close()
        head.close()
    }

    console.log('\n[store-replay-v2-branches] durable head stores V2 envelopes')
    {
        const bulk = instrumentStorage(true)
        const head = createDurableStoreReplay<State>({storage: bulk.storage, initial: {}, drain: 'micro'})
        for (let i = 0; i < 30; i++) head.store.state['D' + i] = {value: i}
        await settle(head.store)
        const counts = bulk.counts()
        ok(counts.bulks == 1 && counts.singles == 0 && counts.sizes[0] == 1,
            `bulk adapter receives one V2 event (${counts.sizes.join(',')})`)
        head.close()

        const fallback = instrumentStorage(false)
        const fallbackHead = createDurableStoreReplay<State>({storage: fallback.storage, initial: {}, drain: 'micro'})
        for (let i = 0; i < 5; i++) fallbackHead.store.state['F' + i] = {value: i}
        await settle(fallbackHead.store)
        ok(fallback.counts().singles == 1, 'single-event storage adapter receives one V2 envelope')
        fallbackHead.close()
    }

    console.log('\n[store-replay-v2-branches] durable restart and retry')
    {
        const archive = createMemoryReplayStorage<[readonly StorePatch[]]>()
        let head = createDurableStoreReplay<State>({storage: archive, initial: {}, drain: 'micro'})
        head.store.state.A = {value: 1}
        await settle(head.store)
        const oldSeq = head.replay.head()
        head.close()

        head = createDurableStoreReplay<State>({storage: archive, initial: {}, drain: 'micro'})
        head.store.state.B = {value: 2}
        await settle(head.store)
        ok(head.replay.head() > oldSeq && isDeepStrictEqual(head.store.snapshot(), {
            A: {value: 1}, B: {value: 2},
        }), 'restart restores and advances the V2 journal')
        head.close()

        const mem = createMemoryReplayStorage<[readonly StorePatch[]]>()
        let scheduled: (() => void) | undefined
        let failBulk = true
        const storage: ReplayStorage<[readonly StorePatch[]]> = {
            putEvent: mem.putEvent,
            putEvents(events) {
                if (failBulk) { failBulk = false; throw new Error('atomic bulk rejected') }
                mem.putEvents(events)
            },
            putKeyframe: mem.putKeyframe,
            getKeyframe: mem.getKeyframe,
            getEvents: mem.getEvents,
        }
        const retryHead = createDurableStoreReplay<State>({
            storage,
            initial: {},
            drain(flush) { scheduled = flush },
        })
        let published = 0
        const off = retryHead.replay.line.on(function countPublished() { published++ })
        const before = retryHead.replay.head()
        retryHead.store.state.A = {value: 1}
        retryHead.store.state.B = {value: 2}
        let surfaced = false
        function catchReactiveFailure() { surfaced = true }
        process.once('uncaughtException', catchReactiveFailure)
        scheduled!()
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        process.removeListener('uncaughtException', catchReactiveFailure)

        ok(surfaced && retryHead.replay.head() == before && published == 0,
            'failed precommit advances neither V2 head nor fan-out')
        retryHead.retry()
        const stored: BatchEvent[] = mem.getEvents(0, Infinity)
        ok(retryHead.replay.head() == before + 1 && published == 1 && stored.length == 1
            && stored[0].event[0].length == 2,
        'retry publishes one retained V2 envelope exactly once')
        off()
        retryHead.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
