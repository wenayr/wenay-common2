/**
 * Stream key extractor from data.
 * Returns string — group by it. Returns undefined — common bucket "_".
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
    // tear down the entire join: remove all port subscriptions + clear buckets.
    // (previously was not in the type — method was in implementation, but invisible to consumer/types)
    destroy: () => void,
    // Connect port-source (idiom `add`). Object — needs key, array — key is generated automatically.
    add: (port: ListenPair<any>[1], key?: string) => void
}

// --- Overload: object (named ports) ---
export function joinListens<T extends Record<string, any[]>>(
    listens: ListenMap<T>,
    keyExtractor?: KeyExtractor<any>
): JoinResult<CollectedResult<T>>

// --- Overload: array of listens ---
export function joinListens<D extends any[] = any[]>(
    listens: ListenPair<D>[1][],
    keyExtractor?: KeyExtractor<any>
): JoinResult<D[][]>

// --- Implementation ---
export function joinListens(
    listens: Record<string, any> | any[],
    keyExtractor?: KeyExtractor<any>
) {
    const isArray = Array.isArray(listens)

    // Normalize: array → object with indices as keys
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
            ? keys.map(k => bucket.get(k))        // array → array of data
            : Object.fromEntries(bucket)           // object → object of data

        buckets.delete(tid)   // group collected and sent → remove bucket entirely
        set(result, tid)      // (was bucket.clear() — empty Map remained in buckets forever → leak by tid)
    }

    // store unsubscribes so destroy() actually removes subscriptions (previously was empty stub → leak)
    const unsubs: Array<() => void> = []
    const bindPort = (portId: string, listener: any) => {
        const cb = (...data: any[]) => {
            const tid = getKey(data[0])
            if (!buckets.has(tid)) buckets.set(tid, new Map())
            buckets.get(tid)!.set(portId, data.length <= 1 ? data[0] : data)
            tryFire(tid)
        }
        // off() from on() — only way for selective unsubscribe.
        unsubs.push(listener.on(cb))
    }

    for (const portId of keys) {
        bindPort(portId, map[portId])
    }

    // Connect port-source: array mode → index is generated automatically, object → key.
    function add(listener: any, key?: string) {
        const portId = isArray ? String(keys.length) : (key ?? String(keys.length))

        if (map[portId]) return // Guard against duplicate keys or better to clear old???

        map[portId] = listener
        keys.push(portId) // Expand the size of expected group
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