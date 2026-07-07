// =====================================================================
// withReplayListen — keyframe (snapshot) + нумерованная линия дельт
// =====================================================================
// Декоратор над ListenApi по форме withStoreListen. Один паттерн для
// всего: keyframe + события S+1…K = точное состояние на K (I/P-кадры, WAL,
// market data). Дизайн: REPLAY-PLAN.md; оракулы: replay/ (песочница).
//
// Инварианты:
// - seq — координата, время — атрибут: каждое событие журнала = {seq, ts, event}.
// - Отстающий подписчик НИКОГДА не получает бэклог-очередь: журнал вытеснен →
//   свежий keyframe + live от него. Это и catch-up, и backpressure.
// - Память внешняя по желанию: журнал либо внутреннее кольцо (history: N),
//   либо внешние лямбды (getSince + onJournal) — декоратор данными не владеет.
// - Keyframe — событие ТОГО ЖЕ типа (полное состояние как одно событие) —
//   поэтому current-провайдер store-слоя переиспользуется как есть.
//
// ВАЖНО: в журнал попадают только события, эмитированные через ДЕКОРИРОВАННЫЙ
// emit (он нумерует). replayListen отдаёт правильный emit сам.

import {
    createListen, registerListenOn,
    Listener, ListenApi, ListenCurrent, ListenCurrentProvider, ListenOnBrand, ListenOptions, NormalizeTuple,
} from './Listen'

type key = string | symbol
type cbClose = () => void

// Бренд replay-линии (Symbol.for — переживает дубли модуля src/dist). Нужен проводу:
// replay-api структурно проходит isListenCallback, поэтому автодетекция в rpc-server-auto
// обязана проверять бренд, а не форму. Читать через hasOwnProperty (конвенция rpc-гуарда).
export const IS_REPLAY_LISTEN = Symbol.for('isReplayListen')
/** Является ли значение replay-линией (бренд, не структурный снифф). */
export function isReplayListen(obj: any): obj is ListenReplayApi<any> {
    return !!obj && typeof obj == 'object' && Object.prototype.hasOwnProperty.call(obj, IS_REPLAY_LISTEN)
}

/** Единица журнала: seq — монотонная координата, ts — атрибут для людей. */
export type ReplayEvent<Z extends any[] = any[]> = { seq: number, ts: number, event: Z }

/** Отчёт вотчдога тухлости: stale — новое состояние (edge), lastTs — ts последнего события, age — его возраст. */
export type StaleInfo = {stale: boolean, lastTs: number, age: number}

export type ReplayListenOptions<Z extends any[]> = {
    /**
     * Поставщик keyframe (полное состояние как событие того же типа). Нужен для fallback и {current}.
     * `'last'` — сахар для одно-сущностных линий: keyframe = последнее журнальное событие
     * (последний тик и есть полное состояние); продьюсер не хранит его руками.
     */
    current?: ListenCurrentProvider<Z> | 'last'
    /**
     * Уплотнитель кадра (accumulation mini-frame): получает точный хвост журнала после seq,
     * возвращает состояние-эквивалентный компакт (последнее-на-сущность, агрегат дыры и т.п.).
     * Семантику события знает только продьюсер — транспорт этих лямбд не видит.
     * hint — сквозной opaque от подписчика (произвольные правила скипа), провод не заглядывает.
     */
    frame?: (tail: ReplayEvent<Z>[], hint?: unknown) => ReplayEvent<Z>[]
    /** Внутренний журнал: кольцо на N последних событий. */
    history?: number
    /**
     * Внешний журнал (память снаружи — предпочтительно): события с seq > указанного,
     * по порядку. undefined = вытеснено (слишком старый seq) → fallback на keyframe.
     * Имеет приоритет над history.
     */
    getSince?: (seq: number) => ReplayEvent<Z>[] | undefined
    /** Хук записи во внешний журнал: вызывается на каждый пронумерованный emit. */
    onJournal?: (ev: ReplayEvent<Z>) => void
    /** Часы для ts (по умолчанию Date.now) — подменяемы в тестах/на внешнем клоке. */
    now?: () => number
    /**
     * Порог тухлости: нет журнального события дольше staleMs → линия stale.
     * Сам по себе таймера НЕ создаёт — isStale() считается лениво.
     */
    staleMs?: number
    /**
     * Вотчдог тухлости: edge-triggered в ОБЕ стороны (fresh→stale и stale→fresh),
     * не повторяющийся будильник. Таймер существует только при заданном onStale
     * и взводится после первого события — холодная линия свободна. Требует staleMs.
     */
    onStale?: (info: StaleInfo) => void
}

type ReplayOnOptions<Z extends any[]> = {
    cbClose?: cbClose
    key?: key
    /** Store-слой как был: keyframe + live. */
    current?: ListenCurrent<Z>
    /** Catch-up: «у меня seq K» → replay журнала с K+1, бесшовный переход на live. */
    since?: number
    /** Репорт seq каждого доставленного события — чтобы потребитель мог переподключаться через since. */
    onSeq?: (seq: number) => void
}

