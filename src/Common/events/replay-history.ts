// =====================================================================
// Архив replay-линии — периодические keyframe + события, seek и playback
// =====================================================================
// Память ПОЛНОСТЬЮ снаружи: хранилище — четыре лямбды (файл/БД/что угодно),
// декоратор данными не владеет. Правило системы то же:
//     keyframe(S) + события S+1…K = точное состояние на K.
// Архиватор — ещё один подписчик линии; каданс keyframe'ов — GOP-компромисс:
// чаще кадры = быстрый seek / больше места, реже = дешевле / дольше replay.
// Keyframe пишется только НА событии (в тишине состояние не меняется — кадр
// ничего бы не добавил), поэтому таймеров нет вовсе.
// Читатель истории — ТОТ ЖЕ интерфейс подписчика: {since|ts} → replay архива →
// догон по живому журналу → live. Один механизм для playback и live.
// Для БЕСШОВНОГО playback→live прошлое живого журнала тоже должно быть в архиве:
// создавайте линию с getSince, читающим это же хранилище («память снаружи»), —
// иначе зазор архив→live закрывается свежим keyframe (killer property, скачок).

import {Listener, NormalizeTuple} from './Listen3'
import {ListenOnReplay, ListenReplayApi, ReplayEvent} from './replay-listen'

// =====================================================================
// Хранилище: интерфейс-лямбды + референсная реализация в памяти
// =====================================================================

export type ReplayStorage<Z extends any[] = any[]> = {
    /** Записать событие линии (вызывается на каждый пронумерованный emit). */
    putEvent: (ev: ReplayEvent<Z>) => void
    /** Записать keyframe (состояние на момент kf.seq — событие того же типа). */
    putKeyframe: (kf: ReplayEvent<Z>) => void
    /** Ближайший keyframe с seq <= at.seq (или ts <= at.ts). Без at — последний. undefined = нет. */
    getKeyframe: (at?: {seq?: number, ts?: number}) => ReplayEvent<Z> | undefined
    /** События с from < seq <= to, по порядку seq. */
    getEvents: (from: number, to: number) => ReplayEvent<Z>[]
}

// первый индекс, где поле k элемента > v (массив отсортирован по k)
function upperBy<E>(arr: E[], k: (e: E) => number, v: number) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (k(arr[mid]) <= v) lo = mid + 1
        else hi = mid
    }
    return lo
}
const bySeq = (e: ReplayEvent) => e.seq
const byTs = (e: ReplayEvent) => e.ts

/**
 * Референсное хранилище в памяти (и оракул для файловых/БД реализаций).
 * maxEvents/maxKeyframes — вытеснение старейших: моделирует ограниченный архив.
 */
export function createMemoryReplayStorage<Z extends any[] = any[]>(opts: {maxEvents?: number, maxKeyframes?: number} = {}) {
    const {maxEvents, maxKeyframes} = opts
    // пишутся строго по возрастанию seq → массивы всегда отсортированы
    const events: ReplayEvent<Z>[] = []
    const keyframes: ReplayEvent<Z>[] = []
    return {
        putEvent: (ev: ReplayEvent<Z>) => {
            events.push(ev)
            if (maxEvents && events.length > maxEvents) events.shift()
        },
        putKeyframe: (kf: ReplayEvent<Z>) => {
            keyframes.push(kf)
            if (maxKeyframes && keyframes.length > maxKeyframes) keyframes.shift()
        },
        getKeyframe: (at: {seq?: number, ts?: number} = {}) => {
            const end = at.ts != null ? upperBy(keyframes, byTs, at.ts) : upperBy(keyframes, bySeq, at.seq ?? Infinity)
            return keyframes[end - 1]
        },
        getEvents: (from: number, to: number) =>
            events.slice(upperBy(events, bySeq, from), upperBy(events, bySeq, to)),
        /** Интроспекция для метрик/тестов. */
        size: () => ({events: events.length, keyframes: keyframes.length}),
    }
}

// =====================================================================
// Архиватор: пишущая сторона (события + каданс keyframe'ов)
// =====================================================================

export type ArchiveReplayOpts<Z extends any[]> = {
    storage: ReplayStorage<Z>
    /** Keyframe каждые N событий (default 64). */
    everyEvents?: number
    /** …или каждые T мс по ts линии — что наступит раньше (default выключено). */
    everyMs?: number
}

