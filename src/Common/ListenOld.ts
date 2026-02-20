import {isProxy} from "./isProxy";

export type Listener<T extends any[]> = (...r: T) => void

export function funcListenCallbackBase<T extends any[]>(b: (e: Listener<T>) => (void | (() => void)),
                                                        data?: {
                                                            event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>) => void,
                                                            fast?: boolean
                                                        }
) {
    const {fast = false, event} = data ?? {}
    let a: Listener<T> | null = null

    const obj = new Map<Listener<T>, Listener<T>>()
    let close: (() => void) | null = null
    let cached: Listener<T>[] | null = null

    const getArr = () => cached ?? (cached = Array.from(obj.values()))

    const rebuild = () => {
        cached = null
        const size = obj.size
        if (size == 0) { a = null; return }
        if (size == 1) { a = obj.values().next().value!; return }
        if (size == 2) {
            const [a0, a1] = getArr()
            a = ((...e) => { a0(...e); a1(...e) }) as Listener<T>
            return
        }
        a = ((...e) => {
            const ar = getArr()
            for (let i = 0, len = ar.length; i < len; i++) ar[i](...e)
        }) as Listener<T>
    }

    const func: Listener<T> = (...e) => { a?.(...e) }
    const run = () => { close = b(func) ?? (() => {}) }

    const api = {
        func,
        isRun: () => close !== null,
        run,
        close: () => {
            close?.()
            close = null
        },
        addListen: (cb: Listener<T>) => {
            obj.set(cb, cb)
            if (fast) rebuild()
            event?.("add", obj.size, api)
            return () => api.removeListen(cb)
        },
        removeListen: (cb: Listener<T> | null) => {
            obj.delete(cb!)
            if (fast) rebuild()
            event?.("remove", obj.size, api)
        },
        count: () => obj.size,
        get getAllKeys() { return [...obj.keys()] }
    }
    return api
}
export function funcListenCallbackFast<T extends any[]>(a: (e: (Listener<T>|null))=>(void | (()=>void))) {
    return funcListenCallbackBase(a, {fast: true})
}
export function funcListenCallback<T extends any[]>(a: (e: (Listener<T>|null))=>(void | (()=>void)), event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>)=>void, fast = true) {
    return funcListenCallbackBase(a, {event, fast})
}

type t1<T extends any[] = any[]> = ReturnType<typeof funcListenCallback<T>>

// передает все параметры
export function funcListenBySocket2<Z extends any[] = any[]>(e: t1<Z>, d?: {
    readonly status?: () => boolean,
    readonly addListenClose?: t1<any>,
    readonly stop?: (x: Listener<Z>) => any,
    readonly paramsModify?: (...e: Z) => any[]
}) {
    const {stop, addListenClose, status, paramsModify} = d ?? {}
    const {addListen, removeListen} = e

    let last: Listener<Z> | null = null
    let active: Listener<any> | null = null

    function removeCallback() {
        if (last) { stop?.(last); last = null }
        if (active) { removeListen(active); active = null }
        addListenClose?.removeListen(removeCallback)
        return true
    }

    function callback(z: Listener<Z>) {
        // предыдущий — стоп
        if (last) stop?.(last)
        if (active) removeListen(active)

        last = z

        if (!z) {
            console.log(z)
            console.log(e.count())
            console.trace()
        }

        // собираем финальный обработчик за один проход
        let handler: Listener<any> = z
        if (paramsModify) {
            const orig = handler
            handler = (...a: any[]) => orig(...paramsModify(...a as Z))
        }
        if (status) {
            const wrapped = handler
            handler = (...a: any[]) => { status() ? wrapped(...a) : removeListen(active) }
        }

        active = handler
        addListen(active)
        addListenClose?.addListen(removeCallback)
    }

    return { callback, removeCallback }
}

