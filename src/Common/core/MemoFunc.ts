/**
 * Мемоизация с использованием Map.
 */

const DEFAULT_TIME_DELTA = 100 * 60 * 1000; // 100 минут
const DEFAULT_MAX_LIMITS = 10000;

export function MemoFunc(a?: {
    memo?: Map<Function, Map<string, any>>;
    timeDelta?: number;
    maxLimits?: number;
    compareArguments?: (...args: any[]) => string;
    eventUpdate?: () => void;
}) {
    const {
        memo = new Map<Function, Map<string, any>>(),
        timeDelta = DEFAULT_TIME_DELTA,
        maxLimits = DEFAULT_MAX_LIMITS,
        compareArguments = (...args: any[]) => JSON.stringify(args),
        eventUpdate
    } = a ?? {};

    type CacheEntry<T> = { volume: T; time: number };

    function cleanAll(obj: Map<string, any> | Record<string, any>) {
        if (obj instanceof Map) {
            obj.clear();
        } else {
            Object.keys(obj).forEach(key => delete obj[key]);
        }
        eventUpdate?.();
    }

    /**
     * Удаляет самые старые записи из Map, оставляя не более half от maxLimits.
     */
    function evictOldest(map: Map<string, CacheEntry<any>>) {
        const keep = Math.floor(maxLimits / 2);
        const entries = [...map.entries()].sort((a, b) => a[1].time - b[1].time);
        const toRemove = entries.slice(0, entries.length - keep);
        for (const [key] of toRemove) {
            map.delete(key);
        }
        eventUpdate?.();
    }

    function evictOldestFuncs() {
        const keep = Math.floor(maxLimits / 2);
        const entries = [...memo.entries()].sort((a, b) => {
            // берём максимальное время из записей каждой функции
            const maxTimeA = Math.max(...[...a[1].values()].map(e => e.time ?? 0));
            const maxTimeB = Math.max(...[...b[1].values()].map(e => e.time ?? 0));
            return maxTimeA - maxTimeB;
        });
        const toRemove = entries.slice(0, entries.length - keep);
        for (const [key] of toRemove) {
            memo.delete(key);
        }
        eventUpdate?.();
    }

    const func = <T extends (...args: any[]) => any>(
        data: T,
        options?: { old?: boolean; key?: string; timeDelta?: number; reSave?: boolean; compareArguments?: (...args: Parameters<T>) => string }
    ): T => {
        return ((...args: Parameters<T>) => {
            const { reSave = false, key = "", compareArguments: cmp = compareArguments, timeDelta: td = timeDelta, old = false } = options ?? {};

            let cacheForFunc = memo.get(data);
            if (!cacheForFunc) {
                cacheForFunc = new Map<string, CacheEntry<ReturnType<T>>>();
                memo.set(data, cacheForFunc);
            }

            const cacheKey = args.length ? key + cmp(...args) : key;
            let entry: CacheEntry<ReturnType<T>> | undefined = cacheForFunc.get(cacheKey);

            // old: вернуть закэшированное значение, даже если протухло (если есть)
            if (old && entry) {
                return entry.volume;
            }

            if (cacheForFunc.size > maxLimits) {
                console.log("Превышен лимит кэша:", cacheForFunc.size);
                evictOldest(cacheForFunc);
                // entry мог быть удалён при эвикции
                entry = cacheForFunc.get(cacheKey);
            }
            if (memo.size > maxLimits) {
                console.log("Превышен лимит кэша Map:", memo.size);
                evictOldestFuncs();
                // cacheForFunc мог быть удалён — перепривязываем
                cacheForFunc = memo.get(data);
                if (!cacheForFunc) {
                    cacheForFunc = new Map<string, CacheEntry<ReturnType<T>>>();
                    memo.set(data, cacheForFunc);
                }
                entry = cacheForFunc.get(cacheKey);
            }

            if (reSave || !entry || entry.time < Date.now() - td) {
                const result = data(...args);

                // Защита от кэширования rejected промисов
                if (result instanceof Promise) {
                    entry = { volume: result as ReturnType<T>, time: Date.now() };
                    cacheForFunc.set(cacheKey, entry);
                    const savedEntry = entry;
                    const savedCacheForFunc = cacheForFunc;
                    result.catch(() => {
                        if (savedCacheForFunc.get(cacheKey) === savedEntry) {
                            savedCacheForFunc.delete(cacheKey);
                        }
                    });
                    eventUpdate?.();
                    return entry.volume;
                }

                entry = { volume: result, time: Date.now() };
                cacheForFunc.set(cacheKey, entry);
                eventUpdate?.();
            }
            return entry.volume;
        }) as T;
    };

    return {
        func,
        cleanAll,
        get memo() {
            return memo;
        }
    };
}
export type MemoFuncOpt = Parameters<ReturnType<typeof MemoFunc>["func"]>[1];
export const MemoFuncConvert = <T extends () => any>(func: T, memo: ReturnType<typeof MemoFunc>) => ((opt?: MemoFuncOpt) => memo.func(func, opt)() as ReturnType<T>);


