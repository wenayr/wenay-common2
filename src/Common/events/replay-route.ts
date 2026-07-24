import {Listener} from './Listen'
import {ReplayEvent} from './replay-listen'
import {ReplayRemote, ReplaySubscribeOpts} from './replay-wire'
import {getRpcSchemaReady, rpcMemberMayBeAvailable} from './transport-lifecycle'

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
    /** Cancel and detach this replacement route if catch-up does not finish in time. */
    timeoutMs?: number
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
    let deliveryQueue: ReplayEvent<Z>[] = []
    let delivering = false

    function emitRoute(ev: ReplayRouteEvent) {
        if (!onRoute) return
        try { onRoute(ev) }
        catch (e) { setTimeout(function rethrowRouteEvent() { throw e }, 0) }
    }

    function reportRouteError(error: unknown) {
        if (!onError) return
        try { onError(error) }
        catch (caught) { setTimeout(function rethrowRouteErrorCallback() { throw caught }, 0) }
    }

    function deliverOne(ev: ReplayEvent<Z>) {
        if (closed || ev.seq <= lastDelivered) return
        cb(...ev.event)
        lastDelivered = ev.seq
        if (onSeq) {
            try { onSeq(ev.seq) }
            catch (error) { setTimeout(function rethrowRouteOnSeq() { throw error }, 0) }
        }
    }

    function deliver(ev: ReplayEvent<Z>) {
        deliveryQueue.push(ev)
        if (delivering) return
        delivering = true
        let index = 0
        try {
            while (!closed && index < deliveryQueue.length) deliverOne(deliveryQueue[index++])
        } finally {
            // A throwing callback must not leak work which it emitted before failing.
            deliveryQueue.length = 0
            delivering = false
        }
    }

    function deliverMany(envs: ReplayEvent<Z>[], allowReset: boolean) {
        if (allowReset && envs.length && envs[0].seq <= lastDelivered) {
            lastDelivered = envs[0].seq - 1
        }
        for (const ev of envs) deliver(ev)
    }

    function attach(nextRemote: ReplayRemote<Z>, since: number, nextOpts: ReplayRouteSwitchOpts, allowReset: boolean): RouteSlot {
        const {policy = 'queue', hint, label, timeoutMs} = nextOpts
        let slot!: RouteSlot
        let slotClosed = false
        let replaying = true
        let lineFailed = false
        let handle: any
        const slotClosedResult = Symbol('replay route slot closed')
        let resolveSlotEnd = function resolveRouteSlotLater(_result: typeof slotClosedResult) {}
        let rejectSlotEnd = function rejectRouteSlotLater(_error: unknown) {}
        const slotEnd = new Promise<typeof slotClosedResult>(function waitForRouteSlotEnd(resolve, reject) {
            resolveSlotEnd = resolve
            rejectSlotEnd = reject
        })
        const queue: ReplayEvent<Z>[] = []

        function disposeSlot() {
            if (slotClosed) return
            slotClosed = true
            queue.length = 0
            unsubscribeHandle(handle)
            slots.delete(slot)
        }

        function closeSlot() {
            if (slotClosed) return
            resolveSlotEnd(slotClosedResult)
            disposeSlot()
        }

        function failLine(error: unknown) {
            if (lineFailed || slotClosed) return
            lineFailed = true
            rejectSlotEnd(error)
            disposeSlot()
            if (!replaying) {
                reportRouteError(error)
            }
        }

        function liveTap(ev: ReplayEvent<Z>) {
            if (slotClosed) return
            if (ev == null || typeof (ev as any).seq != 'number') {
                failLine(new Error('replayRouteSubscribe: line ended by route (' + String(ev) + ')'))
                return
            }
            if (replaying) queue.push(ev)
            else {
                try { deliver(ev) }
                catch (error) { failLine(error) }
            }
        }

        function attachLiveLine() {
            if (slotClosed) return
            const liveLine = policy == 'frame' && rpcMemberMayBeAvailable(nextRemote, 'frameLine')
                ? nextRemote.frameLine!
                : nextRemote.line
            try {
                handle = liveLine.on(liveTap)
                if (!slotClosed && typeof handle?.then == 'function') {
                    handle.then(
                        function routeLineEnded() { failLine(new Error('replayRouteSubscribe: logical route line ended')) },
                        function routeLineRejected(error: unknown) { failLine(error) },
                    )
                }
            } catch (error) {
                failLine(error)
            }
            if (slotClosed) {
                unsubscribeHandle(handle)
                handle = null
            }
        }

        const schemaReady = getRpcSchemaReady(nextRemote)
        let lineReady: Promise<void>
        if (schemaReady) {
            try {
                lineReady = Promise.resolve(schemaReady()).then(attachLiveLine)
            } catch (error) {
                lineReady = Promise.reject(error)
            }
            lineReady.catch(function deferRouteLineReadyFailureToCatchUp() {})
        } else {
            attachLiveLine()
            lineReady = Promise.resolve()
        }

        function waitForSlot<T>(value: T | PromiseLike<T>) {
            return Promise.race([Promise.resolve(value), slotEnd])
        }

        async function catchUpRemote() {
            const lineState = await waitForSlot(lineReady)
            if (lineState == slotClosedResult) return
            let done = false
            if (since >= 0 && rpcMemberMayBeAvailable(nextRemote, 'frame')) {
                const envs = await waitForSlot(nextRemote.frame!(since, hint))
                if (envs == slotClosedResult) return
                if (envs) {
                    deliverMany(envs, allowReset)
                    done = true
                }
            }
            if (!done) {
                const tail = since >= 0 ? await waitForSlot(nextRemote.since(since)) : null
                if (tail == slotClosedResult) return
                if (tail) {
                    deliverMany(tail, false)
                } else {
                    const kf = await waitForSlot(nextRemote.keyframe())
                    if (kf == slotClosedResult) return
                    if (kf) deliverMany([kf], allowReset)
                }
            }
            for (let index = 0; index < queue.length; index++) deliver(queue[index])
            queue.length = 0
            replaying = false
        }

        const catchUpReady = Promise.race([
            catchUpRemote(),
            slotEnd.then(function routeSlotClosed() {}),
        ]).catch(function closeFailedRoute(error) {
            disposeSlot()
            throw error
        })

        slot = {
            label,
            ready: catchUpReady,
            close: closeSlot,
            closed: () => slotClosed,
        }
        if (timeoutMs != null) {
            slot.ready = new Promise<void>(function boundRouteCatchUp(resolve, reject) {
                const timer = setTimeout(function routeCatchUpTimedOut() {
                    const error = new Error('route catch-up timeout: ' + (label ?? 'route'))
                    closeSlot()
                    reject(error)
                }, timeoutMs)
                catchUpReady.then(
                    function routeCatchUpFinished() {
                        clearTimeout(timer)
                        resolve()
                    },
                    function routeCatchUpFailed(error) {
                        clearTimeout(timer)
                        reject(error)
                    },
                )
            })
        }
        if (!slotClosed) slots.add(slot)
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
            if (from && from != slot) from.close()
            emitRoute({phase: 'ready', from: fromLabel, to: toLabel, seq: lastDelivered})
        } catch (e) {
            slot.close()
            emitRoute({phase: 'error', from: fromLabel, to: toLabel, seq: lastDelivered, error: e})
            reportRouteError(e)
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
        deliveryQueue.length = 0
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
