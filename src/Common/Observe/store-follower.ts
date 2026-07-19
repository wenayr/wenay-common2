// =====================================================================
// store follower — серверное зеркало авторитетного стора (leader → follower)
// =====================================================================
// Follower — обычный replay-клиент лидера, который сам является сервером:
// syncStoreReplay втягивает кейфрейм и дельты в локальный store, а каскадный
// exposeStoreReplay раздаёт ТО ЖЕ состояние собственным подписчикам — один
// механизм на обоих хопах (leader → follower → браузер). Команды follower
// НЕ применяет локально: их форвардит лидеру владелец соединения (уровень
// приложения) — единственная точка порядка остаётся у лидера.
// Статус апстрима — маленький отдельный реактивный store: в зеркальный store
// не пишется ничего локального, иначе он разойдётся с лидером.

import {createStore, StorePatch} from './store'
import {exposeStoreReplay, syncStoreReplay, StoreReplayOpts} from './store-replay'
import {ReplayRemote} from '../events/replay-wire'
import {getRpcTransportLifecycle} from '../events/transport-lifecycle'
import {deepEqual} from '../core/common'

export type tFollowerUpstream = 'catching-up' | 'live' | 'offline' | 'promoted' | 'closed'

export type FollowerStatus = {
    upstream: tFollowerUpstream
    /** Последний применённый seq лидера — точка реконнекта и мера лага. */
    seq: number
    /** Эпоха линии: у фолловера — эпоха его лидера, после promote — своя (+1). */
    epoch: number
    /** Текст терминальной ошибки подписки (когда upstream == 'closed'). */
    error: string | null
}

export type StoreFollowerDeps<T extends object> = {
    /** Replay-провод лидера — RPC-проекция exposeStoreReplay(...).api.replay. */
    remote: ReplayRemote<[StorePatch]>
    /** Состояние до первого кейфрейма (обычно {}). */
    initial?: T
    /** Опции каскадного журнала для СВОИХ подписчиков (history/getSince/...). */
    expose?: StoreReplayOpts
    /** Порог тухлости апстрима, мс — едет в replay-подписку как staleMs. */
    staleMs?: number
    /** Эпоха лидера-апстрима (fork-choice при failover): promote() выдаст epoch + 1. */
    epoch?: number
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

export function createStoreFollower<T extends object>(deps: StoreFollowerDeps<T>) {
    const store = createStore<T>((deps.initial ?? {}) as T)
    const status = createStore<FollowerStatus>({upstream: 'catching-up', seq: -1, epoch: deps.epoch ?? 0, error: null})

    function setUpstream(next: tFollowerUpstream) {
        // promoted и closed — терминальные роли: поздние события транспорта их не сбивают
        if (status.state.upstream == 'closed' || status.state.upstream == 'promoted') return
        if (status.state.upstream != next) status.state.upstream = next
    }

    // ============== зеркалирование: leader → локальный store ==============
    const sub = syncStoreReplay(store, deps.remote, {
        onSeq: function trackUpstreamSeq(seq) { status.state.seq = seq },
        onLive: function upstreamLive() { setUpstream('live') },
        onError: function upstreamFailed(error) {
            status.state.error = errorText(error)
            status.state.upstream = 'closed'
        },
        ...(deps.staleMs != null ? {staleMs: deps.staleMs} : {}),
    })

    // ============== статус линка: транспортный lifecycle RPC-прокси ==============
    const lifecycle = getRpcTransportLifecycle(deps.remote)
    const offDisconnect = lifecycle?.onDisconnect(function upstreamGone() {
        setUpstream('offline')
    }) ?? function noDisconnectListener() {}
    const offConnect = lifecycle?.onConnect(function upstreamBack() {
        setUpstream('catching-up')
    }) ?? function noConnectListener() {}

    // ============== каскад: тот же store — replay-источник для своих ==============
    const exposed = exposeStoreReplay(store, deps.expose)

    // ============== ручное повышение (failover, фаза 4 плана) ==============
    // Зеркалирование останавливается, состояние остаётся как есть, а КАСКАДНЫЙ
    // журнал продолжает жить — подписчики этого узла не замечают смены роли:
    // их линия и seq непрерывны. Дальше приложение строит авторитет НАД ЭТИМ ЖЕ
    // store (команды пишут в него → каскад разносит). Epoch растёт на 1 —
    // простое fork-choice правило «бОльшая эпоха побеждает», без выборов.
    let promoted = false
    function promote() {
        if (status.state.upstream == 'closed') throw new Error('store follower is closed')
        if (!promoted) {
            promoted = true
            offConnect()
            offDisconnect()
            sub()
            status.state.upstream = 'promoted'
            status.state.epoch = (deps.epoch ?? 0) + 1
        }
        return {store, replay: exposed.replay, epoch: status.state.epoch}
    }

    return {
        /** Зеркальный store — локальные чтения/подписки на инстансе-фолловере. */
        store,
        /** Реактивный статус апстрима: {upstream, seq, error} — обычный store. */
        status,
        /** Тухлость апстрима сейчас (требует staleMs в deps). */
        isStale: sub.isStale,
        /** Провод-фасад каскада для СВОИХ клиентов — кладётся в объект RPC-сервера. */
        api: exposed.api,
        /** Локальная replay-линия каскада — интроспекция, in-proc потребители. */
        replay: exposed.replay,
        /** Конец первого catch-up от лидера (или terminal error/teardown). */
        ready: sub.ready,
        /** Ручное повышение до лидера: стоп зеркалирования, epoch+1, каскад живёт дальше. */
        promote,
        close() {
            offConnect()
            offDisconnect()
            sub()
            exposed.close()
            if (status.state.upstream != 'closed') status.state.upstream = 'closed'
        },
    }
}

export type StoreFollower<T extends object> = ReturnType<typeof createStoreFollower<T>>

// =====================================================================
// Конфликт-журнал split-brain: дифф двух keyed-состояний после failover
// =====================================================================
// Когда старый лидер возвращается после повышения зеркала, его расходящийся
// хвост НЕ выбрасывается: localOnly — записи, которых у победителя нет
// (кандидаты на перепроведение обычными командами — аналог возврата транзакций
// осиротевшей ветки в mempool), conflicts — обе стороны меняли одну запись
// по-разному (победителя уже выбрала эпоха; пара сохраняется для приложения),
// authorityOnly — приедет с кейфреймом при принятии роли фолловера.

export type KeyedConflict<T> = {key: string, local: T, authority: T}

export function diffKeyedState<T extends object>(local: Record<string, T>, authority: Record<string, T>) {
    const localOnly: T[] = []
    const authorityOnly: T[] = []
    const conflicts: KeyedConflict<T>[] = []
    for (const [key, value] of Object.entries(local)) {
        const winner = authority[key]
        if (winner === undefined) localOnly.push(value)
        else if (!deepEqual(value, winner)) conflicts.push({key, local: value, authority: winner})
    }
    for (const [key, value] of Object.entries(authority)) {
        if (local[key] === undefined) authorityOnly.push(value)
    }
    return {localOnly, authorityOnly, conflicts}
}
