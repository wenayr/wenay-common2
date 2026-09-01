export type tApiKey = string;
type tType = "UID" | "IP" | tApiKey;
type tWeight = number;
type tTime = number;
type tFunc = {
    timeStamp?: number;
    type: tType;
    weight: number;
};

/** @deprecated use {@link createRateWindow} */
// the default reads THROUGH the global at call time (late binding): callers and
// specs may monkey-patch Date.now after construction, and an injected clock
// must stay the exception, not a behavior change for existing instances
export function funcTimeW(now: () => number = () => Date.now()) {
    type tt1 = [tTime, tWeight];
    type ttt = { [key: tType]: tt1[] };
    const dStatic: ttt = {};
    const data: any[] = [];
    const sortByTime = (arr: tt1[]) => arr.sort((a, b) => a[0] - b[0]);

    return {
        dStatic,
        data,

        // Writes time to array
        add(item: tFunc) {
            if (!dStatic[item.type]) {
                dStatic[item.type] = [];
            }
            dStatic[item.type].push([item.timeStamp ?? now(), item.weight]);
            sortByTime(dStatic[item.type]);
        },

        cleanByTime(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return;
            sortByTime(arr);

            const timeStamp = now();
            // nothing to clean:
            if (arr[0][0] > timeStamp - ms) return;

            // Or, if we want to manually clean:
            let cutIndex = 0;
            while (cutIndex < arr.length && arr[cutIndex][0] < timeStamp - ms) {
                cutIndex++;
            }
            if (cutIndex > 0) {
                arr.splice(0, cutIndex);
            }
        },

        // Returns sum of weight for period of time (ms)
        weight(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;
            sortByTime(arr);

            const timeStamp = now();
            let sum = 0;
            let i = arr.length - 1;

            // Calculate weight from the end until we find older time
            for (; i >= 0; i--) {
                const [_time, _weight] = arr[i];
                if (_time < timeStamp - ms) break;
                sum += _weight;
            }

            // Clean the tail which is already guaranteed to be older (timeStamp - ms)
            // so the array doesn't grow uncontrollably
            if (i >= 0) {
                arr.splice(0, i + 1);
            }
            return sum;
        },

        // Returns timestamp when sum of weights exceeded weight
        byWeight(type: tType, weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;
            sortByTime(arr);

            let sum = 0;
            let i = arr.length - 1;
            let result = 0;

            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    // arr[i+1] — correct (accounts for new request being added); BUT if overflow
                    // most recent element (i=end, arr[i+1] missing) — wait for its ts, NOT 0 (else LoadBase won't wait → ban)
                    result = arr[i + 1]?.[0] ?? arr[i][0];
                    break;
                }
            }
            // To prevent array from growing too much, can clean it
            if (i > 800) {
                arr.splice(0, i - 800);
            }
            return result;
        },

        // Same thing, but with intermediate timeNow
        byWeightTimeNow(type: tType, timeNow = now(), weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;
            sortByTime(arr);

            let sum = 0;
            let i = arr.length - 1;

            // First unwind the array to timeNow
            for (; i >= 0; i--) {
                if (arr[i][0] <= timeNow) break;
            }
            if (i < 0) return 0;

            let result = 0;
            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    result = arr[i + 1]?.[0] ?? arr[i][0];   // fallback to ts of current element, not 0 (see byWeight)
                    break;
                }
            }
            if (i > 800) {
                arr.splice(0, i - 800);
            }
            return result;
        },
    };
}


// Array for storing wait time for async functions
/** @deprecated use {@link rateWindow} */
export const FuncTimeWait = funcTimeW()


// ===========================================================================
// Idiomatic surface — sliding-window rate limiter
// ===========================================================================
// Same instance as funcTimeW(), with self-documenting member names added on top
// of the originals (kept for back-compat):
//   prune     = cleanByTime  (drop entries older than the window)
//   sumWeight = weight        (sum of weight over the window)
//   readyAt   = byWeight      (timestamp when accumulated weight crosses the limit)
export function createRateWindow(deps: {now?: () => number} = {}) {
    const w = funcTimeW(deps.now)
    return {
        ...w,
        prune: w.cleanByTime,
        sumWeight: w.weight,
        readyAt: w.byWeight,
        /** Forget one key entirely — the eviction hook for hosts dropping departed accounts. */
        drop(type: tType) { delete w.dStatic[type] },
    }
}

// shared default instance (idiomatic alias for FuncTimeWait)
export const rateWindow = createRateWindow()
