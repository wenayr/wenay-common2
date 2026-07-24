export type Listener<T extends any[]> = (...args: T) => void
export type NormalizeTuple<T> = T extends any[] ? T : [T]

export type ListenKey = string | symbol
export type ListenOff = () => void
type CloseCallback = () => void

declare const LISTEN_ON_BRAND: unique symbol

export type ListenOn<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: { cbClose?: CloseCallback; key?: ListenKey }) => ListenOff)
    & { readonly [LISTEN_ON_BRAND]: Z }

export type ListenOnCurrent<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: { cbClose?: CloseCallback; key?: ListenKey; current?: ListenCurrent<Z> }) => ListenOff)
    & { readonly [LISTEN_ON_BRAND]: Z }

export type ListenCurrentProvider<Z extends any[]> = () => Z | undefined
export type ListenCurrent<Z extends any[]> = boolean | ListenCurrentProvider<Z>

export type ListenCoreApi<T = any> = {
    emit: Listener<NormalizeTuple<T>>
    has(key: ListenKey): boolean
    on: ListenOn<NormalizeTuple<T>>
    off(keyOrCallback: Listener<NormalizeTuple<T>> | null | ListenKey): void
    once(cb: Listener<NormalizeTuple<T>>, opts?: {key?: ListenKey}): ListenOff
    close(): void
    count(): number
    keys(): ListenKey[]
}

export type ListenApi<T = any> = ListenCoreApi<T> & {
    isRunning(): boolean
    run(): void
    onClose(cb: CloseCallback): ListenOff
}

export type ListenCoreOptions<T = any> = {
    fast?: boolean
    onRemove?: (key: ListenKey) => void
    event?: (type: 'add' | 'remove', count: number, api: ListenCoreApi<T>) => void
} & ListenDispatchErrorPort

export type ListenOptions<T = any> = {
    event?: (type: 'add' | 'remove', count: number, api: ListenApi<T>) => void
    fast?: boolean
    closeOn?: ListenApi<any>
} & ListenDispatchErrorPort

export type ListenStoreOptions<T> = ListenOptions<T> & {
    current: ListenCurrentProvider<NormalizeTuple<T>>
}

export type ListenOnBrand<Z extends any[] = any[]> = { readonly [LISTEN_ON_BRAND]: Z }

const listenByOn = new WeakMap<Function, any>()

/** Hidden decorator port: isolate sibling subscribers without widening the Listen facade. */
export const LISTEN_DISPATCH_ERROR = Symbol.for('wenay-common2.listen.dispatchError')
export type ListenDispatchErrorPort = {
    [LISTEN_DISPATCH_ERROR]?: (error: unknown) => void
}

export function getListenByOn(fn: any) { return typeof fn == 'function' ? listenByOn.get(fn) : undefined }
export function isListenOn(fn: any): boolean { return typeof fn == 'function' && listenByOn.has(fn) }
export function registerListenOn(on: Function, api: any) { listenByOn.set(on, api) }

