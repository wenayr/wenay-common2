import {listen} from "../events/Listen"

export function promiseProgress<T extends any = unknown>(array: ((() => Promise<T>) | (() => any) | Promise<T>)[]) {
    let ok = 0, errorCount = 0
    const count = array.length
    type OkEvent = [data: T, i: number, countOk: number, countError: number, count: number]
    type ErrorEvent = [error: any, i: number, countOk: number, countError: number, count: number]
    const okEvents = listen<OkEvent>()
    const errorEvents = listen<ErrorEvent>()
    const emitOk = (data: T, i: number) => {
        ++ok
        okEvents[0](data, i, ok, errorCount, count)
    }
    const emitError = (error: any, i: number) => {
        ++errorCount
        errorEvents[0](error, i, ok, errorCount, count)
    }
    const wrap = (promise: Promise<T>, i: number) =>
        promise.then(r => { emitOk(r, i); return r }).catch((er: any) => { emitError(er, i); throw er })
    const arr = array.map((e, i) => e instanceof Promise ? wrap(e, i) : () => wrap((async () => e())(), i))

    const started: Promise<any>[] = []
    const startAll = () => arr.map((x, i) => started[i] ??= (typeof x === "function" ? x() : x))
    const onOk = (cb: (...data: OkEvent) => any) => okEvents[1].on(cb)
    const onError = (cb: (...data: ErrorEvent) => any) => errorEvents[1].on(cb)
    const all = () => Promise.all(startAll())
    const allSettled = () => Promise.allSettled(startAll())
    const items = () => startAll()
    const stats = () => ({ok, error: errorCount, count})

    return {onOk, onError, all, allSettled, items, stats}
}