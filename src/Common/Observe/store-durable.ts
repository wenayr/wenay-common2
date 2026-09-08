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
//
// Two layers: openDurableStore is the primitive — the restored store plus the
// line options and the archiver, WITHOUT a line of its own, so any layer that
// exposes its own line (the replica set under Scale.createAuthority) can put
// that line on the storage port. createDurableStoreReplay is the standalone
// head: the primitive plus exposeStoreReplay.

import {createStore, StoreDrain, StorePatch, applyStorePatches, listenStorePatches} from './store'
import {flushReactiveNow} from './reactive'
import {exposeStoreReplay, StoreReplayOpts} from './store-replay'
import {openHistory, ReplayStorage} from '../events/replay-history'
import {ReplayEvent} from '../events/replay-listen'

// ============================================================
// the primitive: restored store + line options + archiver
// ============================================================

export type DurableStoreDeps<T extends object> = {
    /** Persistence port: memory reference impl, fs impl (wenay-common2/server), or your DB adapter. */
    storage: ReplayStorage<[readonly StorePatch[]]>
    /** State when the archive is empty (first boot). */
    initial?: T
    /** Keyframe cadence: every N events (archiveReplay default 64). */
    everyEvents?: number
    /** ...or every T ms along the event ts line — whichever comes first. */
    everyMs?: number
    drain?: StoreDrain
    /** The line's own journal hook, called BEFORE the event is persisted. */
    onJournal?: StoreReplayOpts['onJournal']
}

/** The line a durable store is attached to: the local replay line (head/lastTs/keyframe)
 *  and, when the layer has one, the retry of patches retained after a storage failure. */
export type DurableStoreLine = {
    replay: ReturnType<typeof exposeStoreReplay<object>>['replay']
    flushPending?: () => void
}

export function openDurableStore<T extends object>(deps: DurableStoreDeps<T>) {
    const {storage, everyEvents, everyMs, drain} = deps
    // === restore: [keyframe, ...deltas] → state + head coordinate of the previous lifetime ===
    const envelopes = openHistory(storage).at({})
    let restoredSeq = 0
    let state = (deps.initial ?? {}) as T
    if (envelopes) {
        const scratch = createStore<any>({})
        for (const ev of envelopes) applyStorePatches(scratch, ev.event[0])
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

    // === line options: numbering continues; since() is served from the SAME storage ===
    let lineHead = () => restoredSeq
    const userOnJournal = deps.onJournal
    const bulkPut = storage.putEvents
    function persistEvent(ev: ReplayEvent<[readonly StorePatch[]]>) {
        userOnJournal?.(ev)
        storage.putEvent(ev)
        events++
    }
    function persistBatch(batch: readonly ReplayEvent<[readonly StorePatch[]]>[]) {
        bulkPut!(batch)
        events += batch.length
    }
    const expose: Pick<StoreReplayOpts, 'firstSeq' | 'onJournal' | 'onJournalBatch' | 'getSince'> = {
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
    }

    // === archiver: keyframes only after the full drain was precommitted and published ===
    /** Bind the archiver to the line exposed over `store` with `expose`; call AFTER exposeStoreReplay
     *  so the line's journal listener runs first on the shared sampled source — a storage failure
     *  then stops dispatch before cadence can write a keyframe for an uncommitted head. */
    function attach(line: DurableStoreLine) {
        lineHead = line.replay.head
        function takeKeyframe() {
            const kf = line.replay.keyframe()
            if (!kf) return
            storage.putKeyframe(kf)
            keyframes++
            lastKfSeq = kf.seq
            lastKfTs = kf.ts
        }
        function updateKeyframeCadence() {
            const head = line.replay.head()
            const ts = line.replay.lastTs()
            const due = head - lastKfSeq >= cadenceEvents || (everyMs != null && ts - lastKfTs >= everyMs)
            if (due) takeKeyframe()
        }
        takeKeyframe()
        const offBurst = listenStorePatches(store).on(function finishDurableBurst() { updateKeyframeCadence() })
        function retry() {
            line.flushPending?.()
            updateKeyframeCadence()
        }
        return {
            /** Archiver counters {events, keyframes} since this boot. */
            stats: () => ({events, keyframes}),
            /** Retry a Store drain retained after an atomic storage failure. */
            retry,
            /** Drain the store's pending window into the line NOW: the line's own close then journals it. */
            flush() {
                flushReactiveNow(store.state)
                line.flushPending?.()
            },
            close() {
                flushReactiveNow(store.state)
                line.flushPending?.()
                offBurst()
            },
        }
    }

    return {
        /** The restored store — authority state; write here. */
        store,
        /** What the boot found: head seq of the previous lifetime (0 = fresh archive). */
        restored: {seq: restoredSeq, fromArchive: !!envelopes},
        /** Line options for the layer that exposes the line (spread into exposeStoreReplay opts). */
        expose,
        attach,
    }
}
export type DurableStore<T extends object> = ReturnType<typeof openDurableStore<T>>

// ============================================================
// the standalone head: the primitive + its own line
// ============================================================

export type DurableStoreReplayDeps<T extends object> = Omit<DurableStoreDeps<T>, 'onJournal'> & {
    /** Line options passed through to exposeStoreReplay.
     *  history/getSince/firstSeq are owned by the durable head itself. */
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now' | 'maxItems' | 'maxBytes' | 'maxDelayMs'>
}

export function createDurableStoreReplay<T extends object>(deps: DurableStoreReplayDeps<T>) {
    const {onJournal: userOnJournal, ...exposeOpts} = deps.expose ?? {}
    const {expose: _expose, ...storeDeps} = deps
    const opened = openDurableStore<T>({...storeDeps, ...(userOnJournal ? {onJournal: userOnJournal} : {})})
    const exposed = exposeStoreReplay(opened.store, {...exposeOpts, ...opened.expose})
    let archive: ReturnType<typeof opened.attach>
    try { archive = opened.attach(exposed) }
    catch (error) {
        exposed.close()
        throw error
    }
    return {
        /** The durable store — authority state; write here. */
        store: opened.store,
        /** Wire facade (object: api) — same shape as exposeStoreReplay. */
        api: exposed.api,
        /** Local replay-line (head/getSince/keyframe). */
        replay: exposed.replay,
        /** What the boot found: head seq of the previous lifetime (0 = fresh archive). */
        restored: opened.restored,
        /** Archiver counters {events, keyframes} since this boot. */
        stats: archive.stats,
        /** Retry a Store drain retained after an atomic storage failure. */
        retry: archive.retry,
        close() { archive.close(); exposed.close() },
    }
}
export type DurableStoreReplay<T extends object> = ReturnType<typeof createDurableStoreReplay<T>>
