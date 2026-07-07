// =====================================================================
// conflateReplay — per-client conflation + snapshot recovery
// =====================================================================
// Ворота на replay-линии ОДНОГО клиента, серверная сторона. Пока исходящий
// буфер клиента ниже порога — конверты идут как есть; выше порога — дельты
// перестают отправляться СОВСЕМ (никакой очереди — killer property), клиент
// помечен «нужен keyframe»; буфер слился — свежий keyframe уходит ТЕМ ЖЕ
// конвертом линии, дельты продолжаются с его seq. Клиент не меняется вообще:
// replaySubscribe и так дедупит по seq, keyframe — событие того же типа
// (для стора — root-патч).
//
// Транспорт декоратор не знает: сигнал заполненности — лямбда pending()
// (для socket.io — например, socket.conn.writeBuffer.length). Единицы любые
// (байты, пакеты, кадры…), но у pending() и порогов — одни и те же.
//
// Схлопывание по ключу (opts.keyOf): пока клиент лагает, вместо чистого дропа
// держим карту «ключ → ПОСЛЕДНИЙ конверт»; буфер слился — уходит хвост из
// последних значений затронутых ключей (по возрастанию seq), а не полный
// keyframe. Тысяча тиков одного ключа = один конверт; большой стор не едет
// целиком из-за пары изменившихся ключей. Память ограничена числом ключей
// (maxKeys), не числом событий — killer property на месте. Корректность:
// событие обязано быть АБСОЛЮТНЫМ по своему ключу (полностью задавать его
// состояние, как store-патч по пути); порядок карты = порядок последних
// касаний = по seq, поэтому хвост — подпоследовательность линии, где каждый
// выброшенный конверт замаскирован более поздним с тем же ключом.
// Неключуемое событие (keyOf → null) или ключей больше maxKeys → эпизод
// деградирует до классического keyframe recovery — поэтому current-провайдер
// обязателен и в этом режиме.
//
// Строится PER-CONNECTION — там же, где создаётся rpc-сервер соединения:
//     const gated = conflateReplay(exposed.replay, {pending, highWater})
//     object = {...exposed.api, replay: gated.api}   // вместо exposeReplay
//     disconnect → gated.close()
// Однострочная альтернатива — exposeReplay(replay, {conflate: opts}) в replay-wire.

import {createListen, NormalizeTuple} from './Listen'
import {ListenReplayApi, ReplayEvent} from './replay-listen'

export type ConflateOpts<Z extends any[] = any[]> = {
    /** Заполненность исходящего буфера ЭТОГО клиента (единицы те же, что у порогов). */
    pending: () => number
    /** Вход в conflation: pending() > highWater → дельты для клиента останавливаются. */
    highWater: number
    /** Выход из conflation (default 0): pending() <= lowWater → keyframe + дельты дальше. */
    lowWater?: number
    /** Период опроса pending() в режиме conflation, мс (default 25) — восстановление и при тихой линии. */
    pollMs?: number
    /**
     * @deprecated Уплотнение переехало на линию: объявите `frame` в опциях
     * replayListen/withReplayListen (там же, где current) — его подхватят и эти ворота
     * (recovery через replay.frame), и авто-путь rpc-server-auto, и клиентский catch-up.
     * keyOf-механика (held-карта) остаётся рабочей для старых вызовов.
     *
     * Схлопывание по ключу: во время conflation хранится ПОСЛЕДНИЙ конверт каждого
     * ключа, восстановление = хвост этих конвертов вместо полного keyframe.
     * Событие обязано быть абсолютным по своему ключу (store-патч: storePatchKey).
     * null/undefined = событие не схлопывается → эпизод деградирует до keyframe.
     */
    keyOf?: (...event: Z) => PropertyKey | null | undefined
    /** @deprecated Вместе с keyOf. Потолок карты ключей эпизода (default 1024): больше → деградация до keyframe. */
    maxKeys?: number
}

