// =====================================================================
// Store playback — re-run a recorded/archived patch line into a fresh store
// =====================================================================
// Takes any ReplayStorage of the patch line (live archive, loaded flight
// recording — events/replay-record) and re-emits it from the OLDEST
// reconstructible point into a new store head: seq coordinates are preserved
// (firstSeq), pace is a speed multiplier over recorded ts gaps (Infinity =
// instant flush), and the result is an ordinary exposeStoreReplay head —
// mirrors/subscribers consume the playback exactly like a live line.
// storeReplayAt stays the random-access companion (state at one point);
// this is the motion-picture companion (the whole line, at your pace).

import {createStore, StoreDrain, StorePatch, applyStorePatches} from './store'
import {exposeStoreReplay, StoreReplayOpts} from './store-replay'
import {ReplayEvent} from '../events/replay-listen'
import {openHistory, ReplayStorage} from '../events/replay-history'

export type StorePlaybackOpts = {
    /** Pace multiplier over recorded ts gaps (default 1; Infinity = flush instantly). */
    speed?: number
    /** Cap for a single inter-event pause, ms (long recorded silences fast-forward). */
    maxStepMs?: number
    drain?: StoreDrain
    /** Passed through to the playback head. */
    expose?: Pick<StoreReplayOpts, 'describe' | 'history' | 'now' | 'maxItems' | 'maxBytes' | 'maxDelayMs'>
}

export function playbackStoreReplay<T extends object>(
    storage: ReplayStorage<[readonly StorePatch[]]>,
    opts: StorePlaybackOpts = {},
) {
    const {speed = 1, maxStepMs, drain} = opts
    // oldest reconstructible point: keyframe covering the first stored event, else latest keyframe
    const all = storage.getEvents(0, Infinity)
    let base = storage.getKeyframe(all.length ? {seq: all[0].seq - 1} : {})
    let tail: ReplayEvent<[readonly StorePatch[]]>[]
    if (base) tail = all.filter(ev => ev.seq > base!.seq)
    else {
        const envs = openHistory(storage).at({})
        base = envs?.[0]
        tail = envs?.slice(1) ?? []
    }
    const store = createStore<T>({} as T, drain !== undefined ? {drain} : {})
    if (base) applyStorePatches(store, base.event[0])
    const exposed = exposeStoreReplay(store, {...(opts.expose ?? {}), firstSeq: base?.seq ?? 0})
    let closed = false
    let timer: any = null
    let index = 0
    let resolveDone: () => void = function resolveLater() {}
    const done = new Promise<void>(function waitPlayback(resolve) { resolveDone = resolve })
    function finish() { if (!closed) { closed = true; resolveDone() } }
    function step() {
        timer = null
        while (!closed && index < tail.length) {
            const ev = tail[index++]
            applyStorePatches(store, ev.event[0])
            if (index >= tail.length) break
            const gap = Math.max(0, tail[index].ts - ev.ts) / speed
            const wait = maxStepMs != null ? Math.min(gap, maxStepMs) : gap
            if (wait > 0 && Number.isFinite(wait)) {
                timer = setTimeout(step, wait)
                timer.unref?.()
                return
            }
        }
        finish()
    }
    if (speed == Infinity || !tail.length) step()
    else { timer = setTimeout(step, 0); timer.unref?.() }
    return {
        /** The playback store — read/subscribe as usual. */
        store,
        /** Wire facade of the playback head (object: api) — mirrors consume it like a live line. */
        api: exposed.api,
        /** Local replay-line of the playback head. */
        replay: exposed.replay,
        /** Re-emitted line boundaries: from = base keyframe seq, to = last event seq. */
        range: {from: base?.seq ?? 0, to: tail.length ? tail[tail.length - 1].seq : base?.seq ?? 0},
        /** Resolves when the tail is fully re-emitted (or after close()). */
        done,
        close() { if (timer) { clearTimeout(timer); timer = null } finish(); exposed.close() },
    }
}
export type StorePlayback<T extends object> = ReturnType<typeof playbackStoreReplay<T>>
