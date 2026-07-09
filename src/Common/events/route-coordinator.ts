// =====================================================================
// Route coordinator — policy-gated relay <-> direct promotion over replay
// =====================================================================
// Слои разведены жёстко: коннектор — ЧИСТЫЙ транспорт (open/close, состояние,
// метрики, отказы, capabilities); координатор — единственный владелец решений
// о маршруте (state machine + policy-хуки); непрерывность данных — целиком
// replayRouteSubscribe (catch-up по seq, дедуп, старый маршрут жив до готовности
// нового). Оптимизация маршрута НЕ меняет authority/ACL/replay-семантику:
// facade-API потребителя не знает, каким путём едут конверты.
// WebRTC здесь не упоминается намеренно: это просто ещё один RouteConnector.

import {listen, Listener} from './Listen'
import {ReplayRemote} from './replay-wire'
import {replayRouteSubscribe, ReplayRouteSubscribeOpts} from './replay-route'

// =====================================================================
// Connector contract — то, что обязан дать любой транспорт (socket, in-proc,
// WebRTC datachannel). Никаких решений о маршруте на этом уровне.
// =====================================================================

export type tRouteKind = 'relay' | 'direct'

export type tConnectorState = 'idle' | 'opening' | 'open' | 'closed' | 'failed'

export type RouteConnectorInfo = {
    /** Метка маршрута для событий/диагностики: 'relay', 'direct', 'direct+shadowRelay'... */
    label: string
    kind: tRouteKind
    /** Capabilities — факты для policy, координатор их не форсит. */
    binary?: boolean
    ordered?: boolean
    reliable?: boolean
}

export type RouteConnectorMetrics = {rtt?: number, pending?: number}

export type RouteConnector<Z extends any[] = any[]> = {
    info: RouteConnectorInfo
    /** Установить транспорт и вернуть replay-провод, едущий по нему. */
    open: () => Promise<ReplayRemote<Z>> | ReplayRemote<Z>
    close: () => void
    state: () => tConnectorState
    metrics?: () => RouteConnectorMetrics
    /** Отказ транспорта (линк умер, endpoint отозван) — сигнал для fallback. */
    onFail?: {on: (cb: (reason?: unknown) => void) => any}
}

// =====================================================================
// Policy — бизнес-правила маршрутизации. Проверяются ДО транспортных действий.
// Отсутствующий хук = разрешено (сам вызов promoteDirect уже opt-in);
// заданный хук обязан вернуть true.
// =====================================================================

export type RoutePairRef = {a: string, b: string, key: string}

export type RoutePolicyCtx = RoutePairRef & {state: tRouteState, reason?: unknown}

type tPolicyHook = (ctx: RoutePolicyCtx) => boolean | Promise<boolean>

export type RoutePolicy = {
    /** Может ли пара вообще пытаться идти напрямую. */
    canDirect?: tPolicyHook
    /** Принудительный relay (NDA/audit/moderation/reauth) — сильнее canDirect. */
    mustRelay?: tPolicyHook
    /** Прямой payload-путь разрешён, но relay держит audit/observe-копию. */
    mustShadowRelay?: tPolicyHook
    /** Можно ли раскрывать peer'у endpoint/session-материал при сигналинге. */
    canExposeEndpoint?: tPolicyHook
    /** Может ли relay вернуться в путь (re-interposition). */
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
    /** Ограничение catch-up замены: не успела — старый маршрут остаётся, switch провален. */
    timeoutMs?: number
    /** Прокинуть причину в policy-ctx и route-событие. */
    reason?: unknown
}

export type RouteCoordinatorDeps<Z extends any[] = any[]> = {
    policy?: RoutePolicy
    /** Транспортная фабрика: как добыть коннектор данного вида для пары. */
    connect: (ref: RoutePairRef, kind: tRouteKind) => RouteConnector<Z>
    /** Audit/observe-копия для direct+shadowRelay: события relay-линии пары. */
    shadow?: (ref: RoutePairRef, ...ev: Z) => void
    /** Дефолт timeoutMs для promoteDirect. */
    catchUpTimeoutMs?: number
}

