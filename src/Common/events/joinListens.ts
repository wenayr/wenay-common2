/**
 * Извлекатель ключа потока из данных.
 * Вернул string — группируем по нему. Вернул undefined — общий бакет "_".
 */
import {UseListen} from "./Listen";

export type listen<T extends any[] = any[]> = ReturnType<typeof UseListen<T>>
type KeyExtractor<D> = (data: D) => string | undefined

export type ListenMap<T extends Record<string, any>> = {
    [K in keyof T]: listen<T[K]>[1]
}

type CollectedResult<T extends Record<string, any>> = {
    [K in keyof T]: T[K]
}

type JoinResult<R> = {
    listen: listen<[R, string]>[1],
    pending: Map<string, Map<string, any>>,
    clear: (tid?: string) => void
}

// --- Перегрузка: объект (именованные порты) ---
export function joinListens<T extends Record<string, any[]>>(
    listens: ListenMap<T>,
    keyExtractor?: KeyExtractor<any>
): JoinResult<CollectedResult<T>>

// --- Перегрузка: массив listen'ов ---
export function joinListens<D extends any[] = any[]>(
    listens: listen<D>[1][],
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

    const [set, out] = UseListen<[any, string]>()
    const keys = Object.keys(map)
    const buckets = new Map<string, Map<string, any>>()

    const getKey = (data: any): string => keyExtractor?.(data) ?? "_"

    const tryFire = (tid: string) => {
        const bucket = buckets.get(tid)!
        if (bucket.size < keys.length) return

        const result = isArray
            ? keys.map(k => bucket.get(k))        // массив → массив данных
            : Object.fromEntries(bucket)           // объект → объект данных

        buckets.delete(tid)
        set(result, tid)
    }

    for (const portId of keys) {
        map[portId].addListen((...data: any[]) => {
            const tid = getKey(data[0])
            if (!buckets.has(tid)) buckets.set(tid, new Map())
            buckets.get(tid)!.set(portId, data.length <= 1 ? data[0] : data)
            tryFire(tid)
        })
    }

    return {
        listen: out,
        pending: buckets,
        clear: (tid?: string) => {
            tid ? buckets.delete(tid) : buckets.clear()
        }
    }
}

type inputParams = {
    test1: [string],
    test2: [string]
}