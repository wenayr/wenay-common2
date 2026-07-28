import {listen, Listener} from '../events/Listen'
import {
    createRouteCoordinator,
    RouteCoordinatorDeps,
    RoutePolicy,
    tRouteState,
} from '../events/route-coordinator'

export type tMediaRouteMode = 'relay' | 'direct' | 'best'
export type tMediaActiveRoute = 'relay' | 'direct' | null
export type tMediaRouteState = 'idle' | 'starting' | tRouteState

export type MediaRouteStatus = {
    mode: tMediaRouteMode
    state: tMediaRouteState
    active: tMediaActiveRoute
    label: string | null
    error?: unknown
}

export type MediaRouteChange = {
    previous: MediaRouteStatus
    current: MediaRouteStatus
    reason?: unknown
}

export type MediaRouteDeps<Z extends any[] = any[]> = {
    self: string
    peer: string
    /** relay = server only; direct = WebRTC required; best = relay bootstrap + direct promotion/fallback. */
    mode?: tMediaRouteMode
    connect: RouteCoordinatorDeps<Z>['connect']
    policy?: RoutePolicy
    shadow?: RouteCoordinatorDeps<Z>['shadow']
    catchUpTimeoutMs?: number
    /** Retry a failed direct promotion in best mode. false disables background retries. */
    directRetryMs?: number | false
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') handle()
    else if (typeof handle?.off == 'function') handle.off()
    else handle?.unsubscribe?.()
}

/**
 * Per-peer media line whose transport policy is independent from capture/encoding.
 *
 * The injected connectors are the existing replay route connectors. A relay connector
 * normally opens the server line; a direct connector may be createWebRtcConnector.
 */
