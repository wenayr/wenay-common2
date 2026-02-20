
/**
 * Мемоизация с использованием Map.
 */

const DEFAULT_TIME_DELTA = 100 * 60 * 1000; // 100 минут
const DEFAULT_MAX_LIMITS = 10000;

export function MemoFunc(a?: {
    memo?: Map<any, Map<string, any>>;
    timeDelta?: number;
    maxLimits?: number;
    compareArguments?: (...args: any[]) => string;
    eventUpdate?: () => void;
}) {
    const {
        memo = new Map<any, Map<string, any>>(),
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

            if (old && entry) {
                return entry.volume;
            }
            if (cacheForFunc.size > maxLimits) {
                console.log("Превышен лимит кэша:", cacheForFunc.size);
                cleanAll(cacheForFunc);
            }
            if (memo.size > maxLimits) {
                console.log("Превышен лимит кэша Map:", memo.size);
                memo.clear();
            }
            if (reSave || !entry || entry.time < Date.now() - td) {
                const result = data(...args);

                // Защита от кэширования rejected промисов
                if (result instanceof Promise) {
                    entry = { volume: result as ReturnType<T>, time: Date.now() };
                    cacheForFunc.set(cacheKey, entry);
                    const savedEntry = entry;
                    result.catch(() => {
                        if (cacheForFunc!.get(cacheKey) === savedEntry) {
                            cacheForFunc!.delete(cacheKey);
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


// export function runMemoFuncTests() {
//     console.log("MemoFunc tests: start");
//
//     const memo = MemoFunc({ timeDelta: 1000 });
//     let callCount = 0;
//     const sum = (a: number, b: number) => {
//         callCount += 1;
//         return a + b;
//     };
//
//     const memoSum = memo.func(sum, {
//         compareArguments: (a, b) => `${a}|${b}`
//     });
//
//     memoSum(1, 2);
//     memoSum(1, 2);
//     memoSum(2, 3);
//     console.log("compareArguments spread ok:", callCount === 2, "callCount:", callCount);
//
//     let zeroCallCount = 0;
//     const returnZero = () => {
//         zeroCallCount += 1;
//         return 0;
//     };
//     const memoZero = memo.func(returnZero, { old: true });
//     memoZero();
//     memoZero();
//     console.log("old returns falsy cache:", zeroCallCount === 1, "zeroCallCount:", zeroCallCount);
//
//     const realNow = Date.now;
//     try {
//         let now = 1_000_000;
//         Date.now = () => now;
//         let tdCallCount = 0;
//         const bump = () => {
//             tdCallCount += 1;
//             return tdCallCount;
//         };
//         const memoBump = memo.func(bump, { timeDelta: 1000 });
//         memoBump();
//         now += 999;
//         memoBump();
//         now += 2;
//         memoBump();
//         console.log("timeDelta expiry:", tdCallCount === 2, "tdCallCount:", tdCallCount);
//
//         let reSaveCallCount = 0;
//         const touch = () => {
//             reSaveCallCount += 1;
//             return reSaveCallCount;
//         };
//         const memoTouch = memo.func(touch);
//         memoTouch();
//         memoTouch();
//         memo.func(touch, { reSave: true })();
//         console.log("reSave forces recompute:", reSaveCallCount === 2, "reSaveCallCount:", reSaveCallCount);
//     } finally {
//         Date.now = realNow;
//     }
//
//     console.log("MemoFunc tests: end");
// }
// runMemoFuncTests();
// if (typeof process !== "undefined" && process?.env?.['MEMO_FUNC_TESTS'] === "1") {
//     runMemoFuncTests();
// }