"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateWindow = exports.FuncTimeWait = void 0;
exports.funcTimeW = funcTimeW;
exports.createRateWindow = createRateWindow;
function funcTimeW() {
    const dStatic = {};
    const data = [];
    const sortByTime = (arr) => arr.sort((a, b) => a[0] - b[0]);
    return {
        dStatic,
        data,
        add(item) {
            if (!dStatic[item.type]) {
                dStatic[item.type] = [];
            }
            dStatic[item.type].push([item.timeStamp ?? Date.now(), item.weight]);
            sortByTime(dStatic[item.type]);
        },
        cleanByTime(type, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0)
                return;
            sortByTime(arr);
            const timeStamp = Date.now();
            if (arr[0][0] > timeStamp - ms)
                return;
            let cutIndex = 0;
            while (cutIndex < arr.length && arr[cutIndex][0] < timeStamp - ms) {
                cutIndex++;
            }
            if (cutIndex > 0) {
                arr.splice(0, cutIndex);
            }
        },
        weight(type, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0)
                return 0;
            sortByTime(arr);
            const timeStamp = Date.now();
            let sum = 0;
            let i = arr.length - 1;
            for (; i >= 0; i--) {
                const [_time, _weight] = arr[i];
                if (_time < timeStamp - ms)
                    break;
                sum += _weight;
            }
            if (i >= 0) {
                arr.splice(0, i + 1);
            }
            return sum;
        },
        byWeight(type, weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0)
                return 0;
            sortByTime(arr);
            let sum = 0;
            let i = arr.length - 1;
            let result = 0;
            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    result = arr[i + 1]?.[0] ?? arr[i][0];
                    break;
                }
            }
            if (i > 800) {
                arr.splice(0, i - 800);
            }
            return result;
        },
        byWeightTimeNow(type, timeNow = Date.now(), weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0)
                return 0;
            sortByTime(arr);
            let sum = 0;
            let i = arr.length - 1;
            for (; i >= 0; i--) {
                if (arr[i][0] <= timeNow)
                    break;
            }
            if (i < 0)
                return 0;
            let result = 0;
            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    result = arr[i + 1]?.[0] ?? arr[i][0];
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
exports.FuncTimeWait = funcTimeW();
function createRateWindow() {
    const w = funcTimeW();
    return {
        ...w,
        prune: w.cleanByTime,
        sumWeight: w.weight,
        readyAt: w.byWeight,
    };
}
exports.rateWindow = createRateWindow();