export type ListenOnReplay<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: ReplayOnOptions<Z>) => (() => void)) & ListenOnBrand<Z>

export function withReplayListen<T>(base: ListenApi<T>, options: ReplayListenOptions<NormalizeTuple<T>> = {}) {
    type Z = NormalizeTuple<T>
    const {current: currentOpt, frame: condense, history = 0, getSince, onJournal, now = Date.now, staleMs, onStale} = options
    // 'last' — keyframe из последнего журнального события: одно-сущностная линия,
    // последний тик = полное состояние. lastEv пишется в нумерующем emit ниже.
    let lastEv: ReplayEvent<Z> | undefined
    const current: ListenCurrentProvider<Z> | undefined =
        currentOpt == 'last' ? () => lastEv?.event : currentOpt

    // === журнал ===
    let head = 0
    // кольцо фиксированного размера: слот события seq = (seq-1) % history
    const ring: ReplayEvent<Z>[] = []
    // событие текущего синхронного fan-out: liveTap подписчика узнаёт seq без
    // envelope-протокола. save/restore → переживает re-entrant emit.
    let emitting: ReplayEvent<Z> | null = null
    // линия конвертов {seq, ts, event} — обычный Listen: провод проксирует его как есть
    const line = createListen<[ReplayEvent<Z>]>(() => {})
    line.run()

    function journalSince(seq: number) {
        if (getSince) return getSince(seq)
        // seq из будущего (другая жизнь сервера) — журналу не верить, только keyframe
        if (seq > head) return undefined
        if (seq == head) return [] as ReplayEvent<Z>[]
        const oldest = Math.max(1, head - history + 1)
        if (seq + 1 < oldest) return undefined
        const out: ReplayEvent<Z>[] = []
        for (let s = seq + 1; s <= head; s++) out.push(ring[(s - 1) % history])
        return out
    }

    function currentValue(c?: ListenCurrent<Z>) {
        if (typeof c == 'function') return c()
        return c ? current?.() : undefined
    }

    // === staleness watchdog ===
    // isStale()/lastTs() — ленивые, таймера не создают. Таймер существует ТОЛЬКО
    // при onStale (иначе edge некому отдать) и взводится после первого события —
    // холодная линия не держит ни таймера, ни процесса (unref).
    let lastTs = 0
    let staleFlag = false
    let staleTimer: any = null
    function stopStaleTimer() {
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    }
    function reportStale(stale: boolean) {
        staleFlag = stale
        try { onStale!({stale, lastTs, age: now() - lastTs}) }
        catch (e) { setTimeout(function rethrowOnStale() { throw e }, 0) }
    }
    // одноразовый таймер, перевзводится на остаток: событие лишь пишет lastTs,
    // таймер не трогает — высокочастотная линия не платит за перевзвод
    function checkStale() {
        staleTimer = null
        const age = now() - lastTs
        if (age >= staleMs!) reportStale(true)   // stale-грань; fresh-грань даст следующий emit
        else armStaleTimer(staleMs! - age)
    }
    function armStaleTimer(delay: number) {
        if (staleTimer || !onStale || staleMs == null) return
        staleTimer = setTimeout(checkStale, delay)
        staleTimer.unref?.()
    }
    function touchStale(ts: number) {
        lastTs = ts
        if (staleFlag) reportStale(false)        // stale→fresh: линия ожила
        armStaleTimer(staleMs!)                  // no-op без onStale/staleMs или при живом таймере
    }

    const api = {
        ...base,
        /** Нумерующий emit: seq++, запись в журнал, fan-out. Единственная дверь в журнал. */
        emit: function emitJournaled(...e: Z) {
            const ev: ReplayEvent<Z> = {seq: ++head, ts: now(), event: e}
            if (history > 0) ring[(ev.seq - 1) % history] = ev
            if (currentOpt == 'last') lastEv = ev
            onJournal?.(ev)
            touchStale(ev.ts)  // fresh-грань ПЕРЕД fan-out: подписчик видит «линия ожила», потом событие
            // линия ПЕРЕД локальным fan-out: бросок локального cb не оставит провод без события
            line.emit(ev)
            const prev = emitting
            emitting = ev
            try { base.emit(...e) } finally { emitting = prev }
        } as Listener<Z>,
        /** Текущая голова линии (seq последнего события; 0 = ещё не было). */
        head: () => head,
        /** Ленивая тухлость: staleMs задан, было хотя бы одно событие и оно старше staleMs. Таймера не требует. */
        isStale: () => staleMs != null && head > 0 && now() - lastTs >= staleMs,
        /** ts последнего журнального события (0 = ещё не было). */
        lastTs: () => lastTs,
        /** close базы + снятие таймера вотчдога (если был). */
        close: function closeReplay() { stopStaleTimer(); base.close() },
        /** Хвост журнала после seq (или undefined = вытеснено). Для store-слоя / интроспекции. */
        getSince: journalSince,
        /** Линия конвертов {seq, ts, event} — для провода (exposeReplay) и внешних журналов. */
        line,
        /** Задан ли current-провайдер — возможно ли восстановление свежим keyframe (fallback, conflation). */
        hasKeyframe: current != null,
        /** Свежий keyframe с его координатой: состояние на момент head. */
        keyframe: () => {
            const m = current?.()
            return m ? {seq: head, ts: now(), event: m} as ReplayEvent<Z> : undefined
        },
        /**
         * Кадр: конверты, доводящие потребителя с sinceSeq до head, настолько компактно,
         * насколько линия умеет. Единственный метод для трёх триггеров: reconnect (since),
         * клиентский pull (свой темп) и осушение серверных ворот после лага.
         * Дефолт: точный хвост журнала (через уплотнитель, если объявлен) ?? keyframe.
         * Священная линия (ни frame, ни current) с вытесненным журналом — ГРОМКИЙ отказ:
         * молча выдумывать нечего, потеря событий на такой линии запрещена.
         */
        frame: function frameSince(sinceSeq: number, hint?: unknown) {
            const tail = journalSince(sinceSeq)
            if (tail) return condense ? condense(tail, hint) : tail
            const m = current?.()
            if (m) return [{seq: head, ts: now(), event: m} as ReplayEvent<Z>]
            throw new Error(`replay frame(${sinceSeq}): journal evicted and no keyframe (sacred line)`)
        },
        on: ((cb: Listener<Z>, {cbClose, key, current: cur, since, onSeq}: ReplayOnOptions<Z> = {}) => {
            if (since == null) {
                // режимы без replay-журнала — как в store-слое
                const off = base.on(cb, {cbClose, key})
                if (cur) {
                    const m = currentValue(cur)
                    if (m) cb(...m)
                }
                return off
            }
            // === catch-up: единственное тонкое место — handover replay→live ===
            // Порядок: подписка на live СНАЧАЛА (события во время replay копятся в
            // очередь по seq), потом replay хвоста, потом слив очереди. Дедуп —
            // строгим сравнением seq, поэтому ни дыры, ни дубля.
            let lastDelivered = since
            let replaying = true
            const queue: ReplayEvent<Z>[] = []
            function deliver(ev: ReplayEvent<Z>) {
                if (ev.seq <= lastDelivered) return
                lastDelivered = ev.seq
                cb(...ev.event)
                onSeq?.(ev.seq)
            }
            const off = base.on(function liveTap(...e: Z) {
                const ev = emitting
                if (ev == null) { cb(...e); return }  // событие мимо журнала — отдаём как есть, без seq
                if (replaying) queue.push(ev)
                else deliver(ev)
            }, {cbClose, key})
            const tail = journalSince(since)
            if (tail) {
                for (const ev of tail) deliver(ev)
            } else {
                // журнал вытеснен → свежий keyframe + линия от него (killer property:
                // никакого бэклога — новая точка отсчёта). Сброс возможен и ВНИЗ:
                // seq «из другой жизни» сервера не должен глушить живые события.
                const m = current?.()
                lastDelivered = head
                if (m) {
                    cb(...m)
                    onSeq?.(head)
                }
            }
            // re-entrant emit'ы во время replay — доводим той же дедуп-логикой
            while (queue.length) deliver(queue.shift()!)
            replaying = false
            return off
        }) as ListenOnReplay<Z>,
        once: (cb: Listener<Z>, opts: {key?: key, current?: ListenCurrent<Z>} = {}) => {
            // паритет со store-слоем: current при once — replay текущего значения и есть событие
            if (opts.current) {
                const m = currentValue(opts.current)
                if (m) { cb(...m); return () => {} }
            }
            let off: () => void = () => {}
            off = base.on(((...e: Z) => { off(); cb(...e) }), {key: opts.key})
            return off
        },
    }
    // бренд для провода: автодетекция в rpc-server-auto — по нему, не по форме
    Object.defineProperty(api, IS_REPLAY_LISTEN, {value: true})
    registerListenOn(api.on, api)
    return api
}
export type ListenReplayApi<T> = ReturnType<typeof withReplayListen<T>>

export type ReplayListenUseOptions<T> = ListenOptions<T> & ReplayListenOptions<NormalizeTuple<T>>

/** [emit, listen]: emit нумерует и журналирует (идёт через декоратор, не мимо). */
export function replayListen<T>(options: ReplayListenUseOptions<T> = {}) {
    const {current, frame, history, getSince, onJournal, now, staleMs, onStale, ...listenOptions} = options
    let t: ((...a: NormalizeTuple<T>) => void)
    const base = createListen<T>((e) => { t = e }, {fast: true, ...listenOptions})
    const listen = withReplayListen<T>(base, {current, frame, history, getSince, onJournal, now, staleMs, onStale})
    base.run()
    t = listen.emit  // ВАЖНО: сквозь декоратор — иначе события мимо журнала
    return [t!, listen] as const
}