export function createMediaRoute<Z extends any[] = any[]>(deps: MediaRouteDeps<Z>) {
    const {
        self,
        peer,
        connect,
        policy,
        shadow,
        catchUpTimeoutMs,
        directRetryMs = 5_000,
    } = deps
    const coordinator = createRouteCoordinator<Z>({connect, policy, shadow, catchUpTimeoutMs})
    let link = coordinator.pair(self, peer)
    const [emitFrame, line] = listen<Z>()
    const [emitChange, changed] = listen<[MediaRouteChange]>()
    let mode = deps.mode ?? 'relay'
    let stage: 'idle' | 'starting' | 'started' | 'closed' = 'idle'
    let error: unknown
    let offLine: any = null
    let directReady = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let opChain: Promise<unknown> = Promise.resolve()
    let resetting = false
    let previous: MediaRouteStatus = {
        mode,
        state: 'idle',
        active: null,
        label: null,
    }

    // ============== synchronous facts ==============

    function activeRoute(): tMediaActiveRoute {
        if (stage == 'idle' || stage == 'starting' || stage == 'closed') return null
        const routeState = link.state()
        const direct = directReady && (routeState == 'direct' || routeState == 'direct+shadowRelay')
        if (mode == 'direct') return direct ? 'direct' : null
        return direct ? 'direct' : 'relay'
    }

    function status(): MediaRouteStatus {
        const active = activeRoute()
        return {
            mode,
            state: stage == 'idle' ? 'idle'
                : stage == 'starting' ? 'starting'
                    : stage == 'closed' ? 'closed'
                        : link.state(),
            active,
            label: active ? link.label() : null,
            ...(error == undefined ? {} : {error}),
        }
    }

    function sameStatus(a: MediaRouteStatus, b: MediaRouteStatus) {
        return a.mode == b.mode && a.state == b.state && a.active == b.active &&
            a.label == b.label && a.error == b.error
    }

    function publish(reason?: unknown) {
        const current = status()
        if (sameStatus(previous, current) && reason == undefined) return
        const before = previous
        previous = current
        emitChange({previous: before, current, reason})
    }

    // ============== line ownership ==============

    function forwardFrame(...event: Z) {
        // Strict direct never leaks relay-delivered frames while promotion is pending
        // or failed. After promotion the subscription is recreated on direct so its
        // own replay keyframe/catch-up establishes the consumer coordinate.
        if (mode == 'direct' && activeRoute() != 'direct') return
        const send = emitFrame as any
        send(...event)
    }

    async function replaceSubscription() {
        unsubscribeHandle(offLine)
        offLine = link.subscribe(forwardFrame as Listener<Z>)
        await offLine.ready
    }

    async function ensureSubscription() {
        if (offLine) return
        offLine = link.subscribe(forwardFrame as Listener<Z>)
        await offLine.ready
    }

    function resetLink() {
        resetting = true
        unsubscribeHandle(offLine)
        offLine = null
        link.close()
        link = coordinator.pair(self, peer)
        directReady = false
        resetting = false
    }

    // ============== route policy ==============

    function cancelRetry() {
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = null
    }

    function shouldRetry(reason?: unknown) {
        return !(typeof reason == 'string' && reason.startsWith('policy:'))
    }

    function scheduleBestRetry(reason?: unknown) {
        if (stage != 'started' || mode != 'best' || directRetryMs == false || retryTimer ||
            !shouldRetry(reason)) return
        retryTimer = setTimeout(function retryBestDirect() {
            retryTimer = null
            void reconsider('best retry')
        }, Math.max(0, directRetryMs))
    }

    async function promote(reason?: unknown) {
        directReady = false
        try {
            const result = await link.promoteDirect({reason})
            if (!result.ok) {
                error = result.reason
                if (mode == 'best') scheduleBestRetry(result.reason)
                publish(result.reason)
                return status()
            }
            error = undefined
            cancelRetry()
            if (mode == 'direct') await replaceSubscription()
            directReady = true
            publish(reason)
            return status()
        } catch (nextError) {
            directReady = false
            error = nextError
            if (mode == 'direct') {
                resetLink()
            } else if (link.state() == 'direct' || link.state() == 'direct+shadowRelay') {
                try { await link.fallback(nextError) } catch {}
            }
            if (mode == 'best') scheduleBestRetry(nextError)
            publish(nextError)
            return status()
        }
    }

    async function applyMode(reason?: unknown) {
        if (mode == 'relay') {
            cancelRetry()
            directReady = false
            const result = await link.reinterposeRelay(reason)
            error = result.ok ? undefined : result.reason
            publish(result.reason ?? reason)
            return status()
        }
        return promote(reason)
    }

    function chained<T>(run: () => Promise<T>) {
        const task = opChain.then(run, run)
        opChain = task.catch(() => {})
        return task
    }

    async function start() {
        return chained(async function startMediaRoute() {
            if (stage == 'closed') throw new Error('media route is closed')
            if (stage == 'started') return status()
            stage = 'starting'
            error = undefined
            publish('start')
            if (mode == 'direct') {
                stage = 'started'
                publish('direct start')
                return promote('start')
            }
            try {
                await ensureSubscription()
                stage = 'started'
                publish('relay ready')
                return await applyMode('start')
            } catch (nextError) {
                stage = 'started'
                error = nextError
                publish(nextError)
                if (mode == 'best') return promote('relay unavailable')
                return status()
            }
        })
    }

    async function setMode(next: tMediaRouteMode) {
        return chained(async function setMediaRouteMode() {
            if (stage == 'closed') throw new Error('media route is closed')
            if (mode == next && stage == 'started') return status()
            mode = next
            error = undefined
            publish('mode')
            if (stage != 'started') return status()
            if ((mode == 'relay' || mode == 'best') && !offLine) {
                try {
                    await ensureSubscription()
                } catch (nextError) {
                    error = nextError
                    publish(nextError)
                    if (mode == 'best') return promote('relay unavailable')
                    return status()
                }
            }
            return applyMode('mode')
        })
    }

    async function reconsider(reason?: unknown) {
        return chained(async function reconsiderMediaRoute() {
            if (stage == 'closed') throw new Error('media route is closed')
            if (stage != 'started') return status()
            if (mode == 'relay') return status()
            return promote(reason)
        })
    }

    const offRoute = coordinator.onRoute(function onUnderlyingRoute(event) {
        if (resetting || event.key != link.ref.key || stage == 'closed') return
        if (event.to == 'fallback' || event.to == 'relay' || event.to == 'blocked') directReady = false
        if (event.to == 'fallback' && mode == 'best') scheduleBestRetry(event.reason)
        if (event.to == 'fallback' && mode == 'direct') error = event.reason
        publish(event.reason)
    })

    function close() {
        if (stage == 'closed') return
        cancelRetry()
        stage = 'closed'
        unsubscribeHandle(offLine)
        offLine = null
        unsubscribeHandle(offRoute)
        coordinator.close()
        publish('close')
        line.close()
        changed.close()
    }

    return {
        control: {
            start,
            setMode,
            reconsider,
            close,
        },
        resource: {
            line,
        },
        events: {
            changed,
        },
        view: {
            status,
            mode: () => mode,
            route: activeRoute,
            metrics: () => link.metrics(),
        },
    }
}

export type MediaRoute<Z extends any[] = any[]> = ReturnType<typeof createMediaRoute<Z>>