// передает первый параметр
export function funcListenBySocket3<Z extends any[] = any[]>(e: t1<Z>, options?: Omit<Parameters<typeof funcListenBySocket2>[1], "paramsModify">) {
    const r = funcListenBySocket2(e, {...(options ?? {}), paramsModify: ((...e: any[]) => [e[0]]) as (...e: Z) => any[]})
    type tt = (a: Z[0]) => void
    return {
        callback: r.callback as unknown as (z: tt) => void,
        removeCallback: r.removeCallback
    }
}
// Прокидывает колбэк к листу подписок, передовая только, первый параметр функции (подписки листа).
// Если функция уже есть, то он отправит код остановки клиенту, и удалит её
export function funcListenBySocket<Z extends any[] = any[]>(e: ReturnType<typeof funcListenCallback<Z>>, status: ()=>boolean, onStop?: ReturnType<typeof funcListenCallback<any>>) {
    type tr2<T extends (...a: any[])=>any> = (a: Parameters<T>[0])=> void//ReturnType<T>
    const {addListen, removeListen, count} = e
    type tt = tr2<Parameters<typeof e.addListen>[0]>
    let x: tt | null = null
    let r2: ((...a: any[]) => void) | null = null
    return {
        callback: (z: (param: Parameters<Parameters<typeof e.addListen>[0]>[0])=> void) => {//(z: tt) => { // (a: tt) => any
            // @ts-ignore
            if (x) x("___STOP");
            if (r2) removeListen(r2)
            x = z
            if (!z) {
                console.log(z)
                console.log(e.count());
                console.trace()
                // return;
            }
            r2 = (a: any) => {status() ? z(a) : removeListen(r2)}// @ts-ignore
            addListen(r2)
        },
        removeCallback: () => {
            if (x) {
                x("___STOP");
                x = null
            }
            if (r2) removeListen(r2)
            return true
        }
    }
}
export const funcListenBySocket1 = funcListenBySocket

export function UseListen<T extends any[]>(data: Parameters<typeof funcListenCallbackBase>[1] = {fast : true}) {
    let t: ((...a: T) => void)// | null = null
    const a = funcListenCallbackBase<T>((e)=>{t = e}, {fast: true, ...data})
    a.run()
    t = a.func
    return [t, a] as const
}


type tDeepKeys<T, T2 extends object, T3 extends any> = // T extends (a?: any) => any ? T :
    {[K in keyof T]: T[K] extends T2 ? T3: T[K] extends object ? T[K] extends (a?: any) => any ? T[K] : T[K] extends (...a: any[]) => any ? T[K] : tDeepKeys<T[K], T2, T3> : T[K]
    }

type obj = {[k: string]: any}
export function CompareKeys<T extends obj, T2 extends obj>(obj1: T, obj2: T2) {
    const k1 = Object.keys(obj1)
    const k2 = Object.keys(obj2)
    return k1.length == k2.length && ((new Set([...k1, ...k2])).size == k2.length)
}
export function CompareKeys2<T extends obj>(obj1: T, keys: string[]) {
    const k1 = Object.keys(obj1)
    return k1.length == keys.length && ((new Set([...k1, ...keys])).size == keys.length)
}
// @ts-ignore
export function DeepCompareKeys2<T, T3 extends unknown>(obj1: T, keys: string[], func: (a: any)=> T3) {
    if (obj1 == null) return null
    if (typeof obj1 == "function") return obj1
    if (obj1 instanceof Function) return obj1
    if (typeof obj1 != "object") return obj1
    if (isProxy(obj1)) return obj1
    if (CompareKeys2(obj1, keys)) {
        return func(obj1)
    }
    // @ts-ignore
    return Object.fromEntries(Object.entries(obj1 as any).map(([k,v])=> [k, DeepCompareKeys2(v, keys, func)] as const))
}

type tt3<T extends any[]> = typeof funcListenCallbackBase<T>
type trr2<T> = T extends ReturnType<tt3<infer R>> ? R : never
type tt33<T extends any[]> = ReturnType<typeof funcListenCallbackBase<T>>
type tt44<T extends any[]> = ReturnType<typeof funcListenBySocket1<T>>
type ttt<T> = {[K in keyof T]: T[K] extends tt33<any> ? tt44<trr2<T[K]>> : T[K] extends typeof Promise ? T[K]  : T[K] extends (...a: any) => any ? T[K] : T[K] extends object ? ttt<T[K]> : T[K] }

// @ts-ignore
export function DeepCompareKeys<T, T2 extends obj, T3 extends unknown>(obj1: T, obj2: T2, func: (a: T2)=> T3) {
    if (obj1 == null) return null
    if (typeof obj1 == "function") return obj1
    if (obj1 instanceof Function) return obj1
    if (typeof obj1 != "object") return obj1
    if (isProxy(obj1)) return obj1
    const keys = Object.keys(obj2)
    if (CompareKeys2(obj1, keys)) { // @ts-ignore
        return func(obj1 as unknown as T2) as unknown as trr2<T>
    }
    // @ts-ignore
    return Object.fromEntries(Object.entries(obj1 as any).map(([k,v])=> [k, DeepCompareKeys2(v, keys, func)] as const))
}

export function deepModifyByListenSocket<T>(obj: T, status: () => boolean){
    return DeepCompareKeys(obj, funcListenCallbackBase(e => {}, ), e => funcListenBySocket1(e, status)) as ttt<T>
}