export function archiveReplay<T>(replay: ListenReplayApi<T>, opts: ArchiveReplayOpts<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    const {storage, everyEvents = 64, everyMs} = opts
    // без current-провайдера архив не воспроизводим (нет опорных кадров) — сразу и громко
    if (!replay.hasKeyframe) throw new TypeError('archiveReplay: нужен current-провайдер (keyframe)')

    let events = 0
    let keyframes = 0
    let lastKfSeq = 0
    let lastKfTs = 0
    function takeKeyframe() {
        const kf = replay.keyframe()
        if (!kf) return
        storage.putKeyframe(kf as ReplayEvent<Z>)
        keyframes++
        lastKfSeq = kf.seq
        lastKfTs = kf.ts
    }
    // опорный кадр сразу: у событий до первого кадансного keyframe должна быть база
    takeKeyframe()
    const offLine = replay.line.on(function archiveLineEvent(ev: ReplayEvent<Z>) {
        storage.putEvent(ev)
        events++
        const due = ev.seq - lastKfSeq >= everyEvents || (everyMs != null && ev.ts - lastKfTs >= everyMs)
        // keyframe() читает состояние на момент head — ЭТО событие уже включено
        if (due) takeKeyframe()
    })
    return {
        close: () => offLine(),
        /** Интроспекция для метрик/тестов. */
        stats: () => ({events, keyframes}),
    }
}

// =====================================================================
// Читатель: seek по seq/ts + playback тем же интерфейсом подписчика
// =====================================================================

export type HistorySubscribeOpts = {
    /** «У меня seq K» → хвост архива; дыра в архиве → keyframe (сброс возможен и ВНИЗ). */
    since?: number
    /** Seek по времени: состояние на ts (keyframe <= ts + дельты до ts), дальше вперёд. */
    ts?: number
    /** Репорт seq каждой доставки — точка переподключения. */
    onSeq?: (seq: number) => void
}

/**
 * Читатель архива. live не задан — чистый playback (заканчивается на границе
 * архива); задан — после архива тот же догон по живому журналу и live
 * (двухступенчатый handover: архив → журнал линии → live).
 */
export function openHistory<Z extends any[]>(storage: ReplayStorage<Z>, live?: {on: ListenOnReplay<Z>}) {
    /** Конверты, восстанавливающие состояние на месте at: [keyframe, …дельты]. undefined = архив пуст. */
    function at(where: {seq?: number, ts?: number} = {}) {
        const kf = storage.getKeyframe(where)
        if (!kf) return undefined
        let tail = storage.getEvents(kf.seq, where.seq ?? Infinity)
        if (where.ts != null) {
            // ts вдоль линии неубывает → отрезаем всё позже искомого момента
            const cut = tail.findIndex(ev => ev.ts > where.ts!)
            if (cut >= 0) tail = tail.slice(0, cut)
        }
        return [kf, ...tail]
    }

    function subscribe(cb: Listener<Z>, opts: HistorySubscribeOpts = {}) {
        const {since, ts, onSeq} = opts
        let last = since ?? 0
        function deliver(ev: ReplayEvent<Z>) {
            if (ev.seq <= last) return
            last = ev.seq
            cb(...ev.event)
            onSeq?.(ev.seq)
        }
        function deliverFromKeyframe(envs: ReplayEvent<Z>[] | undefined) {
            if (!envs) return
            // свежая точка отсчёта: сброс ВНИЗ разрешён (kf может быть старше since) —
            // избыточные, но консистентные доставки лучше дыры в состоянии
            last = envs[0].seq - 1
            for (const ev of envs) deliver(ev)
        }
        // === архивная часть: чистый хвост от since либо keyframe + дельты ===
        if (since != null) {
            const tail = storage.getEvents(since, Infinity)
            if (tail.length && tail[0].seq != since + 1) deliverFromKeyframe(at({}))
            else for (const ev of tail) deliver(ev)
        } else {
            deliverFromKeyframe(at(ts != null ? {ts} : {}))
        }
        // === живой догон: журнал линии закрывает зазор архив→сейчас, дальше live ===
        let offLive: (() => void) | null = null
        if (live) offLive = live.on(cb, {since: last, onSeq: function trackSeq(s: number) { last = s; onSeq?.(s) }})
        function off() { offLive?.() }
        return Object.assign(off, {
            /** Последний доставленный seq — точка переподключения. */
            seq: () => last,
        })
    }

    return {at, subscribe}
}
