export type Listener<T extends any[]> = (...r: T) => void

/** Нормализация: если T уже кортеж — оставляем, иначе оборачиваем в [T] */
type NormalizeTuple<T> = T extends any[] ? T : [T]

export function funcListenCallbackBase<T>(b: (e: Listener<NormalizeTuple<T>>) => (void | (() => void)),
                                                        data?: {
                                                            event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>) => void,
                                                            fast?: boolean
                                                        }
) {
    type Z = NormalizeTuple<T>
    const {fast = true, event} = data ?? {}
    type cbClose = ()=>void
    const obj = new Map<Listener<Z>, Listener<Z>>()
    const evClose = new Map<cbClose|Listener<Z>, cbClose>()
    const sinh = new Map<cbClose, Listener<Z>>()
    let a: Listener<Z> | null = (...e) => {obj.forEach(z => z(...e))}
    let close: (() => void) | null | undefined= null
    let cached: Listener<Z>[] | null = null

    const getArr = () => cached ?? (cached = Array.from(obj.values()))

    const rebuild = () => {
        cached = null
        const size = obj.size
        if (size === 0) { a = null; return }
        if (size === 1) { a = obj.values().next().value!; return }
        if (size === 2) {
            const [a0, a1] = getArr()
            a = ((...e) => { a0(...e); a1(...e) }) as Listener<Z>
            return
        }
        a = ((...e) => {
            const ar = getArr()
            for (let i = 0, len = ar.length; i < len; i++) ar[i](...e)
        }) as Listener<Z>
    }

    const func: Listener<Z> = (...e) => { a?.(...e) }
    const run = () => { close = (b(func) ?? (() => {})) as (() => void) }

    const api = {
        func,
        isRun: () => close !== null,
        run,
        close: () => {
            close?.()
            close = null
            obj.clear()
            if (fast) rebuild()
            sinh.clear()
            evClose.forEach(cb => cb())
            evClose.clear()
        },
        eventClose: (cb: ()=>void) => {
            evClose.set(cb, cb)
            return () => {evClose.delete(cb)}
        },
        removeEventClose: (cb: ()=>void) => {
            const e=sinh.get(cb)
            if (e) evClose.delete(e)
            sinh.delete(cb)
            evClose.delete(cb)
        },
        addListen: (cb: Listener<Z>, cbClose?: ()=>void) => {
            obj.set(cb, cb)
            if (cbClose) {
                if (evClose.has(cb)) {
                    const r=evClose.get(cb)!
                    if (r!==cbClose) {
                        evClose.delete(r)
                        evClose.delete(cb)
                        sinh.delete(r)
                    }
                }
                evClose.set(cb, cbClose)
                sinh.set(cbClose, cb)
            }
            if (fast) rebuild()
            event?.("add", obj.size, api)
            return () => api.removeListen(cb)
        },
        removeListen: (cb: Listener<Z> | null) => {
            obj.delete(cb!)
            const e=evClose.get(cb!)
            if (fast) rebuild()
            evClose.delete(cb!)
            if (e) {
                evClose.delete(e)
                sinh.delete(e)
            }
            event?.("remove", obj.size, api)
        },
        count: () => obj.size,
        get getAllKeys() { return [...obj.keys()] }
    }
    return api
}
export function funcListenCallbackFast<T>(a: (e: (Listener<NormalizeTuple<T>>|null))=>(void | (()=>void))) {
    return funcListenCallbackBase<T>(a, {fast: true})
}
export function funcListenCallback<T>(a: (e: (Listener<NormalizeTuple<T>>|null))=>(void | (()=>void)), event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>)=>void, fast = true) {
    return funcListenCallbackBase<T>(a, {event, fast})
}

export function UseListen<T>(data: Parameters<typeof funcListenCallbackBase<T>>[1] = {fast : true}) {
    let t: ((...a: NormalizeTuple<T>) => void)
    const a = funcListenCallbackBase<T>((e)=>{t = e}, {fast: true, ...data})
    a.run()
    t = a.func
    return [t, a] as const
}

/** Проверяет, является ли объект результатом funcListenCallbackBase */
export function isListenCallback(obj: any): obj is ReturnType<typeof funcListenCallbackBase> {
    if (obj == null || typeof obj !== "object") return false
    const obj2 = obj as ReturnType<typeof funcListenCallbackBase>
    return (
        typeof obj2.addListen === "function" &&
        typeof obj2.removeListen === "function" &&
        typeof obj2.eventClose === "function" &&
        typeof obj2.func === "function" &&
        typeof obj2.count === "function"
    )
}