// =====================================================================
// Wire-пара replay-линии: exposeReplay (сервер) ⇄ replaySubscribe (клиент)
// =====================================================================
// RPC-ядро не трогаем ВООБЩЕ: line — обычный Listen (rpc-server-auto проксирует
// его как есть), since/keyframe — обычные методы. Handover replay→live на
// клиенте асинхронный (между запросом хвоста и ответом живут события) —
// та же очередь + дедуп по seq, что и в синхронном on({since}).
// Требование к транспорту: упорядоченность (socket.io/TCP, in-proc) — подписка
// на line устанавливается на сервере РАНЬШЕ, чем исполнится since() → дыры нет.

import {Listener} from './Listen3'
import {ListenReplayApi, ReplayEvent} from './replay-listen'

/** Провод-фасад replay-линии: спредится в объект RPC-сервера. */
export function exposeReplay<T>(replay: ListenReplayApi<T>) {
    return {
        line: replay.line,
        /** Хвост журнала после seq. null = вытеснено → клиент возьмёт keyframe. */
        since: (seq: number) => replay.getSince(seq) ?? null,
        /** Свежий keyframe + его seq. null = current-провайдер не задан. */
        keyframe: () => replay.keyframe() ?? null,
    }
}

/** Что клиент видит после RPC-проекции exposeReplay (методы стали async). */
export type ReplayRemote<Z extends any[] = any[]> = {
    line: {on: (cb: (ev: ReplayEvent<Z>) => void) => any}
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null | undefined> | ReplayEvent<Z>[] | null | undefined
    keyframe: () => Promise<ReplayEvent<Z> | null | undefined> | ReplayEvent<Z> | null | undefined
}

export type ReplaySubscribeOpts = {
    /** «У меня seq K». Меньше 0 / не задано = ничего нет → keyframe + live. */
    since?: number
    /** Репорт seq каждой доставки — хранить для переподключения. */
    onSeq?: (seq: number) => void
    onError?: (e: any) => void
}

// хендл отписки бывает функцией (Listen3) или объектом (tSubHandle провода)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Клиентский catch-up над ReplayRemote: подписка на line СНАЧАЛА (живые события
 * копятся в очередь), потом хвост since(K) — или keyframe, если вытеснено/нечего, —
 * потом слив очереди и live. Возвращает off() c .ready (конец catch-up) и
 * .seq() (последний доставленный — для реконнекта).
 */
export function replaySubscribe<Z extends any[]>(remote: ReplayRemote<Z>, cb: Listener<Z>, opts: ReplaySubscribeOpts = {}) {
    const {since = -1, onSeq, onError} = opts
    let lastDelivered = since
    let replaying = true
    let closed = false
    const queue: ReplayEvent<Z>[] = []
    function deliver(ev: ReplayEvent<Z>) {
        if (closed || ev.seq <= lastDelivered) return
        lastDelivered = ev.seq
        cb(...ev.event)
        onSeq?.(ev.seq)
    }
    const handle = remote.line.on(function liveTap(ev: ReplayEvent<Z>) {
        if (replaying) queue.push(ev)
        else deliver(ev)
    })
    async function catchUp() {
        try {
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
                    cb(...kf.event)
                    onSeq?.(kf.seq)
                }
            }
        } catch (e) {
            if (onError) onError(e)
            else setTimeout(function rethrowCatchUp() { throw e }, 0)
        } finally {
            while (queue.length) deliver(queue.shift()!)
            replaying = false
        }
    }
    const ready = catchUp()
    function off() {
        if (closed) return
        closed = true
        unsubscribeHandle(handle)
    }
    return Object.assign(off, {
        /** Дождаться конца catch-up (переключение на live состоялось). */
        ready,
        /** Последний доставленный seq — точка для переподключения через since. */
        seq: () => lastDelivered,
    })
}
