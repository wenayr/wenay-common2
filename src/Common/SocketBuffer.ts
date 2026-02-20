import {UseListen} from "./Listen";

export type realSocket2<T extends any> = (data: {
    callback: (data: T) => void,
    [key: string]: any
}, ...b: any[]) => (any | (() => any))
export type getTypeCallback<T extends realSocket2<any>> = T extends realSocket2<infer R> ? R : never
type ParametersOther<T extends (forget: any, ...args: any) => any> = T extends (forget: any, ...args: infer P) => any ? P : never;
type tr22<T> = T extends undefined ? never : T

export function socketBuffer3<T extends realSocket2<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown
}, T4 extends T3 | (() => T3)>(
    func: T,
    callbackMain: (data: getTypeCallback<T>, memo: T3 | T4) => T2,
    memo: T3 | T4 = {} as T3
) {
    return (a: Omit<Parameters<T>[0], "callback"> & {
        callback: (...data: tr22<T2>) => any
    }, ...b: ParametersOther<T>) =>
        func({
            ...a, callback: (v) => {
                const z = callbackMain(v, memo);
                if (z) a.callback(...(z as tr22<T2>))
            } //  as T
        }, ...b) as ReturnType<T>
}

export function funcListenCallbackSnapshot<T extends realSocket2<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown
}, T4 extends T3 | (() => T3)>({func, memo = {} as T4, callbackSave, snapshot}: {
    func: () => T,
    callbackSave: (data: getTypeCallback<T>, memo: T3) => T2,
    memo: T4,
    snapshot?: (memo: T4) => T3
}) {
    type tt = typeof socketBuffer3<T, T2, T3, T4>

    let d: ReturnType<tt> | null = null
    const [callback, listenA] = UseListen<Parameters<typeof callbackSave>>({
        event: (type, count, api) => {
            if (type == "remove" && count == 0) {
                api.close()
                // @ts-ignore
                d?.()
            }
            if (type == "add" && count == 1) api.run()
        }
    });
    const connect = () => {
        // @ts-ignore
        if (d == null) d = socketBuffer3(func(), callbackSave, memo)({callback})
    }
    const run = (...params: Parameters<typeof listenA.addListen>) => {
        if (!listenA.isRun()) {
            snapshot?.(memo)
            connect()
        }
        return listenA.addListen(...params)
    }
    return {
        run, snapshot: () => snapshot?.(memo), memo, listenA, connect, get disconnect() {
            return d
        }
    }
}