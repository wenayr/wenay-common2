// =====================================================================
// Wire-pair of replay-line: exposeReplay (server) ⇄ replaySubscribe (client)
// =====================================================================
// RPC core untouched AT ALL: line — ordinary Listen (rpc-server-auto proxies
// it as-is), since/keyframe — ordinary methods. Handover replay→live on
// client is async (events live between tail request and response) —
// same queue + dedup by seq as in synchronous on({since}).
// Transport requirement: ordering (socket.io/TCP, in-proc) — subscription
// to line set up on server BEFORE since() executes → no gaps.
//
// Staleness (staleMs/onStale): delivery CONSISTENT, but silent about freshness — two
// failure modes the wire hides itself: silent line (producer died, no envelopes)
// and stale keyframe (arrived now, ts old). Both handled by client watchdog:
// arrival gap — only timer (local time, clock skew doesn't matter), envelope ts age —
// predicate at delivery time (producer time; skewMs tolerance for skew).

import {Listener, NormalizeTuple} from './Listen'
import {ListenReplayApi, ReplayEvent, StaleInfo} from './replay-listen'
import {conflateReplay, ConflateOpts} from './replay-conflate'
import {getRpcMemberState, getRpcTransportLifecycle} from './transport-lifecycle'

/** Wire-pair form of replay-line — what spreads into RPC server object. */
export type ReplayExpose<T> = {
    line: ListenReplayApi<T>['line']
    since: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | null
    keyframe: () => ReplayEvent<NormalizeTuple<T>> | null
    frame: ListenReplayApi<T>['frame']
}

function exposeReplayPlain<T>(replay: ListenReplayApi<T>): ReplayExpose<T> {
    return {
        line: replay.line,
        /** Log tail after seq. null = evicted → client gets keyframe. */
        since: (seq: number) => replay.getSince(seq) ?? null,
        /** Fresh keyframe + its seq. null = current-provider not set. */
        keyframe: () => replay.keyframe() ?? null,
        /** Frame (see replay-listen): compact catch-up in one call. Throw (holy
         *  line + eviction) goes to client as rejected promise — loud by design. */
        frame: (seq: number, hint?: unknown) => replay.frame(seq, hint),
    }
}

/**
 * Wire-facade of replay-line: spreads into RPC server object.
 *
 * With conflate option — same thing, but line goes through personal gates
 * conflateReplay (per-connection: pending() — buffer for THIS client). close/stats —
 * for connection owner, DO NOT PUT IN RPC OBJECT (become remotely callable):
 *     const {close, stats, ...api} = exposeReplay(replay, {conflate: {pending, highWater}})
 *     object = {...rest, replay: api}        // wire
 *     disconnect → close()                   // one line
 * Multiple channels on one connection — per-channel gates; pending usually
 * shared (one socket buffer).
 */
export function exposeReplay<T>(replay: ListenReplayApi<T>): ReplayExpose<T>
export function exposeReplay<T>(replay: ListenReplayApi<T>, opts: {conflate: ConflateOpts<NormalizeTuple<T>>}):
    ReplayExpose<T> & {close: () => void, stats: ReturnType<typeof conflateReplay<T>>['stats']}
export function exposeReplay<T>(replay: ListenReplayApi<T>, opts?: {conflate?: ConflateOpts<NormalizeTuple<T>>}) {
    if (!opts?.conflate) return exposeReplayPlain(replay)
    const gated = conflateReplay(replay, opts.conflate)
    return {...gated.api, close: gated.close, stats: gated.stats}
}

/** What client sees after RPC-projection of exposeReplay (methods became async). */
export type ReplayRemote<Z extends any[] = any[]> = {
    line: {on: (cb: (ev: ReplayEvent<Z>) => void) => any}
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined
    keyframe: () => Promise<ReplayEvent<Z> | null | undefined> | ReplayEvent<Z> | null | undefined
    /** (additive) Frame: catch-up in one call; preferred over since/keyframe when server provides it. */
    frame?: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined
    /** (additive) Push-line of 'frame' policy: server may skip on lag, recovering with frame. */
    frameLine?: {on: (cb: (ev: ReplayEvent<Z>) => void) => any}
    /** (additive) Static source descriptor (schema/originId/... hints). Absent on older servers. */
    describe?: () => Promise<Record<string, any> | null | undefined> | Record<string, any> | null | undefined
}

