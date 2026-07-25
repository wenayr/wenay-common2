/**
 * Memoization using Map.
 */

const DEFAULT_TIME_DELTA = 100 * 60 * 1000; // 100 minutes
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
     * Removes the oldest entries from Map, keeping at most half of maxLimits.
     */
    function evictOldest(map: Map<string, CacheEntry<any>>) {
        const keep = Math.max(1, Math.floor(maxLimits / 2));
        const entries = [...map.entries()].sort((a, b) => a[1].time - b[1].time);
        const toRemove = entries.slice(0, entries.length - keep);
        for (const [key] of toRemove) {
            map.delete(key);
        }
        eventUpdate?.();
    }

    function evictOldestFuncs() {
        const keep = Math.max(1, Math.floor(maxLimits / 2));
        const entries = [...memo.entries()].sort((a, b) => {
            // take the maximum time from entries of each function
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

            // old: return cached value even if expired (if exists)
            if (old && entry) {
                return entry.volume;
            }

            if (cacheForFunc.size > maxLimits) {
                console.log("Превышен лимит кэша:", cacheForFunc.size);
                evictOldest(cacheForFunc);
                // entry may have been removed during eviction
                entry = cacheForFunc.get(cacheKey);
            }
            if (memo.size > maxLimits) {
                console.log("Превышен лимит кэша Map:", memo.size);
                evictOldestFuncs();
                // cacheForFunc may have been removed — rebind it
                cacheForFunc = memo.get(data);
                if (!cacheForFunc) {
                    cacheForFunc = new Map<string, CacheEntry<ReturnType<T>>>();
                    memo.set(data, cacheForFunc);
                }
                entry = cacheForFunc.get(cacheKey);
            }

            if (reSave || !entry || entry.time < Date.now() - td) {
                const result = data(...args);

                // Protection against caching rejected promises
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


// // ======================== Tests ========================
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
//         // --- Basic memoization ---
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
//         // --- compareArguments (custom argument comparison) ---
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
//         // --- old: return expired value ---
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
//             now += 5000; // expired
//
//             const memoFnOld = m.func(fn, { old: true });
//             assert(memoFnOld() === 1, "old: возвращает протухшее значение");
//             assert(calls === 1, "old: функция не вызвана повторно");
//         }
//
//         // --- old: falsy value (0) is also cached ---
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
//         // --- timeDelta: TTL expiration ---
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
//         // --- reSave: forced recomputation ---
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
//         // --- cleanAll (clear cache) ---
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
//         // --- Eviction: per-function cache (LRU-like) ---
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
//             // cache: size = 3, not yet exceeded
//             assert(calls === 3, "evict: 3 уникальных вызова");
//
//             memoFn(4); now += 1; // size became 4 > maxLimits=3 → eviction
//             // after eviction keep = floor(3/2) = 1, oldest entries removed
//             // call (4) should still return 40
//             assert(memoFn(4) === 40, "evict: после эвикции значение (4) доступно");
//         }
//
//         // --- Eviction: memo-level (by functions) ---
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
//             // 4 functions > maxLimits=3 → evict oldest functions
//             // Newest (fns[3]) should remain
//             assert(m.memo.has(fns[3]), "evict funcs: самая новая функция осталась");
//             assert(m.memo.size <= 3, "evict funcs: размер memo <= maxLimits");
//         }
//
//         // --- Promises: rejected not cached ---
//         {
//             Date.now = realNow;
//             const m = MemoFunc({ timeDelta: 100_000 });
//             let calls = 0;
//             const fn = () => { calls++; return Promise.reject(new Error("fail")); };
//             const memoFn = m.func(fn);
//
//             const p1 = memoFn();
//             await p1.catch(() => {});
//             // let microtask complete
//             await new Promise(r => setTimeout(r, 10));
//
//             const p2 = memoFn();
//             await p2.catch(() => {});
//
//             assert(calls === 2, "rejected promise: не кэшируется, функция вызвана повторно");
//         }
//
//         // --- Promises: resolved are cached ---
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
//         // --- eventUpdate is called ---
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
// // Run: MEMO_FUNC_TESTS=1 npx tsx MemoFunc.ts
// runMemoFuncTests();
