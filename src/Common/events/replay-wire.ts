// =====================================================================
// Wire-пара replay-линии: exposeReplay (сервер) ⇄ replaySubscribe (клиент)
// =====================================================================
// RPC-ядро не трогаем ВООБЩЕ: line — обычный Listen (rpc-server-auto проксирует
// его как есть), since/keyframe — обычные методы. Handover replay→live на
// клиенте асинхронный (между запросом хвоста и ответом живут события) —
// та же очередь + дедуп по seq, что и в синхронном on({since}).
// Требование к транспорту: упорядоченность (socket.io/TCP, in-proc) — подписка
// на line устанавливается на сервере РАНЬШЕ, чем исполнится since() → дыры нет.
//
// Тухлость (staleMs/onStale): доставка КОНСИСТЕНТНА, но молчит о свежести — два
// режима отказа, которые провод сам по себе прячет: молчащая линия (продьюсер
// умер, конвертов нет) и тухлый keyframe (пришёл сейчас, а ts старый). Оба
// закрывает клиентский вотчдог: arrival gap — единственный таймер (локальные
// часы, расхождение клоков не важно), возраст ts конверта — предикат в момент
// доставки (часы продьюсера; допуск skewMs на расхождение).

import {Listener, NormalizeTuple} from './Listen'
import {ListenReplayApi, ReplayEvent, StaleInfo} from './replay-listen'
import {conflateReplay, ConflateOpts} from './replay-conflate'
import {getRpcMemberState, getRpcTransportLifecycle} from './transport-lifecycle'

/** Форма провода replay-линии — то, что спредится в объект RPC-сервера. */
export type ReplayExpose<T> = {
    line: ListenReplayApi<T>['line']
    since: (seq: number) => ReplayEvent<NormalizeTuple<T>>[] | null
    keyframe: () => ReplayEvent<NormalizeTuple<T>> | null
    frame: ListenReplayApi<T>['frame']
}

function exposeReplayPlain<T>(replay: ListenReplayApi<T>): ReplayExpose<T> {
    return {
        line: replay.line,
        /** Хвост журнала после seq. null = вытеснено → клиент возьмёт keyframe. */
        since: (seq: number) => replay.getSince(seq) ?? null,
        /** Свежий keyframe + его seq. null = current-провайдер не задан. */
        keyframe: () => replay.keyframe() ?? null,
        /** Кадр (см. replay-listen): компактный catch-up одним вызовом. Бросок (священная
         *  линия + вытеснение) едет клиенту rejected promise — громко by design. */
        frame: (seq: number, hint?: unknown) => replay.frame(seq, hint),
    }
}

/**
 * Провод-фасад replay-линии: спредится в объект RPC-сервера.
 *
 * С опцией conflate — то же самое, но line идёт через персональные ворота
 * conflateReplay (per-connection: pending() — буфер ЭТОГО клиента). close/stats —
 * для владельца соединения, В ОБЪЕКТ RPC НЕ КЛАСТЬ (станут удалённо вызываемыми):
 *     const {close, stats, ...api} = exposeReplay(replay, {conflate: {pending, highWater}})
 *     object = {...rest, replay: api}        // провод
 *     disconnect → close()                   // одна строка
 * Несколько каналов на одном соединении — по воротам на канал; pending обычно
 * общий (один socket-буфер).
 */
export function exposeReplay<T>(replay: ListenReplayApi<T>): ReplayExpose<T>
export function exposeReplay<T>(replay: ListenReplayApi<T>, opts: {conflate: ConflateOpts<NormalizeTuple<T>>}):
    ReplayExpose<T> & {close: () => void, stats: ReturnType<typeof conflateReplay<T>>['stats']}
export function exposeReplay<T>(replay: ListenReplayApi<T>, opts?: {conflate?: ConflateOpts<NormalizeTuple<T>>}) {
    if (!opts?.conflate) return exposeReplayPlain(replay)
    const gated = conflateReplay(replay, opts.conflate)
    return {...gated.api, close: gated.close, stats: gated.stats}
}

/** Что клиент видит после RPC-проекции exposeReplay (методы стали async). */
export type ReplayRemote<Z extends any[] = any[]> = {
    line: {on: (cb: (ev: ReplayEvent<Z>) => void) => any}
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined
    keyframe: () => Promise<ReplayEvent<Z> | null | undefined> | ReplayEvent<Z> | null | undefined
    /** (additive) Кадр: catch-up одним вызовом; предпочитается перед since/keyframe, когда сервер его даёт. */
    frame?: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined
    /** (additive) Push-линия политики 'frame': на лаге сервер может пропускать, восстанавливая кадром. */
    frameLine?: {on: (cb: (ev: ReplayEvent<Z>) => void) => any}
}

export type ReplaySubscribeOpts = {
    /** «У меня seq K». Меньше 0 / не задано = ничего нет → keyframe + live. */
    since?: number
    /** Репорт seq каждой доставки — хранить для переподключения. */
    onSeq?: (seq: number) => void
    onError?: (e: any) => void
    /** Конец КАЖДОГО успешного catch-up (initial и reconnect): линия снова live.
     *  Дополняет ready (только первый handover) — для статусов вида live/catching-up. */
    onLive?: () => void
    /** Порог тухлости, мс: и для arrival gap (молчание провода), и для возраста ts конверта. */
    staleMs?: number
    /**
     * Вотчдог тухлости: edge-triggered в ОБЕ стороны. Таймер (arrival gap) существует
     * только при заданном onStale; isStale()/lastTs() работают и без него. Требует staleMs.
     */
    onStale?: (info: StaleInfo) => void
    /** Допуск на расхождение часов продьюсер/клиент для ts-предиката (default 0). */
    skewMs?: number
    /** Локальные часы (по умолчанию Date.now) — подменяемы в тестах. */
    now?: () => number
    /**
     * Политика лага — выбор ПОТРЕБИТЕЛЯ: 'queue' (default: подключённый live-провод
     * не гейтится; catch-up всё равно может вернуть producer frame/keyframe) | 'frame'
     * (сервер вправе пропустить и восстановить кадром через frameLine, если она доступна).
     */
    policy?: 'queue' | 'frame'
    /** Opaque-подсказка frame-лямбде продьюсера (произвольные правила скипа). Провод не заглядывает. */
    hint?: unknown
}

// хендл отписки бывает функцией (Listen) или объектом (SubscriptionHandle провода)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Клиентский catch-up над ReplayRemote: подписка на line СНАЧАЛА (живые события
 * копятся в очередь), потом хвост since(K) — или keyframe, если вытеснено/нечего, —
 * потом слив очереди и live. Возвращает off() c .ready (конец catch-up),
 * .seq() (последний доставленный — для реконнекта), .isStale() и .lastTs().
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
        /** Дождаться конца первого успешного handover либо terminal error/teardown. */
        ready,
        /** Последний честно доставленный seq — reconnect никогда не продвигает его после gap-error. */
        seq: () => lastDelivered,
        /** Тухлость сейчас: ts-предикат последней доставки ИЛИ ленивый arrival gap. */
        isStale: () => staleFlag || (staleMs != null && now() - lastArrival >= staleMs),
        /** ts последнего доставленного конверта (0 = ещё не было). */
        lastTs: () => lastTs,
    })
}
