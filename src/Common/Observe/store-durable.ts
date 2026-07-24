// =====================================================================
// Durable store head — a replay line that survives a process restart
// =====================================================================
// The persistence PORT is the existing ReplayStorage (replay-history): the head
// hydrates state from [keyframe + deltas], continues seq numbering from the
// persisted head (firstSeq), serves reconnecting mirrors' since() straight from
// the SAME storage (seamless journal past — no forced keyframe reset), and
// archives every new patch + cadence keyframes back into it.
// Leadership/epoch stay an upper-layer concern (follower/replica-set policies);
// this module owns exactly one property: the LINE survives the process.

import {createStore, StoreDrain, StorePatch, applyStorePatch, listenStorePatches} from './store'
import {exposeStoreReplay, StoreReplayOpts} from './store-replay'
import {openHistory, ReplayStorage} from '../events/replay-history'
import {ReplayEvent} from '../events/replay-listen'

export type DurableStoreReplayDeps<T extends object> = {
    /** Persistence port: memory reference impl, fs impl (wenay-common2/server), or your DB adapter. */
    storage: ReplayStorage<[StorePatch]>
    /** State when the archive is empty (first boot). */
    initial?: T
    /** Keyframe cadence: every N events (archiveReplay default 64). */
    everyEvents?: number
    /** ...or every T ms along the event ts line — whichever comes first. */
    everyMs?: number
    drain?: StoreDrain
    /** Line options passed through to exposeStoreReplay (describe/onJournal/now/batch).
     *  history/getSince/firstSeq are owned by the durable head itself. */
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now' | 'batch'>
}

export function createDurableStoreReplay<T extends object>(deps: DurableStoreReplayDeps<T>) {
    const {storage, everyEvents, everyMs, drain} = deps
    // === restore: [keyframe, ...deltas] → state + head coordinate of the previous lifetime ===
    const envelopes = openHistory(storage).at({})
    let restoredSeq = 0
    let state = (deps.initial ?? {}) as T
    if (envelopes) {
        const scratch = createStore<any>({})
        for (const ev of envelopes) applyStorePatch(scratch, ev.event[0])
        state = scratch.snapshot() as T
        restoredSeq = envelopes[envelopes.length - 1].seq
    }
    const store = createStore<T>(state, drain !== undefined ? {drain} : {})

    // === archive state ===
    const cadenceEvents = everyEvents ?? 64
    let events = 0
    let keyframes = 0
    let lastKfSeq = 0
    let lastKfTs = 0

    // === line: numbering continues; since() is served from the SAME storage ===
    let lineHead = () => restoredSeq
    const {batch: requestedBatch = true, onJournal: userOnJournal, ...exposeOpts} = deps.expose ?? {}
    const bulkPut = storage.putEvents
    function persistEvent(ev: ReplayEvent<[StorePatch]>) {
        userOnJournal?.(ev)
        storage.putEvent(ev)
        events++
    }
    function persistBatch(batch: readonly ReplayEvent<[StorePatch]>[]) {
        bulkPut!(batch)
        events += batch.length
    }
    // A batch contains at least one legacy patch, so its old head can never exceed
    // the persisted legacy head. Starting there makes an old coordinate either an
    // exact continuation boundary or an evicted/future value that resets by keyframe.
    const safeBatch = requestedBatch ? {
        ...(requestedBatch === true ? {} : requestedBatch),
        getSince: undefined,
        firstSeq: restoredSeq,
    } : false
    const exposed = exposeStoreReplay(store, {
        ...exposeOpts,
        batch: safeBatch,
        firstSeq: restoredSeq,
        onJournal: bulkPut ? userOnJournal : persistEvent,
        onJournalBatch: bulkPut ? persistBatch : undefined,
        getSince: function persistedSince(seq: number) {
            if (seq > lineHead()) return undefined           // foreign lifetime → keyframe reset
            if (seq == lineHead()) return []
            const tail = storage.getEvents(seq, Infinity)
            if (!tail.length || tail[0].seq != seq + 1) return undefined  // compacted/evicted → keyframe
            return tail
        },
    })
    lineHead = exposed.replay.head

    // === keyframes: only after the full drain was precommitted and published ===
    function takeKeyframe() {
        const kf = exposed.replay.keyframe()
        if (!kf) return
        storage.putKeyframe(kf)
        keyframes++
        lastKfSeq = kf.seq
        lastKfTs = kf.ts
    }
    function updateKeyframeCadence() {
        const head = exposed.replay.head()
        const ts = exposed.replay.lastTs()
        const due = head - lastKfSeq >= cadenceEvents || (everyMs != null && ts - lastKfTs >= everyMs)
        if (due) takeKeyframe()
    }
    try { takeKeyframe() }
    catch (error) {
        exposed.close()
        throw error
    }
    // exposeStoreReplay registered first on the shared sampled source. A storage
    // failure stops dispatch before cadence can write a keyframe for an uncommitted head.
    const offBurst = listenStorePatches(store).on(function finishDurableBurst() { updateKeyframeCadence() })
    function retry() {
        exposed.flushPending()
        updateKeyframeCadence()
    }
    const archive = {
        stats: () => ({events, keyframes}),
        close() {
            offBurst()
        },
    }
    return {
        /** The durable store — authority state; write here. */
        store,
        /** Wire facade (object: api) — same shape as exposeStoreReplay. */
        api: exposed.api,
        /** Local replay-line (head/getSince/keyframe). */
        replay: exposed.replay,
        /** What the boot found: head seq of the previous lifetime (0 = fresh archive). */
        restored: {seq: restoredSeq, fromArchive: !!envelopes},
        /** Archiver counters {events, keyframes} since this boot. */
        stats: archive.stats,
        /** Retry a Store drain retained after an atomic storage failure. */
        retry,
        close() { archive.close(); exposed.close() },
    }
}
export type DurableStoreReplay<T extends object> = ReturnType<typeof createDurableStoreReplay<T>>