export function createListenCore<T>(options: ListenCoreOptions<T> = {}): ListenCoreApi<T> {
    const {fast = true, onRemove, event} = options
    const dispatchError = options[LISTEN_DISPATCH_ERROR]
    type Z = NormalizeTuple<T>
    const subs = new Map<ListenKey, Listener<Z>>()
    function dispatch(cb: Listener<Z>, args: Z) {
        if (!dispatchError) { cb(...args); return }
        try { cb(...args) }
        catch (error) { dispatchError(error) }
    }
    function dispatchInitial(...args: Z) {
        for (const cb of subs.values()) dispatch(cb, args)
    }
    let dispatcher: Listener<Z> | null = dispatchInitial
    let cached: Listener<Z>[] | null = null

    const getArr = () => cached ?? (cached = Array.from(subs.values()))

    function rebuild() {
        cached = null
        const size = subs.size
        if (size == 0) { dispatcher = null; return }
        if (size == 1) {
            const cb = subs.values().next().value!
            function dispatchOne(...args: Z) { dispatch(cb, args) }
            dispatcher = dispatchError ? dispatchOne : cb
            return
        }
        if (size == 2) {
            const [a, b] = getArr()
            function dispatchPairSafely(...args: Z) {
                dispatch(a, args)
                dispatch(b, args)
            }
            function dispatchPair(...args: Z) {
                a(...args)
                b(...args)
            }
            dispatcher = dispatchError ? dispatchPairSafely : dispatchPair
            return
        }
        dispatcher = function dispatchMany(...args: Z) {
            const arr = getArr()
            if (dispatchError) {
                for (let i = 0; i < arr.length; i++) dispatch(arr[i], args)
            } else {
                for (let i = 0; i < arr.length; i++) arr[i](...args)
            }
        }
    }

    function removeOne(key: ListenKey) {
        if (!subs.has(key)) return
        subs.delete(key)
        onRemove?.(key)
        if (fast) rebuild()
        event?.('remove', subs.size, api)
    }

    const api: ListenCoreApi<T> = {
        emit: ((...args: Z) => { dispatcher?.(...args) }) as Listener<Z>,
        has: (key) => subs.has(key),
        on: ((cb: Listener<Z>, {key}: {key?: ListenKey} = {}) => {
            const k = key ?? Symbol()
            if (subs.has(k)) {
                subs.delete(k)
                onRemove?.(k)
            }
            subs.set(k, cb)
            if (fast) rebuild()
            event?.('add', subs.size, api)
            return function off() { removeOne(k) }
        }) as ListenOn<Z>,
        off: (keyOrCallback) => {
            if (typeof keyOrCallback == 'function') {
                for (const [key, cb] of [...subs]) if (cb === keyOrCallback) removeOne(key)
                return
            }
            if (keyOrCallback != null) removeOne(keyOrCallback)
        },
        once: (cb, opts = {}) => {
            let off: ListenOff = () => {}
            off = api.on(((...args: Z) => { off(); cb(...args) }) as Listener<Z>, opts)
            return off
        },
        close: () => {
            subs.clear()
            if (fast) rebuild()
        },
        count: () => subs.size,
        keys: () => [...subs.keys()],
    }
    listenByOn.set(api.on, api)
    return api
}

export function createListen<T>(
    producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff),
    options: ListenOptions<T> = {},
): ListenApi<T> {
    const {fast = true, event, closeOn} = options
    type Z = NormalizeTuple<T>
    let teardown: ListenOff | null = null
    let closeSignalOff: ListenOff | null = null
    let closeHooks: Map<ListenKey | CloseCallback, CloseCallback> | null = null

    function forgetKey(key: ListenKey) {
        closeHooks?.delete(key)
    }

    function forwardRemoveEvent(type: 'add' | 'remove', count: number) {
        if (type == 'remove') event?.(type, count, api)
    }

    const core = createListenCore<T>({
        fast,
        onRemove: forgetKey,
        [LISTEN_DISPATCH_ERROR]: options[LISTEN_DISPATCH_ERROR],
        event: event ? forwardRemoveEvent : undefined,
    })

    const api: ListenApi<T> = {
        emit: core.emit,
        has: core.has,
        isRunning: () => teardown !== null,
        run: () => {
            if (teardown) return
            teardown = (producer(core.emit) ?? (() => {})) as ListenOff
            if (closeOn && !closeSignalOff) closeSignalOff = closeOn.on(() => api.close())
        },
        close: () => {
            const stop = teardown
            teardown = null
            stop?.()
            core.close()
            if (closeHooks) {
                const hooks = closeHooks
                closeHooks = null
                hooks.forEach(cb => cb())
            }
            closeSignalOff?.()
            closeSignalOff = null
        },
        onClose: (cb) => {
            closeHooks = closeHooks ?? new Map()
            closeHooks.set(cb, cb)
            return function offClose() { closeHooks?.delete(cb) }
        },
        on: ((cb: Listener<Z>, {cbClose, key}: {cbClose?: CloseCallback; key?: ListenKey} = {}) => {
            const k = key ?? Symbol()
            const off = core.on(cb, {key: k})
            if (cbClose) {
                closeHooks = closeHooks ?? new Map()
                closeHooks.set(k, cbClose)
            }
            event?.('add', core.count(), api)
            return off
        }) as ListenOn<Z>,
        off: core.off,
        once: (cb, opts = {}) => {
            let off: ListenOff = () => {}
            off = api.on(((...args: Z) => { off(); cb(...args) }) as Listener<Z>, opts)
            return off
        },
        count: core.count,
        keys: core.keys,
    }
    listenByOn.set(api.on, api)
    return api
}

