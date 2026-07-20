// =====================================================================
// Route coordinator — policy-gated relay <-> direct promotion over replay
// =====================================================================
// Layers are strictly separated: a connector is PURE transport (open/close, state,
// metrics, failures, capabilities); the coordinator is the single owner of route
// decisions (state machine + policy hooks); data continuity lives entirely in
// replayRouteSubscribe (catch-up by seq, dedupe, the old route stays alive until
// the new one is ready). Route optimization does NOT change authority/ACL/replay semantics:
// the consumer's facade API does not know which path envelopes travel by.
// WebRTC is deliberately not mentioned here: it is just another RouteConnector.

import {listen, Listener} from './Listen'
import {ReplayRemote} from './replay-wire'
import {replayRouteSubscribe, ReplayRouteSubscribeOpts} from './replay-route'

// =====================================================================
// Connector contract — what any transport must provide (socket, in-proc,
// WebRTC datachannel). No routing decisions at this level.
// =====================================================================

export type tRouteKind = 'relay' | 'direct'

export type tConnectorState = 'idle' | 'opening' | 'open' | 'closed' | 'failed'

export type RouteConnectorInfo = {
    /** Route label for events/diagnostics: 'relay', 'direct', 'direct+shadowRelay'... */
    label: string
    kind: tRouteKind
    /** Capabilities — facts for policy; coordinator doesn't enforce them. */
    binary?: boolean
    ordered?: boolean
    reliable?: boolean
}

export type RouteConnectorMetrics = {rtt?: number, pending?: number}

export type RouteConnector<Z extends any[] = any[]> = {
    info: RouteConnectorInfo
    /** Open transport and return replay-wire running through it. */
    open: () => Promise<ReplayRemote<Z>> | ReplayRemote<Z>
    close: () => void
    state: () => tConnectorState
    metrics?: () => RouteConnectorMetrics
    /** Transport failure (link died, endpoint revoked) — signal for fallback. */
    onFail?: {on: (cb: (reason?: unknown) => void) => any}
}

// =====================================================================
// Policy — routing business rules. Checked BEFORE transport actions.
// Missing hook = allowed (promoteDirect call itself is opt-in);
// provided hook must return true.
// =====================================================================

export type RoutePairRef = {a: string, b: string, key: string}

export type RoutePolicyCtx = RoutePairRef & {state: tRouteState, reason?: unknown}

type tPolicyHook = (ctx: RoutePolicyCtx) => boolean | Promise<boolean>

export type RoutePolicy = {
    /** Can a pair attempt to go direct at all. */
    canDirect?: tPolicyHook
    /** Forced relay (NDA/audit/moderation/reauth) — stronger than canDirect. */
    mustRelay?: tPolicyHook
    /** Direct payload path allowed, but relay keeps audit/observe copy. */
    mustShadowRelay?: tPolicyHook
    /** Can endpoint/session material be exposed to peer during signaling. */
    canExposeEndpoint?: tPolicyHook
    /** Can relay re-enter the path (re-interposition). */
    canReinterpose?: tPolicyHook
}

// =====================================================================
// Route state machine
// =====================================================================

export type tRouteState =
    | 'relay'
    | 'direct:connecting'
    | 'direct'
    | 'direct+shadowRelay'
    | 'relay:reinterposing'
    | 'fallback'
    | 'blocked'
    | 'closed'

export type RouteChangeEvent = RoutePairRef & {
    from: tRouteState
    to: tRouteState
    reason?: unknown
}

export type RouteOpResult = {ok: boolean, state: tRouteState, reason?: unknown}

export type PromoteDirectOpts = {
    /** Catch-up replacement limit: if it fails, old route stays, switch failed. */
    timeoutMs?: number
    /** Pass reason into policy-ctx and route-event. */
    reason?: unknown
}

export type RouteCoordinatorDeps<Z extends any[] = any[]> = {
    policy?: RoutePolicy
    /** Transport factory: how to obtain a connector of this kind for a pair. */
    connect: (ref: RoutePairRef, kind: tRouteKind) => RouteConnector<Z>
    /** Audit/observe copy for direct+shadowRelay: events of the pair's relay line. */
    shadow?: (ref: RoutePairRef, ...ev: Z) => void
    /** Default timeoutMs for promoteDirect. */
    catchUpTimeoutMs?: number
}

type RouteSub = ReturnType<typeof replayRouteSubscribe<any>>

