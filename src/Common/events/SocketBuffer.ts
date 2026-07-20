import {listen} from "./Listen";

export type SocketSource<T extends any> = (data: {
    callback: (data: T) => void,
    [key: string]: any
}, ...b: any[]) => (any | (() => any))

export type SocketPayload<T extends SocketSource<any>> = T extends SocketSource<infer R> ? R : never

type ParametersOther<T extends (forget: any, ...args: any) => any> = T extends (forget: any, ...args: infer P) => any ? P : never;
type NonUndefined<T> = T extends undefined ? never : T

export function socketBuffer<T extends SocketSource<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown
}, T4 extends T3 | (() => T3)>(
    func: T,
    callbackMain: (data: SocketPayload<T>, memo: T3 | T4) => T2,
    memo: T3 | T4 = {} as T3
) {
    return (a: Omit<Parameters<T>[0], "callback"> & {
        callback: (...data: NonUndefined<T2>) => any
    }, ...b: ParametersOther<T>) =>
        func({
            ...a, callback: (v) => {
                const z = callbackMain(v, memo);
                if (z) a.callback(...(z as NonUndefined<T2>))
            }
        }, ...b) as ReturnType<T>
}


export function listenSnapshot<T extends SocketSource<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown
}, T4 extends T3 | (() => T3)>({func, memo = {} as T4, callbackSave, snapshot}: {
    func: () => T,
    callbackSave: (data: SocketPayload<T>, memo: T3) => T2,
    memo: T4,
    snapshot?: (memo: T4) => T3
}) {
    type BufferedSocket = typeof socketBuffer<T, T2, T3, T4>

    let d: ReturnType<BufferedSocket> | null = null
    const [callback, listenA] = listen<Parameters<typeof callbackSave>>({
        event: (type, count, api) => {
            if (type == "remove" && count == 0) {
                api.close()
                // @ts-ignore
                d?.()
                // without reset next connect() sees d != null and doesn't reconnect
                d = null
            }
            if (type == "add" && count == 1) api.run()
        }
    });
    const connect = () => {
        // @ts-ignore
        if (d == null) d = socketBuffer(func(), callbackSave, memo)({callback})
    }
    const run = (...params: Parameters<typeof listenA.on>) => {
        if (!listenA.isRunning()) {
            snapshot?.(memo)
            connect()
        }
        return listenA.on(...params)
    }
    return {
        run, snapshot: () => snapshot?.(memo), memo, listenA, connect, get disconnect() {
            return d
        }
    }
}

