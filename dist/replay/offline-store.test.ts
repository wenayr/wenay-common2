import {createOfflineStore, createMemoryOfflineStorage, OfflineStoreRecord} from '../src/Common/Observe/store-offline'
import {createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {ReplayRemote} from '../src/Common/events/replay-index'

type World = {
    units: Record<string, {hp: number}>
    tick: number
}

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (v: any) => JSON.stringify(v)

function makeRemote(exposed: ReturnType<typeof exposeStoreReplay<World>>, lag = 0) {
    const counters = {since: 0, keyframe: 0}
    const remote: ReplayRemote<[StorePatch]> = {
        line: exposed.replay.line,
        since: async (s: number) => {
            counters.since++
            await delay(lag)
            return exposed.replay.getSince(s) ?? null
        },
        keyframe: async () => {
            counters.keyframe++
            await delay(lag)
            return exposed.replay.keyframe() ?? null
        },
    }
    return {remote, counters}
}

async function readRecord(storage: ReturnType<typeof createMemoryOfflineStorage>, key: string) {
    return await storage.read<OfflineStoreRecord<World>>(key)
}

async function main() {
    console.log('\n[offline-store] cold start uses keyframe and persists snapshot + seq')
    {
        const backend = createStore<World>({units: {a: {hp: 10}}, tick: 1}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const {remote, counters} = makeRemote(exposed)
        const storage = createMemoryOfflineStorage()

        const offline = await createOfflineStore<World>({
            key: 'world',
            remote,
            initial: {units: {}, tick: -1},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        await offline.ready
        await offline.flush()

        const saved = await readRecord(storage, 'world')
        ok(json(offline.state) == json(backend.snapshot()), 'offline store converged to backend keyframe')
        ok(saved?.seq == 0 && json(saved.snapshot) == json(backend.snapshot()), 'persisted keyframe snapshot at seq 0')
        ok(counters.keyframe == 1 && counters.since == 0, 'empty cache starts from keyframe, not since-tail')
        offline.close()
        exposed.close()
    }

    console.log('\n[offline-store] starts from local cache without remote and reconnects by seq later')
    {
        const backend = createStore<World>({units: {a: {hp: 10}}, tick: 1}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 100})
        const {remote} = makeRemote(exposed)
        const storage = createMemoryOfflineStorage()

        const first = await createOfflineStore<World>({
            key: 'world',
            remote,
            initial: {units: {}, tick: -1},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        await first.ready
        await first.flush()
        const cachedSeq = first.status().seq
        first.close()

        backend.state.units.b = {hp: 20}
        await flushReactive(backend.state)
        backend.state.tick = 2
        await flushReactive(backend.state)

        const offlineOnly = await createOfflineStore<World>({
            key: 'world',
            initial: {units: {}, tick: -1},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        ok(json(offlineOnly.state) != json(backend.snapshot()) && offlineOnly.state.units.a.hp == 10,
            'no remote: UI sees cached store immediately')
        ok(offlineOnly.status().offline, 'no remote marks status offline')

        const {remote: remote2, counters: counters2} = makeRemote(exposed)
        await offlineOnly.reconnect(remote2)
        await offlineOnly.ready
        await offlineOnly.flush()

        const saved = await readRecord(storage, 'world')
        ok(json(offlineOnly.state) == json(backend.snapshot()), 'reconnect applies missed tail on top of cache')
        ok(counters2.since == 1 && counters2.keyframe == 0, 'reconnect uses saved seq instead of full keyframe')
        ok(saved!.seq > cachedSeq && json(saved!.snapshot) == json(backend.snapshot()), 'cache seq and snapshot advance after reconnect')
        offlineOnly.close()
        exposed.close()
    }

    console.log('\n[offline-store] evicted seq falls back to keyframe and persists new life')
    {
        const storage = createMemoryOfflineStorage({
            world: {
                version: 1,
                seq: 999,
                savedAt: 1,
                snapshot: {units: {old: {hp: 1}}, tick: -5},
            } satisfies OfflineStoreRecord<World>,
        })
        const backend = createStore<World>({units: {fresh: {hp: 100}}, tick: 5}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 1})
        const {remote, counters} = makeRemote(exposed)

        const offline = await createOfflineStore<World>({
            key: 'world',
            remote,
            initial: {units: {}, tick: -1},
            storage,
            debounceMs: 0,
            storeOpts: {drain: 'micro'},
        })
        ok(offline.state.units.old.hp == 1, 'cached old snapshot is visible before catch-up')
        await offline.ready
        await offline.flush()

        const saved = await readRecord(storage, 'world')
        ok(json(offline.state) == json(backend.snapshot()), 'future/evicted seq falls back to current keyframe')
        ok(counters.keyframe == 1, 'fallback requested one keyframe')
        ok(saved!.seq == 0 && saved!.snapshot.tick == 5, 'fallback cache overwrote old seq and data')
        offline.close()
        exposed.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
