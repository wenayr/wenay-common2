// ============================================================
// Store Replay batch propagation: cascade, route, offline coords, durability.
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    exposeStoreReplay, StoreReplayRemote, syncStoreReplay, syncStoreReplayRoute,
} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createOfflineStore, createMemoryOfflineStorage} from '../src/Common/Observe/store-offline'
import {createDurableStoreReplay} from '../src/Common/Observe/store-durable'
import {createStoreReplicaOffers, createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {createMemoryReplayStorage, ReplayStorage} from '../src/Common/events/replay-history'
import {ReplayEvent} from '../src/Common/events/replay-listen'
import {openFsReplayStorage} from '../src/server/fsReplayStorage'

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

function instrumentStorage(withBulk: boolean) {
    const mem = createMemoryReplayStorage<[StorePatch]>()
    let singles = 0
    let bulks = 0
    const sizes: number[] = []
    const storage: ReplayStorage<[StorePatch]> = {
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
    console.log('\n[store-replay-branches] leader -> follower -> client stays batched')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const head = exposeStoreReplay(source, {batch: true})
        const follower = createStoreFollower<State>({remote: head.api.replay as StoreReplayRemote, initial: {}})
        await follower.ready
        const mirror = createStore<State>({}, {drain: 'micro'})
        const sub = syncStoreReplay(mirror, follower.api.replay as StoreReplayRemote, {batch: true})
        await sub.ready
        const downstreamSizes: number[] = []
        const offBatch = (follower.api.replay as StoreReplayRemote).batch!.line.on(function countDownstream(wire) {
            downstreamSizes.push(wire[3].length)
        })

        for (let i = 0; i < 24; i++) source.state['K' + i] = {value: i}
        await settle(source, follower.store, mirror)

        ok(follower.status.state.seq == 1, 'follower consumes one upstream batch coordinate')
        ok(downstreamSizes.length == 1 && downstreamSizes[0] == 24,
            `cascade emits one downstream envelope (${downstreamSizes.join(',')})`)
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'two-hop batch cascade converges')
        offBatch()
        sub()
        follower.close()
        head.close()
    }

    console.log('\n[store-replay-branches] route pins one coordinate space')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const head = exposeStoreReplay(source, {batch: true})
        const oldSource = createStore<State>({OLD: {value: -1}}, {drain: 'micro'})
        const old = exposeStoreReplay(oldSource)
        const mirror = createStore<State>({}, {drain: 'micro'})
        const route = syncStoreReplayRoute(mirror, head.api.replay as StoreReplayRemote, {batch: true})
        await route.ready
        source.state.A = {value: 1}
        await settle(source, mirror)
        await route.switch(head.api.replay as StoreReplayRemote, {label: 'same-batch-line'})
        source.state.B = {value: 2}
        await settle(source, mirror)
        let rejected = false
        try { await route.switch(old.api.replay as StoreReplayRemote) }
        catch { rejected = true }
        source.state.C = {value: 3}
        await settle(source, mirror)

        ok(route.mode == 'batch', 'new/new route selects batch once')
        ok(rejected, 'batch route rejects an unsafe switch into legacy coordinates')
        ok(isDeepStrictEqual(mirror.snapshot(), source.snapshot()), 'rejected switch leaves the active route healthy')

        const legacyMirror = createStore<State>({}, {drain: 'micro'})
        const legacyRoute = syncStoreReplayRoute(legacyMirror, old.api.replay as StoreReplayRemote, {batch: true})
        await legacyRoute.ready
        oldSource.state.NEXT = {value: 2}
        await settle(oldSource, legacyMirror)
        ok(legacyRoute.mode == 'legacy' && isDeepStrictEqual(legacyMirror.snapshot(), oldSource.snapshot()),
            'new route client falls back against an old server')
        legacyRoute()
        route()
        old.close()
        head.close()
    }

    console.log('\n[store-replay-branches] route validation fails before mutation and seq commit')
    {
        const source = createStore<State>({}, {drain: 'micro'})
        const head = exposeStoreReplay(source, {batch: true})
        const mirror = createStore<State>({}, {drain: 'micro'})
        const errors: unknown[] = []
        const route = syncStoreReplayRoute(mirror, head.api.replay as StoreReplayRemote, {
            batch: true,
            validateBatch(patches) {
                if (patches.some(patch => patch.path[0] == 'BAD')) throw new Error('route patch rejected')
            },
            onError(error) { errors.push(error) },
        })
        await route.ready
        const seq = route.seq()
        source.state.BAD = {value: 1}
        await settle(source)
        ok(errors.length == 1 && route.seq() == seq && !(mirror.state as any).BAD && !route.active(),
            'route callback failure closes the route without applying or acknowledging the rejected envelope')
        route()
        head.close()
    }

    console.log('\n[store-replay-branches] offline cache resets seq when fallback mode changes')
    {
        const cache = createMemoryOfflineStorage({
            quote: {version: 1, seq: 7, replayMode: 'batch', snapshot: {STALE: {value: 7}}, savedAt: 1},
        })
        const source = createStore<State>({FRESH: {value: 8}})
        const oldHead = exposeStoreReplay(source)
        const offline = await createOfflineStore<State>({
            key: 'quote', storage: cache, initial: {}, remote: oldHead.api.replay as StoreReplayRemote, debounceMs: 0,
        })
        await offline.ready
        await settle(offline)
        await offline.flush()
        const saved = cache.dump().quote as any

        ok(isDeepStrictEqual(offline.snapshot(), source.snapshot()), 'batch cache -> legacy server takes a fresh keyframe')
        ok(saved.replayMode == 'legacy', 'cache persists the selected coordinate mode')
        offline.close()
        oldHead.close()
    }

    console.log('\n[store-replay-branches] replica routes stay on canonical coordinates by default')
    {
        const leader = createStoreReplicaSet<State>({
            storeId: 'batch-safe', originId: 'batch-safe', nodeId: 'leader', lineId: 'leader-line',
            initial: {A: {value: 1}}, leadership: {initialRole: 'leader', epoch: 1},
        })
        const replay = leader.api.fragment.replay as StoreReplayRemote
        let legacySubscriptions = 0
        let batchSubscriptions = 0
        const observedReplay: StoreReplayRemote = {
            ...replay,
            line: {
                on(cb) {
                    legacySubscriptions++
                    return replay.line.on(cb)
                },
            },
            batch: {
                ...replay.batch!,
                line: {
                    on(cb) {
                        batchSubscriptions++
                        return replay.batch!.line.on(cb)
                    },
                },
            },
        }
        const offers = createStoreReplicaOffers([{
            id: 'leader',
            connect() {
                return {remote: {...leader.api.fragment, replay: observedReplay}, close() {}}
            },
        }])
        const replica = createStoreReplicaSet<State>({
            storeId: 'batch-safe', originId: 'batch-safe', nodeId: 'replica', lineId: 'replica-line',
            initial: {}, offers: offers.api, leadership: {initialRole: 'follower', eligible: false},
        })
        await replica.api.ready

        ok(legacySubscriptions == 1 && batchSubscriptions == 0,
            'independent replica lines do not mix their batch seq spaces implicitly')
        ok(isDeepStrictEqual(replica.api.store.snapshot(), leader.api.store.snapshot()), 'safe default replica route converges')
        replica.close()
        leader.close()
    }

    console.log('\n[store-replay-branches] replica descriptor follows one Store drain')
    {
        const store = createStore<State>({}, {drain: 'micro'})
        const leader = createStoreReplicaSet<State>({
            storeId: 'descriptor-drain', originId: 'descriptor-drain',
            nodeId: 'leader', lineId: 'leader-line', store,
            leadership: {initialRole: 'leader', epoch: 1},
        })
        const descriptors: ReturnType<typeof leader.api.descriptor>[] = []
        const offChanged = leader.api.changed.on(function collectReplicaDescriptor(value) {
            descriptors.push(value)
        })

        for (let i = 0; i < 1000; i++) store.state['K' + i] = {value: i}
        await settle(store)

        const finalDescriptor = leader.api.descriptor()
        ok(descriptors.length == 1 && descriptors[0].headSeq == finalDescriptor.headSeq
            && descriptors[0].authoritySeq == finalDescriptor.authoritySeq,
        `one 1000-patch drain publishes one final replica descriptor (${descriptors.length})`)
        offChanged()
        leader.close()
    }

    console.log('\n[store-replay-branches] durable head commits each Store drain in bulk')
    {
        const bulk = instrumentStorage(true)
        const head = createDurableStoreReplay<State>({storage: bulk.storage, initial: {}, drain: 'micro'})
        for (let i = 0; i < 30; i++) head.store.state['D' + i] = {value: i}
        await settle(head.store)
        const counts = bulk.counts()
        ok(counts.bulks == 1 && counts.singles == 0 && counts.sizes[0] == 30,
            `bulk adapter receives one ordered write (${counts.sizes.join(',')})`)
        head.close()

        const fallback = instrumentStorage(false)
        const fallbackHead = createDurableStoreReplay<State>({storage: fallback.storage, initial: {}, drain: 'micro'})
        for (let i = 0; i < 5; i++) fallbackHead.store.state['F' + i] = {value: i}
        await settle(fallbackHead.store)
        ok(fallback.counts().singles == 5, 'legacy storage adapter keeps the per-event fallback')
        fallbackHead.close()
    }

    console.log('\n[store-replay-branches] durable batch restart starts at the persisted legacy boundary')
    {
        const archive = createMemoryReplayStorage<[StorePatch]>()
        const cache = createMemoryOfflineStorage()
        let head = createDurableStoreReplay<State>({storage: archive, initial: {}, drain: 'micro'})
        let offline = await createOfflineStore<State>({
            key: 'durable', storage: cache, initial: {}, remote: head.api.replay as StoreReplayRemote, debounceMs: 0,
        })
        await offline.ready
        head.store.state.A = {value: 1}
        await settle(head.store, offline)
        await offline.flush()
        const oldSeq = offline.status().seq
        offline.close()
        head.close()

        head = createDurableStoreReplay<State>({storage: archive, initial: {}, drain: 'micro'})
        head.store.state.B = {value: 2}
        await settle(head.store)
        offline = await createOfflineStore<State>({
            key: 'durable', storage: cache, initial: {}, remote: head.api.replay as StoreReplayRemote, debounceMs: 0,
        })
        await offline.ready
        await settle(offline)

        ok(offline.status().seq > oldSeq, 'restarted batch head advances beyond the persisted boundary')
        ok(isDeepStrictEqual(offline.snapshot(), head.store.snapshot()),
            'durable batch recovery uses a safe tail/keyframe across process lifetimes')
        offline.close()
        head.close()
    }

    console.log('\n[store-replay-branches] durable failure is invisible before head and fan-out')
    {
        const mem = createMemoryReplayStorage<[StorePatch]>()
        let scheduled: (() => void) | undefined
        let failBulk = true
        const storage: ReplayStorage<[StorePatch]> = {
            putEvent: mem.putEvent,
            putEvents(events) {
                if (failBulk) { failBulk = false; throw new Error('atomic bulk rejected') }
                mem.putEvents(events)
            },
            putKeyframe: mem.putKeyframe,
            getKeyframe: mem.getKeyframe,
            getEvents: mem.getEvents,
        }
        const head = createDurableStoreReplay<State>({
            storage,
            initial: {},
            everyEvents: 2,
            drain(flush) { scheduled = flush },
        })
        let published = 0
        const off = head.replay.line.on(function countPublished() { published++ })
        const before = head.replay.head()
        head.store.state.A = {value: 1}
        head.store.state.B = {value: 2}
        let surfaced = false
        function catchReactiveFailure() { surfaced = true }
        process.once('uncaughtException', catchReactiveFailure)
        scheduled!()
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        process.removeListener('uncaughtException', catchReactiveFailure)

        ok(surfaced, 'reactive drain surfaces the atomic storage failure')
        ok(head.replay.head() == before && published == 0,
            'failed precommit advances neither replay head nor fan-out')
        ok(mem.getEvents(0, Infinity).length == 0, 'failed atomic batch leaves no persisted prefix')

        head.retry()
        head.retry()
        const stored = mem.getEvents(0, Infinity)
        ok(head.replay.head() == before + 2 && published == 2 && stored.length == 2,
            'explicit retry persists and publishes every retained patch exactly once')
        ok(mem.getKeyframe()?.seq == before + 2, 'explicit retry also advances durable keyframe cadence')
        off()
        head.close()
    }

    console.log('\n[store-replay-branches] legacy durable retry keeps only the failed suffix')
    {
        const mem = createMemoryReplayStorage<[StorePatch]>()
        let scheduled: (() => void) | undefined
        let writes = 0
        let failSecond = true
        const storage: ReplayStorage<[StorePatch]> = {
            putEvent(event) {
                writes++
                if (failSecond && writes == 2) { failSecond = false; throw new Error('single write rejected') }
                mem.putEvent(event)
            },
            putKeyframe: mem.putKeyframe,
            getKeyframe: mem.getKeyframe,
            getEvents: mem.getEvents,
        }
        const head = createDurableStoreReplay<State>({
            storage,
            initial: {},
            drain(flush) { scheduled = flush },
        })
        const published: number[] = []
        head.replay.line.on(function countSafePrefix(event) { published.push(event.seq) })
        head.store.state.A = {value: 1}
        head.store.state.B = {value: 2}
        head.store.state.C = {value: 3}
        let surfaced = false
        function captureSingleWriteFailure() { surfaced = true }
        process.once('uncaughtException', captureSingleWriteFailure)
        scheduled!()
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        process.removeListener('uncaughtException', captureSingleWriteFailure)

        ok(surfaced && head.replay.head() == 1 && JSON.stringify(published) == JSON.stringify([1]),
            'legacy storage failure exposes only its already durable safe prefix')
        head.retry()
        head.retry()
        const seqs = mem.getEvents(0, Infinity).map(event => event.seq)
        ok(head.replay.head() == 3 && JSON.stringify(seqs) == JSON.stringify([1, 2, 3])
            && JSON.stringify(published) == JSON.stringify([1, 2, 3]),
            'legacy retry persists and publishes only the retained suffix without duplicates')
        head.close()
    }

    console.log('\n[store-replay-branches] fs index changes only after durable encoding/write')
    {
        const dir = mkdtempSync(join(tmpdir(), 'wenay-store-fs-failure-'))
        const file = join(dir, 'replay.jsonl')
        let rejectedType: 'e' | 'k' = 'e'
        try {
            const storage = openFsReplayStorage<[StorePatch]>(file, {
                codec: {
                    stringify(value) {
                        if (value.t == rejectedType) throw new Error('codec rejected ' + rejectedType)
                        return JSON.stringify(value)
                    },
                    parse: JSON.parse,
                },
            })
            const event: ReplayEvent<[StorePatch]> = {
                seq: 1, ts: 1, event: [{path: ['A'], exists: true, value: 1}],
            }
            let eventRejected = false
            try { storage.putEvents([event]) }
            catch { eventRejected = true }
            ok(eventRejected && storage.size().events == 0,
                'failed event encoding does not get ahead in the memory index')

            rejectedType = 'k'
            let keyframeRejected = false
            try { storage.putKeyframe(event) }
            catch { keyframeRejected = true }
            ok(keyframeRejected && storage.size().keyframes == 0,
                'failed keyframe encoding does not get ahead in the memory index')

            writeFileSync(file, JSON.stringify({t: 'e', v: event}) + '\n{"t":"b","v":[')
            const recovered = openFsReplayStorage<[StorePatch]>(file)
            const second = {...event, seq: 2, ts: 2}
            recovered.putEvent(second)
            const reopened = openFsReplayStorage<[StorePatch]>(file)
            ok(JSON.stringify(reopened.getEvents(0, Infinity).map(ev => ev.seq)) == JSON.stringify([1, 2]),
                'open truncates a torn trailing batch before the next append')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    }

    console.log('\n[store-replay-branches] fs bulk append remains restart-readable and ordered')
    {
        const dir = mkdtempSync(join(tmpdir(), 'wenay-store-bulk-'))
        const file = join(dir, 'replay.jsonl')
        try {
            const storage = openFsReplayStorage<[StorePatch]>(file)
            const events: ReplayEvent<[StorePatch]>[] = Array.from({length: 6}, function makeEvent(_, i) {
                return {seq: i + 1, ts: i + 10, event: [{path: ['K' + i], exists: true, value: i}]}
            })
            storage.putEvents(events)
            const reopened = openFsReplayStorage<[StorePatch]>(file)
            const seqs = reopened.getEvents(0, Infinity).map(ev => ev.seq)
            ok(JSON.stringify(seqs) == JSON.stringify([1, 2, 3, 4, 5, 6]), 'one bulk append reloads in exact seq order')
            ok(readFileSync(file, 'utf8').trim().split(/\r?\n/).length == 1,
                'bulk append is one atomic newline-delimited record')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