export function conflateReplay<T>(replay: ListenReplayApi<T>, opts: ConflateOpts<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    const {pending, highWater, lowWater = 0, pollMs = 25, keyOf, maxKeys = 1024} = opts
    // без current-провайдера восстановиться нечем: дропнутые дельты стали бы молчаливой дырой
    if (!replay.hasKeyframe) throw new TypeError('conflateReplay: нужен current-провайдер (keyframe recovery)')

    // персональная линия конвертов этого клиента
    const gate = createListen<[ReplayEvent<Z>]>(() => {})
    gate.run()

    let conflating = false
    let closed = false
    let dropped = 0        // дельты, выброшенные целиком (схлопнутся в keyframe)
    let keyframes = 0      // восстановления полным keyframe
    let coalesced = 0      // конверты, поглощённые более поздним по тому же ключу
    let flushes = 0        // восстановления хвостом схлопнутых дельт (вместо keyframe)
    // карта эпизода схлопывания: ключ → последний конверт; null = keyframe-режим.
    // delete+re-insert при обновлении → порядок итерации = последние касания = по seq.
    let held: Map<PropertyKey, ReplayEvent<Z>> | null = null
    let timer: any = null

    function stopPoll() {
        if (timer) { clearInterval(timer); timer = null }
    }
    // опрос нужен, чтобы восстановиться и когда линия молчит (буфер слился, событий нет)
    function startPoll() {
        if (timer || closed) return
        timer = setInterval(recoverIfDrained, pollMs)
        timer.unref?.()
    }
    function recoverIfDrained() {
        if (!conflating || closed) return
        if (pending() > lowWater) return
        conflating = false
        stopPoll()
        if (held) {
            // восстановление хвостом: последние значения затронутых ключей, по возрастанию seq
            const tail = [...held.values()]
            held = null
            flushes++
            for (const ev of tail) gate.emit(ev)
            return
        }
        const kf = replay.keyframe()
        // kf.seq == head → дедуп клиента по seq сам вырежет перекрытие с дальнейшими дельтами
        if (kf) { keyframes++; gate.emit(kf as ReplayEvent<Z>) }
    }
    // поглотить конверт в карту эпизода; не схлопывается → деградация до keyframe-режима
    function absorb(ev: ReplayEvent<Z>) {
        const k = keyOf!(...ev.event)
        if (k == null || (!held!.has(k) && held!.size >= maxKeys)) {
            dropped += held!.size + 1
            held = null
            return
        }
        if (held!.delete(k)) coalesced++
        held!.set(k, ev)
    }
    const offLine = replay.line.on(function gateForward(ev: ReplayEvent<Z>) {
        if (closed) return
        if (!conflating && pending() > highWater) {
            conflating = true
            held = keyOf ? new Map() : null
            startPoll()
        }
        if (conflating) {
            if (held) {
                // поглотить ДО проверки осушения: если слился — хвост включает ЭТО событие
                absorb(ev)
                recoverIfDrained()
                return
            }
            // не ждать таймера: если слился — keyframe уже включает ЭТО событие (журнал пишется до fan-out)
            recoverIfDrained()
            if (conflating) dropped++
            return
        }
        gate.emit(ev)
    })

    function close() {
        if (closed) return
        closed = true
        held = null
        stopPoll()
        offLine()
        gate.close()
    }

    return {
        /** Провод-фасад ЭТОГО клиента: форма exposeReplay, но line — персональные ворота.
         *  Форма инлайнится (не импортируется), чтобы граф replay-wire → replay-conflate остался ацикличным. */
        api: {
            line: gate,
            since: (seq: number) => replay.getSince(seq) ?? null,
            keyframe: () => replay.keyframe() ?? null,
            frame: (seq: number, hint?: unknown) => replay.frame(seq, hint),
        },
        close,
        /** Интроспекция для метрик/тестов. */
        stats: () => ({conflating, dropped, keyframes, coalesced, flushes}),
    }
}
