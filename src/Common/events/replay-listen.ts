// =====================================================================
// withReplayListen — keyframe (snapshot) + нумерованная линия дельт
// =====================================================================
// Декоратор над ListenApi (Listen3) по форме withStoreListen. Один паттерн для
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
// func (он нумерует). UseReplayListen отдаёт правильный emit сам.

import {
    funcListenCallbackBase, registerListenOn,
    Listener, ListenApi, ListenCurrent, ListenCurrentProvider, ListenOnBrand, ListenOptions, NormalizeTuple,
} from './Listen3'

type key = string | symbol
type cbClose = () => void

/** Единица журнала: seq — монотонная координата, ts — атрибут для людей. */
export type ReplayEvent<Z extends any[] = any[]> = { seq: number, ts: number, event: Z }

export type ReplayListenOptions<Z extends any[]> = {
    /** Поставщик keyframe (полное состояние как событие того же типа). Нужен для fallback и {current}. */
    current?: ListenCurrentProvider<Z>
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
    const {current, history = 0, getSince, onJournal, now = Date.now} = options

    // === журнал ===
    let head = 0
    // кольцо фиксированного размера: слот события seq = (seq-1) % history
    const ring: ReplayEvent<Z>[] = []
    // событие текущего синхронного fan-out: liveTap подписчика узнаёт seq без
    // envelope-протокола. save/restore → переживает re-entrant emit.
    let emitting: ReplayEvent<Z> | null = null
    // линия конвертов {seq, ts, event} — обычный Listen: провод проксирует его как есть
    const line = funcListenCallbackBase<[ReplayEvent<Z>]>(() => {})
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

    const api = {
        ...base,
        /** Нумерующий emit: seq++, запись в журнал, fan-out. Единственная дверь в журнал. */
        func: function emitJournaled(...e: Z) {
            const ev: ReplayEvent<Z> = {seq: ++head, ts: now(), event: e}
            if (history > 0) ring[(ev.seq - 1) % history] = ev
            onJournal?.(ev)
            // линия ПЕРЕД локальным fan-out: бросок локального cb не оставит провод без события
            line.func(ev)
            const prev = emitting
            emitting = ev
            try { base.func(...e) } finally { emitting = prev }
        } as Listener<Z>,
        /** Текущая голова линии (seq последнего события; 0 = ещё не было). */
        head: () => head,
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
        /** @deprecated Используйте on(cb, opts) и сохранённый off(). */
        addListen: (cb: Listener<Z>, opts: ReplayOnOptions<Z> = {}) => api.on(cb, opts),
        /** @deprecated Используйте off(keyOrCallback) либо off(), который вернул on()/addListen(). */
        removeListen: (k: Listener<Z> | null | key) => api.off(k),
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
        // Спред «сфотографировал» бы геттер base.getAllKeys — восстанавливаем живой.
        get getAllKeys(): key[] { return base.getAllKeys },
    }
    registerListenOn(api.on, api)
    return api
}
export type ListenReplayApi<T> = ReturnType<typeof withReplayListen<T>>

export type ReplayListenUseOptions<T> = ListenOptions<T> & ReplayListenOptions<NormalizeTuple<T>>

/** [emit, listen]: emit нумерует и журналирует (идёт через декоратор, не мимо). */
export function UseReplayListen<T>(options: ReplayListenUseOptions<T> = {}) {
    const {current, history, getSince, onJournal, now, ...listenOptions} = options
    let t: ((...a: NormalizeTuple<T>) => void)
    const base = funcListenCallbackBase<T>((e) => { t = e }, {fast: true, ...listenOptions})
    const listen = withReplayListen<T>(base, {current, history, getSince, onJournal, now})
    base.run()
    t = listen.func  // ВАЖНО: сквозь декоратор — иначе события мимо журнала
    return [t!, listen] as const
}
