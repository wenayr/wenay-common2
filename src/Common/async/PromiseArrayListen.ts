// ... existing code ...
import {UseListen} from "../events/Listen";

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
        // НЕ перевыбрасываем: иначе в режиме .all() каждое не-первое отклонение становится unhandled rejection.
        // Ошибки доступны через listenError / .allSettled(); .all() теперь всегда резолвится.
    }
    const arr = array.map((e, i) => e instanceof Promise ? e.then(r => a(r, i)).catch((er: any) => b(er, i))
        : () => (async () => e())().then(r => a(r, i)).catch((er: any) => b(er, i)))

    // Promise-входы уже стартовали выше (eager). Фабрики-входы стали thunk'ами (lazy) — но
    // Promise.all/allSettled НЕ вызывают thunk'и, поэтому без этого фабрика не запустится никогда
    // (а .all() зарезолвится самой функцией). startAll() вызывает каждый thunk РОВНО ОДИН раз
    // (мемоизация в `started`), так что all/allSettled/getData делят один и тот же запуск.
    const started: Promise<any>[] = []
    const startAll = () => arr.map((x, i) => started[i] ??= (typeof x === 'function' ? x() : x))

    return {
        listenOk: (a: (...d: tOk) => any) => t[1].addListen(a),
        listenError: (a: (...d: tError) => any) => c[1].addListen(a),
        promise: {
            all: () => Promise.all(startAll()),

            allSettled: () => Promise.allSettled(startAll()),
        },
        getData() {
            return startAll()
        },
        status() {
            return {ok, error: errorCount, count}
        }
    }
}