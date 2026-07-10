"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoFuncConvert = void 0;
exports.MemoFunc = MemoFunc;
const DEFAULT_TIME_DELTA = 100 * 60 * 1000;
const DEFAULT_MAX_LIMITS = 10000;
function MemoFunc(a) {
    const { memo = new Map(), timeDelta = DEFAULT_TIME_DELTA, maxLimits = DEFAULT_MAX_LIMITS, compareArguments = (...args) => JSON.stringify(args), eventUpdate } = a ?? {};
    function cleanAll(obj) {
        if (obj instanceof Map) {
            obj.clear();
        }
        else {
            Object.keys(obj).forEach(key => delete obj[key]);
        }
        eventUpdate?.();
    }
    function evictOldest(map) {
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
    const func = (data, options) => {
        return ((...args) => {
            const { reSave = false, key = "", compareArguments: cmp = compareArguments, timeDelta: td = timeDelta, old = false } = options ?? {};
            let cacheForFunc = memo.get(data);
            if (!cacheForFunc) {
                cacheForFunc = new Map();
                memo.set(data, cacheForFunc);
            }
            const cacheKey = args.length ? key + cmp(...args) : key;
            let entry = cacheForFunc.get(cacheKey);
            if (old && entry) {
                return entry.volume;
            }
            if (cacheForFunc.size > maxLimits) {
                console.log("Превышен лимит кэша:", cacheForFunc.size);
                evictOldest(cacheForFunc);
                entry = cacheForFunc.get(cacheKey);
            }
            if (memo.size > maxLimits) {
                console.log("Превышен лимит кэша Map:", memo.size);
                evictOldestFuncs();
                cacheForFunc = memo.get(data);
                if (!cacheForFunc) {
                    cacheForFunc = new Map();
                    memo.set(data, cacheForFunc);
                }
                entry = cacheForFunc.get(cacheKey);
            }
            if (reSave || !entry || entry.time < Date.now() - td) {
                const result = data(...args);
                if (result instanceof Promise) {
                    entry = { volume: result, time: Date.now() };
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
        });
    };
    return {
        func,
        cleanAll,
        get memo() {
            return memo;
        }
    };
}
const MemoFuncConvert = (func, memo) => ((opt) => memo.func(func, opt)());
exports.MemoFuncConvert = MemoFuncConvert;