export function deepModifyByListenSocket2<T>(obj: T, data?: Parameters<typeof funcListenBySocket2>[1]){
    return DeepCompareKeys(obj, funcListenCallbackBase(e => {}, ), e => funcListenBySocket2(e, data)) as ttt<T>
}
// у подписок передает только первый параметр
export function deepModifyByListenSocket3<T>(obj: T, data?: Parameters<typeof funcListenBySocket3>[1]){
    return DeepCompareKeys(obj, funcListenCallbackBase(e => {}, ), e => funcListenBySocket3(e, data)) as ttt<T>
}

export const funcListenBySocketObj = deepModifyByListenSocket

// ... existing code ...
export function PromiseArrayListen<T extends any = unknown>(array: ((() => Promise<T>)|(() => any)|Promise<T>)[]) {
    let ok = 0, errorCount = 0
    const count = array.length
    type tOk = [data: T, i: number, countOk: number, countError: number, count: number]
    type tError = [error: any, i: number, countOk: number, countError: number, count: number]
    const t = UseListen<tOk>()
    const c = UseListen<tError>()
    const a = (data: T, i: number) => {
        ++ok;
        t[0](data, i, ok, errorCount, count)
    }
    const b = (error: any, i: number) => {
        ++errorCount;
        c[0](error, i, ok, errorCount, count)
        throw error
    }
    const arr = array.map((e, i) => e instanceof Promise ? e.then(r => a(r, i)).catch((er: any) => b(er, i))
        : () => (async ()=> e())().then(r => a(r, i)).catch((er: any) => b(er, i)))
    return {
        listenOk: (a: (...d: tOk) => any) => {
            t[1].addListen(a)
            return () => t[1].removeListen(a)
        },
        listenError: (a: (...d: tError) => any) => {
            c[1].addListen(a)
            return () => c[1].removeListen(a)
        },
        promise: {
            all: () => Promise.all(arr),

            allSettled: () => Promise.allSettled(arr),
        },
        getData(){return arr},
        status(){
            return {ok, error: errorCount, count}
        }
    }
}


export type realSocket2<T extends any> = (data: {callback: (data: T)=>void, [key: string]: any}, ...b: any[]) => (any |(()=>any))
export type getTypeCallback<T extends realSocket2<any>> = T extends realSocket2<infer R> ? R : never
type ParametersOther<T extends (forget: any,...args: any) => any> = T extends (forget: any,...args: infer P ) => any ? P : never;

type tr22<T> = T extends undefined ? never : T
export function socketBuffer3<T extends realSocket2<any| any[]>, T2 extends (readonly unknown[])|undefined, T3  extends {[key: string]: unknown}, T4 extends T3|(()=>T3)>(
    func: T,
    callbackMain: (data: getTypeCallback<T>, memo: T3|T4)=> T2,
    memo: T3|T4 = {} as T3
) {
    return (a: Omit<Parameters<T>[0],"callback"> & {callback: (...data: tr22<T2>)=> any}, ...b:  ParametersOther<T>) =>
        func({...a, callback: (v)=>{const z = callbackMain(v, memo); if (z) a.callback(...(z as tr22<T2>))} //  as T
        }, ...b) as ReturnType<T>
}

export function funcListenCallbackSnapshot<T extends realSocket2<any| any[]>, T2 extends (readonly unknown[])|undefined, T3 extends {[key: string]: unknown}, T4 extends T3|(()=>T3)>({func, memo = {} as T4, callbackSave, snapshot}: {
    func: ()=>T,
    callbackSave: (data: getTypeCallback<T>, memo: T3) => T2,
    memo: T4,
    snapshot?: (memo: T4) => T3
}) {
    type tt = typeof socketBuffer3<T, T2, T3, T4>

    let d: ReturnType<tt>|null = null
    const [callback, listenA] = UseListen<Parameters<typeof callbackSave>>({
        event: (type, count, api) => {
            if (type == "remove" && count == 0) {
                api.close()
                // @ts-ignore
                d?.()
            }
            if (type == "add" && count == 1) api.run()
        }});
    const connect = () => {
        // @ts-ignore
        if (d == null) d = socketBuffer3(func(), callbackSave, memo)({callback})
    }
    const run = (...params: Parameters<typeof listenA.addListen>) => {
        if (!listenA.isRun()) {
            snapshot?.(memo)
            connect()
        }
        return listenA.addListen(...params)}
    return {run, snapshot: ()=> snapshot?.(memo), memo, listenA, connect, get disconnect(){return d}}
}
