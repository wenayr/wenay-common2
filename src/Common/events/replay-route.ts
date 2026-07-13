import {Listener} from './Listen'
import {ReplayEvent} from './replay-listen'
import {ReplayRemote, ReplaySubscribeOpts} from './replay-wire'
import {getRpcMemberState} from './transport-lifecycle'

export type ReplayRoutePhase = 'switching' | 'ready' | 'error' | 'closed'

export type ReplayRouteEvent = {
    phase: ReplayRoutePhase
    seq: number
    from?: string
    to?: string
    error?: unknown
}

export type ReplayRouteSwitchOpts = Pick<ReplaySubscribeOpts, 'policy' | 'hint'> & {
    /** Human/debug label for the route: relay, direct, direct+shadowRelay, fallback, etc. */
    label?: string
    /** Override the catch-up coordinate. Default: last delivered seq. */
    since?: number
    /**
     * Allow a fresh keyframe/frame to reset seq downward. Default: true for the first
     * route, false for a live hand-off between equivalent routes.
     */
    reset?: boolean
}

export type ReplayRouteSubscribeOpts = ReplayRouteSwitchOpts & Pick<ReplaySubscribeOpts, 'onSeq' | 'onError'> & {
    /** Route lifecycle notifications for metrics/UI/policy shells. */
    onRoute?: (ev: ReplayRouteEvent) => void
}

type RouteSlot = {
    label?: string
    ready: Promise<void>
    close: () => void
    closed: () => boolean
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Stable replay subscriber over a replaceable route.
 *
 * Route promotion/demotion is a replay resume: subscribe to the replacement line,
 * catch up from the last delivered seq, then close the old route. Overlap is
 * deduped by seq in this wrapper, so a relay -> direct -> relay hand-off is a
 * transport/routing concern, not a store/core concern.
 */
export function replayRouteSubscribe<Z extends any[]>(
    remote: ReplayRemote<Z>,
    cb: Listener<Z>,
    opts: ReplayRouteSubscribeOpts = {},
) {
    const {onSeq, onError, onRoute} = opts
    let lastDelivered = opts.since ?? -1
    let closed = false
    let active: RouteSlot | null = null
    let currentLabel = opts.label
    let switchChain: Promise<void> = Promise.resolve()
    const slots = new Set<RouteSlot>()

    function emitRoute(ev: ReplayRouteEvent) {
        if (!onRoute) return
        try { onRoute(ev) }
        catch (e) { setTimeout(function rethrowRouteEvent() { throw e }, 0) }
    }

    function deliver(ev: ReplayEvent<Z>) {
        if (closed || ev.seq <= lastDelivered) return
        lastDelivered = ev.seq
        cb(...ev.event)
        onSeq?.(ev.seq)
    }

    function deliverMany(envs: ReplayEvent<Z>[], allowReset: boolean) {
        if (allowReset && envs.length && envs[0].seq <= lastDelivered) {
            lastDelivered = envs[0].seq - 1
        }
        for (const ev of envs) deliver(ev)
    }

    function attach(nextRemote: ReplayRemote<Z>, since: number, nextOpts: ReplayRouteSwitchOpts, allowReset: boolean): RouteSlot {
        const {policy = 'queue', hint, label} = nextOpts
        let slot!: RouteSlot
        let slotClosed = false
        let replaying = true
        let lineError: unknown
        const queue: ReplayEvent<Z>[] = []
        const frameLineState = getRpcMemberState(nextRemote, 'frameLine')
        const liveLine = policy == 'frame' && frameLineState != false && nextRemote.frameLine ? nextRemote.frameLine : nextRemote.line
        const handle = liveLine.on(function liveTap(ev: ReplayEvent<Z>) {
            if (slotClosed) return
            if (ev == null || typeof (ev as any).seq != 'number') {
                lineError = new Error('replayRouteSubscribe: line ended by route (' + String(ev) + ')')
                slot.close()
                if (!replaying) onError?.(lineError)
                return
            }
            if (replaying) queue.push(ev)
            else deliver(ev)
        })

        function closeSlot() {
            if (slotClosed) return
            slotClosed = true
            unsubscribeHandle(handle)
            slots.delete(slot)
        }

        async function catchUp() {
            try {
                let done = false
                const frameState = getRpcMemberState(nextRemote, 'frame')
                if (since >= 0 && frameState != false && nextRemote.frame) {
                    const envs = await nextRemote.frame(since, hint)
                    if (slotClosed) return
                    if (envs) {
                        deliverMany(envs, allowReset)
                        done = true
                    }
                }
                if (!done) {
                    const tail = since >= 0 ? await nextRemote.since(since) : null
                    if (slotClosed) return
                    if (tail) {
                        deliverMany(tail, false)
                    } else {
                        const kf = await nextRemote.keyframe()
                        if (slotClosed) return
                        if (kf) deliverMany([kf], allowReset)
                    }
                }
                if (lineError) throw lineError
                while (queue.length) deliver(queue.shift()!)
                replaying = false
            } catch (e) {
                closeSlot()
                throw e
            }
        }

        slot = {
            label,
            ready: catchUp(),
            close: closeSlot,
            closed: () => slotClosed,
        }
        slots.add(slot)
        return slot
    }

    async function doSwitch(nextRemote: ReplayRemote<Z>, nextOpts: ReplayRouteSwitchOpts = {}, initial = false) {
        if (closed) throw new Error('replayRouteSubscribe: closed')
        const from = active
        const fromLabel = from?.label ?? currentLabel
        const toLabel = nextOpts.label
        const since = nextOpts.since ?? lastDelivered
        const allowReset = nextOpts.reset ?? (initial || !from)
        const slot = attach(nextRemote, since, nextOpts, allowReset)
        emitRoute({phase: 'switching', from: fromLabel, to: toLabel, seq: lastDelivered})
        try {
            await slot.ready
            if (closed || slot.closed()) return
            active = slot
            currentLabel = slot.label
            if (from && from !== slot) from.close()
            emitRoute({phase: 'ready', from: fromLabel, to: toLabel, seq: lastDelivered})
        } catch (e) {
            slot.close()
            emitRoute({phase: 'error', from: fromLabel, to: toLabel, seq: lastDelivered, error: e})
            onError?.(e)
            throw e
        }
    }

    const ready = doSwitch(remote, opts, true)
    switchChain = ready.catch(() => {})

    function switchRoute(nextRemote: ReplayRemote<Z>, nextOpts: ReplayRouteSwitchOpts = {}) {
        const run = () => doSwitch(nextRemote, nextOpts, false)
        const p = switchChain.then(run, run)
        switchChain = p.catch(() => {})
        return p
    }

    function off() {
        if (closed) return
        closed = true
        for (const slot of Array.from(slots)) slot.close()
        active = null
        emitRoute({phase: 'closed', seq: lastDelivered, to: currentLabel})
    }

    return Object.assign(off, {
        /** First route catch-up finished. */
        ready,
        /** Promote/demote to another route without exposing gaps or duplicate seqs. */
        switch: switchRoute,
        /** Last delivered seq: persist it for reconnect or route policy state. */
        seq: () => lastDelivered,
        /** Current ready route label, if any. */
        label: () => currentLabel,
        /** Whether a ready route is currently active. */
        active: () => active != null && !active.closed(),
    })
}