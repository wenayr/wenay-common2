export type Listener<T extends any[]> = (...r: T) => void

/** Нормализация: если T уже кортеж — оставляем, иначе оборачиваем в [T] */
export type NormalizeTuple<T> = T extends any[] ? T : [T]

export function funcListenCallbackBase<T>(b: (e: Listener<NormalizeTuple<T>>) => (void | (() => void)),
                                                        data?: {
                                                            event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>) => void,
                                                            fast?: boolean,
                                                            addListenClose?: ReturnType<typeof funcListenCallbackBase<any>>
                                                        }
) {
    type Z = NormalizeTuple<T>
    const {fast = true, event, addListenClose} = data ?? {}
    type cbClose = ()=>void
    const obj = new Map<Listener<Z>, Listener<Z>>()
    const evClose = new Map<cbClose|Listener<Z>, cbClose>()
    const sinh = new Map<cbClose, Listener<Z>>()
    let a: Listener<Z> | null = (...e) => {obj.forEach(z => z(...e))}
    let close: (() => void) | null | undefined= null
    let cached: Listener<Z>[] | null = null
    let closeUnsubscribe: (() => void) | null = null

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
    const run = () => { 
        close = (b(func) ?? (() => {})) as (() => void)
        
        // Подписываемся на событие закрытия
        if (addListenClose && !closeUnsubscribe) {
            closeUnsubscribe = addListenClose.addListen(() => {
                api.close()
            })
        }
    }

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
            
            // Отписываемся от события закрытия
            if (closeUnsubscribe) {
                closeUnsubscribe()
                closeUnsubscribe = null
            }
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
        get getAllKeys(): Listener<NormalizeTuple<T>>[] { return [...obj.keys()] }
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
let referenceKeys: string[] | null = null
let referenceTypes: Map<string, string> | null = null

function getReferenceData(): { keys: string[], types: Map<string, string> } {
    if (!referenceKeys || !referenceTypes) {
        const demo = funcListenCallbackBase(() => {})
        referenceKeys = Object.keys(demo).sort()
        referenceTypes = new Map()

        // Сохраняем типы всех свойств
        for (const key of referenceKeys) {
            referenceTypes.set(key, typeof (demo as any)[key])
        }
    }
    return { keys: referenceKeys, types: referenceTypes }
}
// 2. Безопасная проверка
export function isListenCallback(obj: any): obj is ReturnType<typeof funcListenCallbackBase> {
    if (obj == null || typeof obj !== "object") return false

    // Получаем ключи БЕЗ обращения к свойствам (безопасно от геттеров/Proxy)
    const objKeys = Object.keys(obj).sort()
    const { keys: refKeys, types: refTypes } = getReferenceData()

    // Сравниваем количество ключей
    if (objKeys.length !== refKeys.length) return false

    // Сравниваем названия ключей
    for (let i = 0; i < refKeys.length; i++) {
        if (objKeys[i] !== refKeys[i]) return false
    }

    // Проверяем типы всех свойств
    for (const key of refKeys) {
        const expectedType = refTypes.get(key)
        const actualType = typeof obj[key]

        if (actualType !== expectedType) return false
    }

    return true
}