type RouteSub = ReturnType<typeof replayRouteSubscribe<any>>

// хендл отписки бывает функцией (Listen) или объектом (SubscriptionHandle провода)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Ленивый ReplayRemote поверх connector.open(): подписки/запросы валидны сразу,
 * транспорт поднимается один раз при первом использовании. Ошибка open всплывает
 * через catch-up (switch проваливается, старый маршрут остаётся жив).
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
        // policy 'frame' честно падает на line, если транспорт не даёт frameLine
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
 * Координатор маршрутов пар аккаунтов: relay -> direct promotion, shadow relay,
 * re-interposition, fallback, block — как policy-управляемая state machine поверх
 * чистых коннекторов. Данные потребителей едут через replayRouteSubscribe, поэтому
 * любой перевод маршрута gap-free по контракту seq.
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
    // Link — состояние и операции одной пары
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
        // операции маршрута сериализованы: promote во время reinterpose невозможен
        let opChain: Promise<unknown> = Promise.resolve()

        function chained<T>(run: () => Promise<T>) {
            const p = opChain.then(run, run)
            opChain = p.catch(() => {})
            return p
        }

        function setState(to: tRouteState, reason?: unknown) {
            if (state == 'closed') return // close синхронный и терминальный: хвосты in-flight операций молчат
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
                    // реконнект relay — забота транспорта; координатору важен только сигнал
                    if (conn == relayConn) emitRoute({...ref, from: state, to: state, reason})
                    return
                }
                // отзыв endpoint/смерть линка direct: закрыть direct, вернуться на relay с seq
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

        // подписки, добавленные во время переключения, доводим до текущего маршрута
        function resyncStraySubs() {
            const remote = currentRemote()
            const label = currentLabel()
            for (const sub of subs) {
                if (sub.label() != label) sub.switch(remote, {label}).catch(() => {})
            }
        }

        function attachShadow() {
            if (!shadow || shadowSub) return
            // audit-копия прибита к relay и НЕ участвует в promotion. Стартует
            // с seq-координаты потребителей: окно между переключением на direct
            // и подъёмом shadow не выпадает из аудита (иначе keyframe его съест)
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
                    // relay не догнал: остаёмся на живом direct, откат не состоялся
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
                // policy строго ДО транспорта: при отказе direct даже не пытается открыться
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
                        // direct без shadow: relay выходит из пути целиком
                        relayConn?.close()
                        relayConn = null
                        relayRemote = null
                        setState('direct', reason)
                    }
                    resyncStraySubs()
                    return {ok: true, state}
                } catch (e) {
                    // провал/таймаут: добить возможные полу-переключения обратно на relay,
                    // закрыть direct; данные всё это время шли по живому relay
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

        // синхронный терминальный teardown: in-flight операции доработают вхолостую
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
            /** Метка активного data-path маршрута. */
            label: currentLabel,
            /** Диагностика транспорта: policy/UI читают факты, не решают за координатор. */
            metrics: () => ({
                relay: relayConn ? {state: relayConn.state(), ...relayConn.metrics?.()} : null,
                direct: directConn ? {state: directConn.state(), ...directConn.metrics?.()} : null,
            }),
            /** Данные пары: replay-поток, переживающий любые смены маршрута. */
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
    // api — наружу
    // =================================================================
    return {
        /** Получить/создать link пары (симметричный ключ: pair(a,b) == pair(b,a)). */
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
        /** События переходов маршрута всех пар — для метрик/UI/policy-оболочек. */
        onRoute: (cb: (ev: RouteChangeEvent) => void) => routeListen.on(cb),
        pairs: () => Array.from(links.values()),
        close() {
            for (const link of Array.from(links.values())) link.close()
        },
    }
}

export type RouteCoordinator<Z extends any[] = any[]> = ReturnType<typeof createRouteCoordinator<Z>>
export type RouteLink<Z extends any[] = any[]> = ReturnType<RouteCoordinator<Z>['pair']>