export function createFastListen<T>(producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff)) {
    return createListen<T>(producer, {fast: true})
}

export function listen<T>(options: ListenOptions<T> = {fast: true}) {
    let emit: Listener<NormalizeTuple<T>>
    const api = createListen<T>((next) => { emit = next }, {fast: true, ...options})
    api.run()
    emit = api.emit
    return [emit!, api] as const
}

export function withStoreListen<T>(base: ListenApi<T>, currentProvider: ListenCurrentProvider<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    function currentValue(current?: ListenCurrent<Z>) {
        if (typeof current == 'function') return current()
        return current ? currentProvider() : undefined
    }
    const api = {
        ...base,
        on: ((cb: Listener<Z>, {cbClose, key, current}: {cbClose?: CloseCallback; key?: ListenKey; current?: ListenCurrent<Z>} = {}) => {
            const off = base.on(cb, {cbClose, key})
            if (current) {
                const value = currentValue(current)
                if (value) cb(...value)
            }
            return off
        }) as ListenOnCurrent<Z>,
        once: (cb: Listener<Z>, opts: {key?: ListenKey; current?: ListenCurrent<Z>} = {}) => {
            if (opts.current) {
                const value = currentValue(opts.current)
                if (value) { cb(...value); return () => {} }
            }
            let off: ListenOff = () => {}
            off = base.on(((...args: Z) => { off(); cb(...args) }) as Listener<Z>, {key: opts.key})
            return off
        },
    }
    listenByOn.set(api.on, api)
    return api
}

export type ListenStoreApi<T> = ReturnType<typeof withStoreListen<T>>

export function createStoreListen<T>(
    producer: (emit: Listener<NormalizeTuple<T>>) => (void | ListenOff),
    options: ListenStoreOptions<T>,
) {
    const {current, ...listenOptions} = options
    return withStoreListen(createListen<T>(producer, listenOptions), current)
}

export function listenStore<T>(options: ListenStoreOptions<T>) {
    const {current, ...listenOptions} = options
    let emit: Listener<NormalizeTuple<T>>
    const base = createListen<T>((next) => { emit = next }, {fast: true, ...listenOptions})
    const api = withStoreListen<T>(base, current)
    base.run()
    emit = base.emit
    return [emit!, api] as const
}

export function toSlimListen<T>(full: ListenApi<T>) {
    return {
        on: (cb: Listener<NormalizeTuple<T>>, opts?: {key?: ListenKey}) => full.on(cb, opts),
        off: (keyOrCallback: Listener<NormalizeTuple<T>> | null | ListenKey) => full.off(keyOrCallback),
        close: () => full.close(),
        count: () => full.count(),
    }
}

export type SlimListen<T> = ReturnType<typeof toSlimListen<T>>

export function slimListen<T>(options: ListenOptions<T> = {fast: true}) {
    const [emit, full] = listen<T>(options)
    return [emit, toSlimListen(full)] as const
}

const LISTEN_CORE = ['emit', 'on', 'off', 'onClose', 'run', 'isRunning', 'close', 'count'] as const

export function isListenCallback(obj: any): obj is ListenApi {
    if (obj == null || typeof obj != 'object') return false
    const keys = new Set(Object.keys(obj))
    for (const key of LISTEN_CORE) if (!keys.has(key)) return false
    for (const key of LISTEN_CORE) if (typeof obj[key] != 'function') return false
    return true
}