// unsubscribe handle is either a function (Listen) or object (wire SubscriptionHandle)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Lazy ReplayRemote over connector.open(): subscriptions/requests valid immediately,
 * transport raised once on first use. open error bubbles through catch-up (switch fails,
 * old route stays alive).
 */
function lazyRemote<Z extends any[]>(connector: RouteConnector<Z>): ReplayRemote<Z> {
    let opened: Promise<ReplayRemote<Z>> | null = null
    const get = () => opened ??= Promise.resolve(connector.open())
    function lazyLine(pick: (r: ReplayRemote<Z>) => {on: (cb: any) => any}) {
        return {
            on(cb: (ev: any) => void) {
                let off: any = null
                let dead = false
                get().then(function attachLazyLine(r) { if (!dead) off = pick(r).on(cb) },
                    function swallowOpenError() {})
                return function offLazyLine() { dead = true; unsubscribeHandle(off) }
            },
        }
    }
    return {
        line: lazyLine(r => r.line),
        // policy 'frame' honestly fails over to line when the transport gives no frameLine
        frameLine: lazyLine(r => r.frameLine ?? r.line),
        since: async seq => (await get()).since(seq),
        keyframe: async () => (await get()).keyframe(),
        frame: async (seq, hint) => {
            const r = await get()
            return r.frame ? r.frame(seq, hint) : null
        },
    }
}

/**
 * Route coordinator for account pairs: relay -> direct promotion, shadow relay,
 * re-interposition, fallback, block — a policy-driven state machine on top of
 * pure connectors. Consumer data travels through replayRouteSubscribe, so any
 * route switch is gap-free by the seq contract.
 */
