/**
 * Извлекатель ключа потока из данных.
 * Вернул string — группируем по нему. Вернул undefined — общий бакет "_".
 */
import {listen as createListenPair} from "./Listen";

export type ListenPair<T extends any[] = any[]> = ReturnType<typeof createListenPair<T>>
type KeyExtractor<D> = (data: D) => string | undefined

export type ListenMap<T extends Record<string, any>> = {
    [K in keyof T]: ListenPair<T[K]>[1]
}

type CollectedResult<T extends Record<string, any>> = {
    [K in keyof T]: T[K]
}

type JoinResult<R> = {
    listen: ListenPair<[R, string]>[1],
    pending: Map<string, Map<string, any>>,
    clear: (tid?: string) => void,
    // снести весь join: снять все подписки на порты + очистить бакеты.
    // (раньше отсутствовал в типе — метод был в реализации, но невидим потребителю/типам)
    destroy: () => void,
    // Подключить порт-источник (идиома `add`). Объект — нужен ключ, массив — ключ генерируется сам.
    add: (port: ListenPair<any>[1], key?: string) => void
}

// --- Перегрузка: объект (именованные порты) ---
export function joinListens<T extends Record<string, any[]>>(
    listens: ListenMap<T>,
    keyExtractor?: KeyExtractor<any>
): JoinResult<CollectedResult<T>>

// --- Перегрузка: массив listen'ов ---
export function joinListens<D extends any[] = any[]>(
    listens: ListenPair<D>[1][],
    keyExtractor?: KeyExtractor<any>
): JoinResult<D[][]>

// --- Реализация ---
export function joinListens(
    listens: Record<string, any> | any[],
    keyExtractor?: KeyExtractor<any>
) {
    const isArray = Array.isArray(listens)

    // Нормализуем: массив → объект с индексами как ключами
    const map: Record<string, any> = isArray
        ? Object.fromEntries(listens.map((l, i) => [String(i), l]))
        : listens

    const [set, out] = createListenPair<[any, string]>()
    const keys = Object.keys(map)
    const buckets = new Map<string, Map<string, any>>()

    const getKey = (data: any): string => keyExtractor?.(data) ?? "_"

    const tryFire = (tid: string) => {
        const bucket = buckets.get(tid)!
        if (bucket.size < keys.length) return

        const result = isArray
            ? keys.map(k => bucket.get(k))        // массив → массив данных
            : Object.fromEntries(bucket)           // объект → объект данных

        buckets.delete(tid)   // группа собрана и отправлена → удаляем бакет целиком
        set(result, tid)      // (был bucket.clear() — пустой Map оставался в buckets навсегда → утечка по tid)
    }

    // храним отписки, чтобы destroy() реально снимал подписки (раньше это была пустая заглушка → утечка)
    const unsubs: Array<() => void> = []
    const bindPort = (portId: string, listener: any) => {
        const cb = (...data: any[]) => {
            const tid = getKey(data[0])
            if (!buckets.has(tid)) buckets.set(tid, new Map())
            buckets.get(tid)!.set(portId, data.length <= 1 ? data[0] : data)
            tryFire(tid)
        }
        // off() из on() — единственный путь точечной отписки.
        unsubs.push(listener.on(cb))
    }

    for (const portId of keys) {
        bindPort(portId, map[portId])
    }

    // Подключить порт-источник: режим массива → индекс генерируется сам, объект → ключ.
    function add(listener: any, key?: string) {
        const portId = isArray ? String(keys.length) : (key ?? String(keys.length))

        if (map[portId]) return // Защита от дублирования ключей или более верно очистить старый???

        map[portId] = listener
        keys.push(portId) // Расширяем размер ожидаемой группы
        bindPort(portId, listener)
    }

    return {
        listen: out,
        pending: buckets,
        clear: (tid?: string) => {
            tid ? buckets.delete(tid) : buckets.clear()
        },
        destroy: () => {
            for (const u of unsubs) u()
            unsubs.length = 0
            buckets.clear()
        },
        add
    }
}

type inputParams = {
    test1: [string],
    test2: [string]
}