export type ReplaySubscribeOpts = {
    /** "I have seq K". Less than 0 / not given = nothing → keyframe + live. */
    since?: number
    /** Report seq of each delivery — store for reconnect. */
    onSeq?: (seq: number) => void
    onError?: (e: any) => void
    /** End of EACH successful catch-up (initial and reconnect): line live again.
     *  Complements ready (only first handover) — for live/catching-up status. */
    onLive?: () => void
    /** Staleness threshold, ms: for both arrival gap (wire silence) and envelope ts age. */
    staleMs?: number
    /**
     * Staleness watchdog: edge-triggered on BOTH sides. Timer (arrival gap) exists
     * only with onStale given; isStale()/lastTs() work without it. Requires staleMs.
     */
    onStale?: (info: StaleInfo) => void
    /** Tolerance for producer/client clock skew for ts predicate (default 0). */
    skewMs?: number
    /** Local clock (default Date.now) — replaceable in tests. */
    now?: () => number
    /**
     * Lag policy — CONSUMER choice: 'queue' (default: connected live-wire
     * not gated; catch-up can still return producer frame/keyframe) | 'frame'
     * (server may skip and recover with frame via frameLine, if available).
     */
    policy?: 'queue' | 'frame'
    /** Opaque hint to producer frame-lambda (arbitrary skip rules). Wire doesn't inspect. */
    hint?: unknown
}

// unsubscribe handle is either a function (Listen) or object (wire SubscriptionHandle)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/** Read the line's static source descriptor (schema/originId/...); null when the server has none. */
export async function readReplayDescriptor(remote: Pick<ReplayRemote, 'describe'>) {
    const state = getRpcMemberState(remote, 'describe')
    if (state == false || !remote.describe) return null
    return (await remote.describe()) ?? null
}

/**
 * Client catch-up over ReplayRemote: subscribe to line FIRST (live events
 * accumulate in queue), then tail since(K) — or keyframe if evicted/nothing, —
 * then drain queue and live. Returns off() with .ready (end of catch-up),
 * .seq() (last delivered — for reconnect), .isStale() and .lastTs().
 */
