import {BSearch} from "./core/common";

export type tApiKey = string;
// Хак (string & {}), чтобы строковые литералы не схлопнулись до просто string
type tType = "UID" | "IP" | (string & {});
type tWeight = number;
type tTime = number;
type tFunc = {
    timeStamp?: number;
    type: tType;
    weight: number;
};

export function funcTimeW(maxHistoryElements = 800) {
    type tt1 = [tTime, tWeight];
    type ttt = { [key: string]: tt1[] };
    const dStatic: ttt = {};

    function getInsertIndex(arr: tt1[], timeStamp: tTime) {
        if (arr.length === 0) return 0;
        if (timeStamp >= arr[arr.length - 1][0]) return arr.length;
        if (timeStamp <= arr[0][0]) return 0;

        const index = BSearch(arr, timeStamp, (a, b) => a[0] - b, "greatOrEqual", "ascend");
        return index === -1 ? arr.length : index;
    }

    function cleanupEmptyKey(type: tType) {
        if (dStatic[type] && dStatic[type].length === 0) {
            delete dStatic[type];
        }
    }

    return {
        dStatic,

        add(item: tFunc) {
            const arr = (dStatic[item.type] ??= []);
            const timeStamp = item.timeStamp ?? Date.now();
            const insertIndex = getInsertIndex(arr, timeStamp);
            if (insertIndex === arr.length) {
                arr.push([timeStamp, item.weight]);
            } else {
                arr.splice(insertIndex, 0, [timeStamp, item.weight]);
            }
        },

        cleanByTime(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return;

            const cutoff = Date.now() - ms;
            if (arr[0][0] > cutoff) return;

            const cutIndex = BSearch(arr, cutoff, (a, b) => a[0] - b, "greatOrEqual", "ascend");
            if (cutIndex === -1) {
                arr.splice(0, arr.length);
            } else if (cutIndex > 0) {
                arr.splice(0, cutIndex);
            }
            cleanupEmptyKey(type);
        },

        // Объединенный метод для вычисления веса (заменяет weight и weightNow)
        weight(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;

            const cutoff = Date.now() - ms;
            let sum = 0;
            let i = arr.length - 1;

            for (; i >= 0; i--) {
                const [_time, _weight] = arr[i];
                if (_time < cutoff) break;
                sum += _weight;
            }

            if (i >= 0) {
                arr.splice(0, i + 1);
                cleanupEmptyKey(type);
            }
            return sum;
        },

        // Универсальный метод для вычисления по весу, заменяющий byWeight и byWeightTimeNow
        byWeight(type: tType, weight = 50000, timeNow = Date.now()) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;

            let sum = 0;
            let i = arr.length - 1;

            // Пропускаем элементы, которые больше timeNow
            for (; i >= 0; i--) {
                if (arr[i][0] <= timeNow) break;
            }

            if (i < 0) return 0;

            let result = 0;
            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    result = arr[i + 1]?.[0] ?? 0;
                    break;
                }
            }

            // Очистка старых данных за пределами maxHistoryElements (800 по умолчанию)
            if (i > maxHistoryElements) {
                arr.splice(0, i - maxHistoryElements);
                cleanupEmptyKey(type);
            }

            return result;
        },

        removeKey(type: tType) {
            delete dStatic[type];
        }
    };
}

export const FuncTimeWait = funcTimeW();

export function testFuncTimeW() {
    const tracker = funcTimeW();
    const type: tType = "UID";
    const now = Date.now();

    tracker.add({type, weight: 1, timeStamp: now});
    tracker.add({type, weight: 2, timeStamp: now - 500});
    tracker.add({type, weight: 3, timeStamp: now + 500});
    console.log("funcTimeW order", tracker.dStatic);

    tracker.cleanByTime(type, 200);
    console.log("funcTimeW cleanByTime", tracker.dStatic);

    const w = tracker.weight(type, 1000);
    console.log("funcTimeW weight 1s", w, tracker.dStatic);
}