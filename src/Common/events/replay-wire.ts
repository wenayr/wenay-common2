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

import {Listener, NormalizeTuple} from './Listen3'
import {ListenReplayApi, ReplayEvent, StaleInfo} from './replay-listen'
import {conflateReplay, ConflateOpts} from './replay-conflate'

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
     * Политика лага — выбор ПОТРЕБИТЕЛЯ: 'queue' (default, сегодняшнее поведение —
     * сокет буферизует всё, ничего не пропускается) | 'frame' (сервер вправе пропустить
     * и восстановить кадром — подписка идёт на frameLine, если сервер её даёт).
     */
    policy?: 'queue' | 'frame'
    /** Opaque-подсказка frame-лямбде продьюсера (произвольные правила скипа). Провод не заглядывает. */
    hint?: unknown
}

// хендл отписки бывает функцией (Listen3) или объектом (SubscriptionHandle провода)
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
    const {since = -1, onSeq, onError, staleMs, onStale, skewMs = 0, now = Date.now, policy = 'queue', hint} = opts
    let lastDelivered = since
    let replaying = true
    let closed = false
    const queue: ReplayEvent<Z>[] = []

    // === staleness watchdog ===
    // Arrival gap — единственный таймер; взведён с момента подписки (мёртвый при
    // коннекте продьюсер обязан дать stale). Возраст ts — предикат при доставке:
    // тухлый keyframe репортится сразу, а исторический хвост since-catch-up НЕ
    // оценивается по событию (легитимно стар, флапал бы) — одна оценка после handover.
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
    // одноразовый таймер, перевзводится на остаток: доставка лишь пишет lastArrival
    function checkArrivalGap() {
        staleTimer = null
        if (closed) return
        const gap = now() - lastArrival
        if (gap >= staleMs!) { if (!staleFlag) reportStale(true) }  // молчание; fresh-грань даст доставка
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
        if (tsStale) stopStaleTimer()          // до следующей доставки будить некого
        else armStaleTimer(staleMs)            // no-op при живом таймере
    }
    armStaleTimer(staleMs!)                    // no-op без onStale/staleMs

    function deliver(ev: ReplayEvent<Z>) {
        if (closed || ev.seq <= lastDelivered) return
        lastDelivered = ev.seq
        lastTs = ev.ts
        lastArrival = now()
        cb(...ev.event)
        onSeq?.(ev.seq)
        if (!replaying) assessStale()
    }
    // политика 'frame' — подписка на гейтуемую линию (сервер вправе пропускать,
    // восстанавливая кадром); старый сервер без frameLine → обычная line (queue-семантика)
    const liveLine = policy == 'frame' && remote.frameLine ? remote.frameLine : remote.line
    const handle = liveLine.on(function liveTap(ev: ReplayEvent<Z>) {
        if (ev == null || typeof (ev as any).seq != 'number') {
            // не-конверт = конец стрима с сервера (RPC_STOP; напр. громкий отказ священной
            // линии в воротах). Молчать нельзя: наружу и закрываемся; seq() сохранён для реконнекта.
            if (closed) return
            const err = new Error('replaySubscribe: line ended by server (' + String(ev) + ')')
            off()
            if (onError) onError(err)
            else setTimeout(function rethrowLineEnd() { throw err }, 0)
            return
        }
        lastArrival = now()                    // конверт ПОЛУЧЕН — провод жив, даже если ждёт очереди
        if (replaying) queue.push(ev)
        else deliver(ev)
    })
    async function catchUp() {
        try {
            let done = false
            if (since >= 0 && remote.frame) {
                // один вызов: сервер сам выбрал хвост/мини-кадр/keyframe (frame из replay-listen);
                // священная линия с вытесненным журналом — rejected promise → onError (громко)
                const envs = await remote.frame(since, hint)
                if (closed) return
                if (envs) {
                    if (envs.length) {
                        // новая точка отсчёта: сброс возможен и ВНИЗ («другая жизнь» сервера)
                        lastDelivered = envs[0].seq - 1
                        for (const ev of envs) deliver(ev)
                    }
                    done = true
                }
            }
            if (!done) {
                const tail = since >= 0 ? await remote.since(since) : null
                if (closed) return
                if (tail) {
                    for (const ev of tail) deliver(ev)
                } else {
                    const kf = await remote.keyframe()
                    if (closed) return
                    if (kf) {
                        // новая точка отсчёта (сброс возможен и ВНИЗ — «другая жизнь» сервера)
                        lastDelivered = kf.seq
                        lastTs = kf.ts
                        lastArrival = now()
                        cb(...kf.event)
                        onSeq?.(kf.seq)
                    }
                }
            }
        } catch (e) {
            if (onError) onError(e)
            else setTimeout(function rethrowCatchUp() { throw e }, 0)
        } finally {
            while (queue.length) deliver(queue.shift()!)
            replaying = false
            assessStale()                      // единственная ts-оценка catch-up: тухлый keyframe — сразу stale
        }
    }
    const ready = catchUp()
    function off() {
        if (closed) return
        closed = true
        stopStaleTimer()
        unsubscribeHandle(handle)
    }
    return Object.assign(off, {
        /** Дождаться конца catch-up (переключение на live состоялось). */
        ready,
        /** Последний доставленный seq — точка для переподключения через since. */
        seq: () => lastDelivered,
        /** Тухлость сейчас: ts-предикат последней доставки ИЛИ ленивый arrival gap. */
        isStale: () => staleFlag || (staleMs != null && now() - lastArrival >= staleMs),
        /** ts последнего доставленного конверта (0 = ещё не было). */
        lastTs: () => lastTs,
    })
}
