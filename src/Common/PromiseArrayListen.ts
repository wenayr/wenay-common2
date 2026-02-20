// ... existing code ...
import {UseListen} from "./Listen";

export function PromiseArrayListen<T extends any = unknown>(array: ((() => Promise<T>) | (() => any) | Promise<T>)[]) {
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
        : () => (async () => e())().then(r => a(r, i)).catch((er: any) => b(er, i)))
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
        getData() {
            return arr
        },
        status() {
            return {ok, error: errorCount, count}
        }
    }
}