// // ======================== Тесты ========================
//
// async function runMemoFuncTests() {
//     const assert = (condition: boolean, msg: string) => {
//         if (!condition) throw new Error("FAIL: " + msg);
//         console.log("  ✓", msg);
//     };
//
//     const realNow = Date.now;
//
//     try {
//         console.log("\n=== MemoFunc tests ===\n");
//
//         // --- Базовая мемоизация ---
//         {
//             const m = MemoFunc({ timeDelta: 10_000 });
//             let calls = 0;
//             const sum = (a: number, b: number) => { calls++; return a + b; };
//             const memoSum = m.func(sum);
//
//             assert(memoSum(1, 2) === 3, "sum(1,2) = 3");
//             assert(memoSum(1, 2) === 3, "sum(1,2) из кэша");
//             assert(calls === 1, "функция вызвана 1 раз для (1,2)");
//             assert(memoSum(2, 3) === 5, "sum(2,3) = 5");
//             assert(calls === 2, "функция вызвана 2 раза (разные аргументы)");
//         }
//
//         // --- compareArguments ---
//         {
//             const m = MemoFunc({ timeDelta: 10_000 });
//             let calls = 0;
//             const sum = (a: number, b: number) => { calls++; return a + b; };
//             const memoSum = m.func(sum, { compareArguments: (a, b) => `${a}|${b}` });
//
//             memoSum(1, 2);
//             memoSum(1, 2);
//             memoSum(2, 3);
//             assert(calls === 2, "compareArguments: 2 вызова для разных аргументов");
//         }
//
//         // --- old: возврат протухшего значения ---
//         {
//             let now = 1_000_000;
//             Date.now = () => now;
//
//             const m = MemoFunc({ timeDelta: 1000 });
//             let calls = 0;
//             const fn = () => { calls++; return calls; };
//
//             const memoFn = m.func(fn);
//             assert(memoFn() === 1, "old: первый вызов = 1");
//
//             now += 5000; // протухло
//
//             const memoFnOld = m.func(fn, { old: true });
//             assert(memoFnOld() === 1, "old: возвращает протухшее значение");
//             assert(calls === 1, "old: функция не вызвана повторно");
//         }
//
//         // --- old: falsy-значение (0) тоже кэшируется ---
//         {
//             Date.now = () => 1_000_000;
//             const m = MemoFunc({ timeDelta: 10_000 });
//             let calls = 0;
//             const returnZero = () => { calls++; return 0; };
//             const memoZero = m.func(returnZero, { old: true });
//             memoZero();
//             memoZero();
//             assert(calls === 1, "old + falsy(0): функция вызвана 1 раз");
//         }
//
//         // --- timeDelta: истечение TTL ---
//         {
//             let now = 1_000_000;
//             Date.now = () => now;
//
//             const m = MemoFunc({ timeDelta: 1000 });
//             let calls = 0;
//             const fn = () => { calls++; return calls; };
//             const memoFn = m.func(fn, { timeDelta: 1000 });
//
//             memoFn();
//             now += 999;
//             memoFn();
//             assert(calls === 1, "timeDelta: до истечения — из кэша");
//             now += 2;
//             memoFn();
//             assert(calls === 2, "timeDelta: после истечения — перевычисление");
//         }
//
//         // --- reSave: принудительное перевычисление ---
//         {
//             Date.now = () => 1_000_000;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return calls; };
//
//             const memoFn = m.func(fn);
//             assert(memoFn() === 1, "reSave: первый вызов");
//             assert(memoFn() === 1, "reSave: из кэша");
//
//             const reSaved = m.func(fn, { reSave: true })();
//             assert(reSaved === 2, "reSave: принудительно перевычислено");
//             assert(calls === 2, "reSave: 2 вызова");
//         }
//
//         // --- cleanAll ---
//         {
//             Date.now = () => 1_000_000;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return calls; };
//             const memoFn = m.func(fn);
//
//             memoFn();
//             assert(calls === 1, "cleanAll: до очистки — 1 вызов");
//
//             const cacheForFn = m.memo.get(fn);
//             m.cleanAll(cacheForFn!);
//
//             memoFn();
//             assert(calls === 2, "cleanAll: после очистки — перевычисление");
//         }
//
//         // --- Эвикция: per-function cache (LRU-подобная) ---
//         {
//             let now = 1_000_000;
//             Date.now = () => now;
//
//             const m = MemoFunc({ timeDelta: 100_000, maxLimits: 3 });
//             let calls = 0;
//             const fn = (x: number) => { calls++; return x * 10; };
//             const memoFn = m.func(fn);
//
//             memoFn(1); now += 1;
//             memoFn(2); now += 1;
//             memoFn(3); now += 1;
//             // кэш: size = 3, ещё не превысили
//             assert(calls === 3, "evict: 3 уникальных вызова");
//
//             memoFn(4); now += 1; // size стал 4 > maxLimits=3 → эвикция
//             // после эвикция keep = floor(3/2) = 1, удалятся самые старые
//             // вызов (4) всё равно должен вернуть 40
//             assert(memoFn(4) === 40, "evict: после эвикции значение (4) доступно");
//         }
//
//         // --- Эвикция: memo-уровень (по функциям) ---
//         {
//             let now = 1_000_000;
//             Date.now = () => now;
//
//             const m = MemoFunc({ timeDelta: 100_000, maxLimits: 3 });
//             const fns: Array<(x: number) => number> = [];
//             for (let i = 0; i < 4; i++) {
//                 const fn = (x: number) => x + i;
//                 fns.push(fn);
//                 const memoFn = m.func(fn);
//                 memoFn(1);
//                 now += 1;
//             }
//             // 4 функции > maxLimits=3 → эвикция самых старых функций
//             // Самая новая (fns[3]) должна остаться
//             assert(m.memo.has(fns[3]), "evict funcs: самая новая функция осталась");
//             assert(m.memo.size <= 3, "evict funcs: размер memo <= maxLimits");
//         }
//
//         // --- Промисы: rejected не кэшируются ---
//         {
//             Date.now = realNow;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return Promise.reject(new Error("fail")); };
//             const memoFn = m.func(fn);
//
//             const p1 = memoFn();
//             await p1.catch(() => {});
//             // даём микротаску отработать
//             await new Promise(r => setTimeout(r, 10));
//
//             const p2 = memoFn();
//             await p2.catch(() => {});
//
//             assert(calls === 2, "rejected promise: не кэшируется, функция вызвана повторно");
//         }
//
//         // --- Промисы: resolved кэшируются ---
//         {
//             Date.now = realNow;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return Promise.resolve(42); };
//             const memoFn = m.func(fn);
//
//             const r1 = await memoFn();
//             const r2 = await memoFn();
//             assert(r1 === 42 && r2 === 42, "resolved promise: значение 42");
//             assert(calls === 1, "resolved promise: кэшируется, 1 вызов");
//         }
//
//         // --- eventUpdate вызывается ---
//         {
//             Date.now = () => 1_000_000;
//             let updates = 0;
//             const m = MemoFunc({ timeDelta: 100_000, eventUpdate: () => updates++ });
//             const fn = (x: number) => x;
//             const memoFn = m.func(fn);
//             memoFn(1);
//             assert(updates >= 1, "eventUpdate: вызван при записи в кэш");
//         }
//
//         // --- MemoFuncConvert ---
//         {
//             Date.now = () => 1_000_000;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return 99; };
//             const converted = MemoFuncConvert(fn, m);
//
//             assert(converted() === 99, "MemoFuncConvert: возвращает 99");
//             assert(converted() === 99, "MemoFuncConvert: из кэша");
//             assert(calls === 1, "MemoFuncConvert: 1 вызов");
//         }
//
//         console.log("\n=== Все тесты пройдены ✅ ===\n");
//
//     } finally {
//         Date.now = realNow;
//     }
// }
//
// // Запуск: MEMO_FUNC_TESTS=1 npx ts-node MemoFunc.ts
// runMemoFuncTests();