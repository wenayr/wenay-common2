// =====================================================================
// store ⇄ replay — журнал патчей с seq, keyframe = root-патч
// =====================================================================
// Вся механика в withReplayListen; store добавляет ровно «патч как тип события».
// Keyframe — StorePatch с path: [] (replaceRoot): зеркало применяет ОДИН механизм
// applyStorePatch и для снапшота, и для дельт. Реконнект перестаёт стоить полного
// снапшота, когда хватает хвоста журнала.

import {Store, StorePatch, StoreDrain, StoreEachCtx, applyStorePatch, createStore, exposeStore} from './store'
import {UseReplayListen, ReplayListenOptions, ReplayEvent} from '../events/replay-listen'
import {exposeReplay, replaySubscribe, ReplayRemote, ReplaySubscribeOpts} from '../events/replay-wire'
import {openHistory, ReplayStorage} from '../events/replay-history'

/** Патч по пути через ПУБЛИЧНОЕ node-api стора (его внутренний makePatch не нужен). */
function makeStorePatch(store: Store<any>, path: PropertyKey[]): StorePatch {
    let node: any = store.node
    for (const k of path) node = node.at(k)
    const exists = node.has()
    return {path: [...path], exists, value: exists ? node.snapshot() : undefined}
}

export type StoreReplayOpts = Pick<ReplayListenOptions<[StorePatch]>, 'history' | 'getSince' | 'onJournal' | 'now'>

/**
 * keyOf для линии патчей (conflateReplay): схлопывание по точному пути.
 * Патч абсолютен по своему пути, а порядок последних касаний = порядок по seq,
 * поэтому «последний патч каждого пути» даёт то же состояние, что вся линия —
 * включая перекрытия предок/потомок (патч предка несёт всё поддерево целиком).
 * В новом пути (frame на линии) — внутренняя деталь condensePatchTail ниже.
 */
export function storePatchKey(patch: StorePatch) {
    // symbol в JSON.stringify стал бы null → коллизии; такой патч не схлопываем
    for (const k of patch.path) if (typeof k == 'symbol') return null
    return JSON.stringify(patch.path)
}

// Уплотнитель кадра патч-линии (frame-лямбда для UseReplayListen): последний патч
// каждого точного пути, порядок последних касаний = порядок по seq (delete+re-insert).
// Несхлопываемый патч (symbol в пути) → честный полный хвост, без частичной магии.
function condensePatchTail(tail: ReplayEvent<[StorePatch]>[]) {
    const held = new Map<string, ReplayEvent<[StorePatch]>>()
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0])
        if (k == null) return tail
        held.delete(k)
        held.set(k, ev)
    }
    return [...held.values()]
}

/**
 * Серверная сторона: exposeStore + пронумерованная линия патчей.
 * Подписка на стор ГОРЯЧАЯ — журнал обязан видеть каждое изменение, даже когда
 * подписчиков нет, иначе в линии дыры. Цена: один listenPaths-слушатель + кольцо.
 */
export function exposeStoreReplay<T extends object>(store: Store<T>, opts: StoreReplayOpts = {}) {
    const [emitPatch, lineApi] = UseReplayListen<[StorePatch]>({
        current: () => [{path: [], exists: true, value: store.snapshot()}],
        // store-слой знает семантику своих событий → объявляет уплотнитель кадра сам:
        // мини-кадрик (последний патч на путь) вместо полного keyframe, ноль конфигурации
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        now: opts.now,
    })
    const offStore = store.listenPaths().on(function journalStoreChange(change) {
        for (const path of change.paths) emitPatch(makeStorePatch(store, path))
    })
    return {
        /** Провод-фасад: отдать RPC-серверу (object: api). Совместим с обычным exposeStore. */
        api: {...exposeStore(store), replay: exposeReplay(lineApi)},
        /** Локальная replay-линия — in-proc потребители, интроспекция (head/getSince). */
        replay: lineApi,
        close: () => { offStore() },
    }
}

/**
 * Клиентская сторона: зеркало по линии. keyframe/хвост/live — одним механизмом
 * applyStorePatch. Реконнект: syncStoreReplay(store, remote, {since: prev.seq()}).
 */
export function syncStoreReplay<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts: ReplaySubscribeOpts = {}) {
    return replaySubscribe<[StorePatch]>(remote, function applyLine(patch) { applyStorePatch(store, patch) }, opts)
}

/**
 * Однострочный remote-fold: зеркало по линии → колбэк per ИЗМЕНЁННЫЙ топ-ключ
 * (createStore + syncStoreReplay + store.each().on одним вызовом). Keyframe на старте
 * разворачивается по ключам, удаление ключа = (key, undefined), value = store.state[key]
 * на момент flush. Все ReplaySubscribeOpts едут насквозь (since/policy/staleMs/onError...).
 * Возврат — композитный off (снимает и подписку each, и wire-подписку) с зеркалом
 * для прямых чтений (off.store.state.BTCUSDT) и ready/seq/isStale/lastTs провода.
 */
export function syncStoreReplayEach<T extends object>(
    remote: ReplayRemote<[StorePatch]>,
    cb: (key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx) => void,
    opts: ReplaySubscribeOpts & {drain?: StoreDrain, initial?: T} = {},
) {
    const {drain, initial, ...wireOpts} = opts
    const store = createStore<T>((initial ?? {}) as T, drain !== undefined ? {drain} : {})
    // each ДО провода: keyframe первого catch-up обязан развернуться в колбэки
    const offEach = store.each().on(cb)
    const sub = syncStoreReplay(store, remote, wireOpts)
    function off() { offEach(); sub() }
    return Object.assign(off, {
        /** Зеркало — для прямых чтений и дополнительных подписок. */
        store,
        ready: sub.ready,
        seq: sub.seq,
        isStale: sub.isStale,
        lastTs: sub.lastTs,
    })
}

/**
 * Машина времени по архиву патчей (archiveReplay + ReplayStorage): снапшот
 * состояния на момент at (seq/ts; без at — последний архивированный). Keyframe
 * и дельты применяются ОДНИМ механизмом applyStorePatch. undefined = архив пуст.
 */
export function storeReplayAt<T extends object>(storage: ReplayStorage<[StorePatch]>, at: {seq?: number, ts?: number} = {}) {
    const envelopes = openHistory(storage).at(at)
    if (!envelopes) return undefined
    const scratch = createStore<any>({})
    for (const ev of envelopes) applyStorePatch(scratch, ev.event[0])
    return scratch.snapshot() as T
}
