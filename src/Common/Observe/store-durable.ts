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

import {createStore, StoreDrain, StorePatch, applyStorePatch} from './store'
import {exposeStoreReplay, StoreReplayOpts} from './store-replay'
import {archiveReplay, openHistory, ReplayStorage} from '../events/replay-history'

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
    /** Line options passed through to exposeStoreReplay (describe/onJournal/now).
     *  history/getSince/firstSeq are owned by the durable head itself. */
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now'>
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
    // === line: numbering continues; since() is served from the SAME storage ===
    let lineHead = () => restoredSeq
    const exposed = exposeStoreReplay(store, {
        ...(deps.expose ?? {}),
        firstSeq: restoredSeq,
        getSince: function persistedSince(seq: number) {
            if (seq > lineHead()) return undefined           // foreign lifetime → keyframe reset
            if (seq == lineHead()) return []
            const tail = storage.getEvents(seq, Infinity)
            if (!tail.length || tail[0].seq != seq + 1) return undefined  // compacted/evicted → keyframe
            return tail
        },
    })
    lineHead = exposed.replay.head
    // === archive: every new patch + cadence keyframes (baseline keyframe at boot) ===
    const archive = archiveReplay(exposed.replay, {
        storage,
        ...(everyEvents != null ? {everyEvents} : {}),
        ...(everyMs != null ? {everyMs} : {}),
    })
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
        close() { archive.close(); exposed.close() },
    }
}
export type DurableStoreReplay<T extends object> = ReturnType<typeof createDurableStoreReplay<T>>