export function replaySubscribe<Z extends any[]>(remote: ReplayRemote<Z>, cb: Listener<Z>, opts: ReplaySubscribeOpts = {}) {
    const {since = -1, onSeq, onError, onLive, staleMs, onStale, skewMs = 0, now = Date.now, policy = 'queue', hint} = opts
    const lifecycle = getRpcTransportLifecycle(remote)
    let lastDelivered = since
    let replaying = true
    let closed = false
    let recoveryGeneration = 0
    const queue: ReplayEvent<Z>[] = []

    let readySettled = false
    let resolveReady: () => void = function resolveReadyLater() {}
    const ready = new Promise<void>(function waitUntilReady(resolve) { resolveReady = resolve })
    function settleReady() {
        if (readySettled) return
        readySettled = true
        resolveReady()
    }

    // === staleness watchdog ===
    let lastTs = 0
    let lastArrival = now()
    let staleFlag = false
    let staleTimer: any = null
    function stopStaleTimer() {
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    }
    function reportStale(stale: boolean) {
        staleFlag = stale
        if (!onStale) return
        try { onStale({stale, lastTs, age: now() - (lastTs || lastArrival)}) }
        catch (e) { setTimeout(function rethrowOnStale() { throw e }, 0) }
    }
    function checkArrivalGap() {
        staleTimer = null
        if (closed) return
        const gap = now() - lastArrival
        if (gap >= staleMs!) { if (!staleFlag) reportStale(true) }
        else armStaleTimer(staleMs! - gap)
    }
    function armStaleTimer(delay: number) {
        if (staleTimer || !onStale || staleMs == null || closed) return
        staleTimer = setTimeout(checkArrivalGap, delay)
        staleTimer.unref?.()
    }
    function assessStale() {
        if (staleMs == null || closed) return
        const tsStale = lastTs > 0 && now() - lastTs > staleMs + skewMs
        if (tsStale != staleFlag) reportStale(tsStale)
        if (tsStale) stopStaleTimer()
        else armStaleTimer(staleMs)
    }
    armStaleTimer(staleMs!)

    function deliver(ev: ReplayEvent<Z>) {
        if (closed || ev.seq <= lastDelivered) return
        lastDelivered = ev.seq
        lastTs = ev.ts
        lastArrival = now()
        cb(...ev.event)
        onSeq?.(ev.seq)
        if (!replaying) assessStale()
    }

    function deliverSorted(events: ReplayEvent<Z>[], allowReset: boolean) {
        const sorted = [...events].sort((a, b) => a.seq - b.seq)
        // Initial attach historically accepts a keyframe from a restarted seq-space.
        // Reconnect never resets: its contract is anchored at lastDelivered.
        if (allowReset && sorted.length && sorted[0].seq <= lastDelivered) {
            lastDelivered = sorted[0].seq - 1
        }
        for (const event of sorted) deliver(event)
    }

    function drainLiveQueue() {
        // Delivery can synchronously trigger another live envelope; keep replaying
        // until every such batch has also been ordered and deduplicated.
        while (queue.length) {
            const batch = queue.splice(0).sort((a, b) => a.seq - b.seq)
            for (const event of batch) deliver(event)
        }
    }

    const frameLineState = getRpcMemberState(remote, 'frameLine')
    const liveLine = policy == 'frame' && frameLineState != false && remote.frameLine ? remote.frameLine : remote.line
    let handle: any = null
    let offConnect = function noConnectListener() {}
    let offDisconnect = function noDisconnectListener() {}
    let offClose = function noCloseListener() {}

    function closeSubscription() {
        if (closed) return false
        closed = true
        recoveryGeneration++
        queue.length = 0
        stopStaleTimer()
        offConnect()
        offDisconnect()
        offClose()
        unsubscribeHandle(handle)
        settleReady()
        return true
    }

    function errorText(error: any) {
        if (typeof error?.message == 'string') return error.message
        if (typeof error?.error?.message == 'string') return error.error.message
        return String(error)
    }

    function failRecovery(error: any, point: number, phase: string) {
        const wrapped = new Error('replaySubscribe: ' + phase + ' from seq ' + point + ' failed: ' + errorText(error))
        ;(wrapped as any).cause = error
        if (!closeSubscription()) return
        if (onError) {
            try { onError(wrapped) }
            catch (caught) { setTimeout(function rethrowOnError() { throw caught }, 0) }
        } else {
            setTimeout(function rethrowRecoveryError() { throw wrapped }, 0)
        }
    }

    handle = liveLine.on(function liveTap(ev: ReplayEvent<Z>) {
        if (ev == null || typeof (ev as any).seq != 'number') {
            failRecovery(new Error('line ended by server (' + String(ev) + ')'), lastDelivered, 'live line')
            return
        }
        lastArrival = now()
        if (replaying) queue.push(ev)
        else deliver(ev)
    })

    if (typeof handle?.then == 'function') {
        handle.then(
            function logicalLineEnded() {
                if (!closed) failRecovery(new Error('logical RPC line ended'), lastDelivered, 'live line')
            },
            function logicalLineFailed(error: any) {
                if (!closed) failRecovery(error, lastDelivered, 'live line')
            },
        )
    }

    function isCurrent(generation: number) {
        return !closed && generation == recoveryGeneration
    }

    async function catchUp(generation: number, point: number, initial: boolean) {
        try {
            let done = false
            const frameState = getRpcMemberState(remote, 'frame')
            if (point >= 0 && frameState != false && remote.frame) {
                const envelopes = await remote.frame(point, hint)
                if (!isCurrent(generation)) return
                if (envelopes) {
                    deliverSorted(envelopes, initial)
                    done = true
                }
            }
            if (!done) {
                const tail = point >= 0 ? await remote.since(point) : null
                if (!isCurrent(generation)) return
                if (tail) {
                    deliverSorted(tail, false)
                } else {
                    const keyframe = await remote.keyframe()
                    if (!isCurrent(generation)) return
                    if (keyframe) {
                        if (initial && keyframe.seq <= lastDelivered) lastDelivered = keyframe.seq - 1
                        deliver(keyframe)
                    } else if (point >= 0) {
                        throw new Error('journal evicted or unavailable; no keyframe can cover the gap')
                    }
                }
            }
            if (!isCurrent(generation)) return
            drainLiveQueue()
            replaying = false
            assessStale()
            settleReady()
            if (onLive) {
                try { onLive() }
                catch (e) { setTimeout(function rethrowOnLive() { throw e }, 0) }
            }
        } catch (error) {
            if (!isCurrent(generation)) return
            failRecovery(error, point, initial ? 'initial catch-up' : 'reconnect catch-up')
        }
    }

    function startCatchUp(initial: boolean) {
        if (closed) return
        replaying = true
        const generation = ++recoveryGeneration
        void catchUp(generation, lastDelivered, initial)
    }

    if (lifecycle) {
        offDisconnect = lifecycle.onDisconnect(function replayTransportDisconnected() {
            if (closed) return
            replaying = true
            recoveryGeneration++
            queue.length = 0
        })
        offConnect = lifecycle.onConnect(function replayTransportConnected() {
            startCatchUp(!readySettled)
        })
        offClose = lifecycle.onClose(function replayTransportClosed() {
            closeSubscription()
        })
    }

    if (!lifecycle || lifecycle.connected()) startCatchUp(true)

    function off() {
        closeSubscription()
    }
    return Object.assign(off, {
        /** Wait for end of first successful handover or terminal error/teardown. */
        ready,
        /** Last honestly delivered seq — reconnect never advances it after gap-error. */
        seq: () => lastDelivered,
        /** Staleness now: ts predicate of last delivery OR lazy arrival gap. */
        isStale: () => staleFlag || (staleMs != null && now() - lastArrival >= staleMs),
        /** ts of last delivered envelope (0 = hasn't happened yet). */
        lastTs: () => lastTs,
    })
}