export function createRouteCoordinator<Z extends any[] = any[]>(deps: RouteCoordinatorDeps<Z>) {
    const {policy = {}, connect, shadow, catchUpTimeoutMs} = deps
    const links = new Map<string, Link>()
    const [emitRoute, routeListen] = listen<[RouteChangeEvent]>()

    async function allowed(hook: tPolicyHook | undefined, ctx: RoutePolicyCtx, absent = true) {
        return hook ? !!(await hook(ctx)) : absent
    }

    function pairKey(a: string, b: string) {
        return a <= b ? a + '|' + b : b + '|' + a
    }

    // =================================================================
    // Link — state and operations of one pair
    // =================================================================
    function createLink(a: string, b: string) {
        const ref: RoutePairRef = {a, b, key: pairKey(a, b)}
        let state: tRouteState = 'relay'
        let lastReason: unknown
        let relayConn: RouteConnector<Z> | null = null
        let relayRemote: ReplayRemote<Z> | null = null
        let directConn: RouteConnector<Z> | null = null
        let directRemote: ReplayRemote<Z> | null = null
        let shadowSub: RouteSub | null = null
        const subs = new Set<RouteSub>()
        // route operations serialized: promote during reinterpose impossible
        let opChain: Promise<unknown> = Promise.resolve()

        function chained<T>(run: () => Promise<T>) {
            const p = opChain.then(run, run)
            opChain = p.catch(() => {})
            return p
        }

        function setState(to: tRouteState, reason?: unknown) {
            if (state == 'closed') return // close is synchronous and terminal: in-flight ops tails silent
            const from = state
            state = to
            lastReason = reason
            emitRoute({...ref, from, to, reason})
        }

        function ctx(reason?: unknown): RoutePolicyCtx {
            return {...ref, state, reason}
        }

        function ensureRelay() {
            if (!relayConn || relayConn.state() == 'closed' || relayConn.state() == 'failed') {
                relayConn = connect(ref, 'relay')
                relayRemote = lazyRemote(relayConn)
                watchFail(relayConn, 'relay')
            }
            return relayRemote!
        }

        function watchFail(conn: RouteConnector<Z>, kind: tRouteKind) {
            conn.onFail?.on(function onConnectorFail(reason?: unknown) {
                if (kind == 'relay') {
                    // relay reconnect — transport's responsibility; coordinator only needs the signal
                    if (conn == relayConn) emitRoute({...ref, from: state, to: state, reason})
                    return
                }
                // endpoint revoke/direct link death: close direct, fall back to relay with seq
                if (conn == directConn && (state == 'direct' || state == 'direct+shadowRelay')) {
                    demoteToRelay('fallback', reason).catch(() => {})
                }
            })
        }

        function currentRemote() {
            const direct = (state == 'direct' || state == 'direct+shadowRelay') && directRemote
            return direct || ensureRelay()
        }

        function currentLabel() {
            const direct = (state == 'direct' || state == 'direct+shadowRelay') && directConn
            return direct ? directConn!.info.label : (relayConn?.info.label ?? 'relay')
        }

        async function switchSubs(remote: ReplayRemote<Z>, label: string, timeoutMs?: number) {
            const jobs = Array.from(subs, function switchOne(sub) { return sub.switch(remote, {label}) })
            if (timeoutMs == null) return Promise.all(jobs)
            let timer: any
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(function catchUpTimeout() {
                    reject(new Error('route catch-up timeout: ' + label))
                }, timeoutMs)
            })
            try { await Promise.race([Promise.all(jobs), timeout]) }
            finally { clearTimeout(timer) }
        }

        // subscriptions added during a switch are brought up to the current route
        function resyncStraySubs() {
            const remote = currentRemote()
            const label = currentLabel()
            for (const sub of subs) {
                if (sub.label() != label) sub.switch(remote, {label}).catch(() => {})
            }
        }

        function attachShadow() {
            if (!shadow || shadowSub) return
            // audit copy pinned to relay and does NOT participate in promotion. Starts
            // from consumer seq coordinate: window between direct switch and shadow
            // startup doesn't drop out of audit (else keyframe eats it)
            const since = subs.size ? Math.min(...Array.from(subs, sub => sub.seq())) : -1
            shadowSub = replayRouteSubscribe<Z>(ensureRelay(),
                function shadowTap(...ev: Z) { shadow(ref, ...ev) },
                {label: 'shadowRelay', since})
        }

        function dropShadow() {
            shadowSub?.()
            shadowSub = null
        }

        function closeDirect() {
            dropShadow()
            directConn?.close()
            directConn = null
            directRemote = null
        }

        async function demoteToRelay(finalState: 'relay' | 'fallback', reason?: unknown) {
            return chained(async function demoteOp(): Promise<RouteOpResult> {
                if (state == 'blocked' || state == 'closed') return {ok: false, state, reason: state}
                if (state != 'direct' && state != 'direct+shadowRelay') {
                    if (finalState == 'fallback') setState('fallback', reason)
                    return {ok: true, state}
                }
                if (finalState == 'relay' && !(await allowed(policy.canReinterpose, ctx(reason)))) {
                    return {ok: false, state, reason: 'policy: canReinterpose'}
                }
                setState('relay:reinterposing', reason)
                const remote = ensureRelay()
                try {
                    await switchSubs(remote, relayConn!.info.label)
                    closeDirect()
                    setState(finalState, reason)
                    resyncStraySubs()
                    return {ok: true, state}
                } catch (e) {
                    // relay didn't catch up: stay on live direct, fallback failed
                    setState(shadowSub ? 'direct+shadowRelay' : 'direct', e)
                    return {ok: false, state, reason: e}
                }
            })
        }

        async function promoteDirect(opts: PromoteDirectOpts = {}) {
            return chained(async function promoteOp(): Promise<RouteOpResult> {
                const {timeoutMs = catchUpTimeoutMs, reason} = opts
                if (state == 'blocked' || state == 'closed') return {ok: false, state, reason: state}
                if (state == 'direct' || state == 'direct+shadowRelay') return {ok: true, state}
                // policy strictly BEFORE transport: if denied, direct doesn't even try opening
                if (await allowed(policy.mustRelay, ctx(reason), false)) {
                    return {ok: false, state, reason: 'policy: mustRelay'}
                }
                if (!(await allowed(policy.canDirect, ctx(reason)))) {
                    return {ok: false, state, reason: 'policy: canDirect'}
                }
                if (!(await allowed(policy.canExposeEndpoint, ctx(reason)))) {
                    return {ok: false, state, reason: 'policy: canExposeEndpoint'}
                }
                const wantShadow = await allowed(policy.mustShadowRelay, ctx(reason), false)
                setState('direct:connecting', reason)
                const conn = connect(ref, 'direct')
                const remote = lazyRemote(conn)
                try {
                    await switchSubs(remote, conn.info.label, timeoutMs)
                    directConn = conn
                    directRemote = remote
                    watchFail(conn, 'direct')
                    if (wantShadow) {
                        setState('direct+shadowRelay', reason)
                        attachShadow()
                    } else {
                        // direct without shadow: relay exits path entirely
                        relayConn?.close()
                        relayConn = null
                        relayRemote = null
                        setState('direct', reason)
                    }
                    resyncStraySubs()
                    return {ok: true, state}
                } catch (e) {
                    // failure/timeout: roll back any partial switches to relay,
                    // close direct; data was flowing through live relay the whole time
                    conn.close()
                    try { await switchSubs(ensureRelay(), relayConn!.info.label) } catch {}
                    setState('fallback', e)
                    return {ok: false, state, reason: e}
                }
            })
        }

        function block(reason?: unknown) {
            return chained(async function blockOp(): Promise<RouteOpResult> {
                if (state == 'closed') return {ok: false, state, reason: state}
                closeDirect()
                relayConn?.close()
                relayConn = null
                relayRemote = null
                for (const sub of Array.from(subs)) sub()
                subs.clear()
                setState('blocked', reason)
                return {ok: true, state}
            })
        }

        function subscribe(cb: Listener<Z>, opts: Omit<ReplayRouteSubscribeOpts, 'label'> = {}) {
            if (state == 'blocked' || state == 'closed') {
                throw new Error('route coordinator: pair ' + ref.key + ' is ' + state)
            }
            const sub = replayRouteSubscribe<Z>(currentRemote(), cb, {...opts, label: currentLabel()})
            subs.add(sub)
            function off() {
                subs.delete(sub)
                sub()
            }
            return Object.assign(off, {
                ready: sub.ready,
                seq: sub.seq,
                label: sub.label,
                active: sub.active,
            })
        }

        // synchronous terminal teardown: in-flight ops finish silently
        function close() {
            if (state == 'closed') return
            closeDirect()
            relayConn?.close()
            relayConn = null
            relayRemote = null
            for (const sub of Array.from(subs)) sub()
            subs.clear()
            links.delete(ref.key)
            setState('closed')
        }

        const link = {
            ref,
            state: () => state,
            reason: () => lastReason,
            /** Active data-path label of the route. */
            label: currentLabel,
            /** Transport diagnostics: policy/UI reads facts, doesn't decide for coordinator. */
            metrics: () => ({
                relay: relayConn ? {state: relayConn.state(), ...relayConn.metrics?.()} : null,
                direct: directConn ? {state: directConn.state(), ...directConn.metrics?.()} : null,
            }),
            /** Pair data: replay stream surviving any route changes. */
            subscribe,
            promoteDirect,
            reinterposeRelay: (reason?: unknown) => demoteToRelay('relay', reason),
            fallback: (reason?: unknown) => demoteToRelay('fallback', reason),
            block,
            close,
        }
        return link
    }

    type Link = ReturnType<typeof createLink>

    function resolve(pairOrKey: Link | RoutePairRef | string) {
        const key = typeof pairOrKey == 'string' ? pairOrKey
            : 'ref' in pairOrKey ? pairOrKey.ref.key : pairOrKey.key
        const link = links.get(key)
        if (!link) throw new Error('route coordinator: unknown pair ' + key)
        return link
    }

    // =================================================================
    // api — outward-facing
    // =================================================================
    return {
        /** Get/create pair link (symmetric key: pair(a,b) == pair(b,a)). */
        pair(a: string, b: string) {
            const key = pairKey(a, b)
            let link = links.get(key)
            if (!link || link.state() == 'closed') {
                link = createLink(a, b)
                links.set(key, link)
            }
            return link
        },
        state: (pairOrKey: Link | RoutePairRef | string) => resolve(pairOrKey).state(),
        promoteDirect: (pairOrKey: Link | RoutePairRef | string, opts?: PromoteDirectOpts) =>
            resolve(pairOrKey).promoteDirect(opts),
        reinterposeRelay: (pairOrKey: Link | RoutePairRef | string, reason?: unknown) =>
            resolve(pairOrKey).reinterposeRelay(reason),
        fallback: (pairOrKey: Link | RoutePairRef | string, reason?: unknown) =>
            resolve(pairOrKey).fallback(reason),
        block: (pairOrKey: Link | RoutePairRef | string, reason?: unknown) =>
            resolve(pairOrKey).block(reason),
        /** Route transition events for all pairs — for metrics/UI/policy wrappers. */
        onRoute: (cb: (ev: RouteChangeEvent) => void) => routeListen.on(cb),
        pairs: () => Array.from(links.values()),
        close() {
            for (const link of Array.from(links.values())) link.close()
        },
    }
}

export type RouteCoordinator<Z extends any[] = any[]> = ReturnType<typeof createRouteCoordinator<Z>>
export type RouteLink<Z extends any[] = any[]> = ReturnType<RouteCoordinator<Z>['pair']>
