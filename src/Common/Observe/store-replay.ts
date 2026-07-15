// =====================================================================
// store ⇄ replay — журнал патчей с seq, keyframe = root-патч
// =====================================================================
// Вся механика в withReplayListen; store добавляет ровно «патч как тип события».
// Keyframe — StorePatch с path: [] (replaceRoot): зеркало применяет ОДИН механизм
// applyStorePatch и для снапшота, и для дельт. Реконнект перестаёт стоить полного
// снапшота, когда хватает хвоста журнала.

import {Store, StorePatch, StoreDrain, StoreEachCtx, applyStorePatch, createStore, exposeStore} from './store'
import {replayListen, ReplayListenOptions, ReplayEvent} from '../events/replay-listen'
import {exposeReplay, replaySubscribe, ReplayRemote, ReplaySubscribeOpts} from '../events/replay-wire'
import {replayRouteSubscribe, ReplayRouteSubscribeOpts} from '../events/replay-route'
import {openHistory, ReplayStorage} from '../events/replay-history'

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

// Уплотнитель кадра патч-линии (frame-лямбда для replayListen): последний патч
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
    const [emitPatch, lineApi] = replayListen<[StorePatch]>({
        current: () => [{path: [], exists: true, value: store.snapshot()}],
        // store-слой знает семантику своих событий → объявляет уплотнитель кадра сам:
        // мини-кадрик (последний патч на путь) вместо полного keyframe, ноль конфигурации
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        now: opts.now,
    })
    // Store уже умеет строить push-патчи напрямую по raw state. Повторный проход через
    // store.node.at(path) навсегда оставлял в node-cache каждый временный id ордера/задачи.
    const {patches, changedData: _changedData, ...storeApi} = exposeStore(store, {push: true})
    const offStore = patches!.on(function journalStoreChange(patch: StorePatch) {
        emitPatch(patch)
    })
    return {
        /** Провод-фасад: отдать RPC-серверу (object: api). Совместим с обычным exposeStore. */
        api: {...storeApi, replay: exposeReplay(lineApi)},
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
 * Route-switching store mirror: keep the old route alive, catch up the replacement
 * route from the last delivered seq, then close the old one. Use for relay <-> direct
 * promotion/re-interposition when the authority/replay line stays semantically the same.
 */
export function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts: ReplayRouteSubscribeOpts = {}) {
    return replayRouteSubscribe<[StorePatch]>(remote, function applyRoutePatch(patch) { applyStorePatch(store, patch) }, opts)
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
