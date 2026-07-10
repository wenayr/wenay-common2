"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrelationRollingByBuffer = CorrelationRollingByBuffer;
function CorrelationRollingByBuffer(data) {
    let setting = { ...data };
    const map = new Map();
    const defBuf = () => ({
        sum1: 0, sum2: 0,
        pow1: 0, pow2: 0,
        mulSum: 0, step: 0,
        history1: [], history2: []
    });
    const getBuffer = (key1, key2) => {
        let a1 = map.get(key1);
        if (!a1)
            map.set(key1, a1 = new Map());
        let a2 = a1.get(key2);
        if (!a2)
            a1.set(key2, a2 = defBuf());
        return a2;
    };
    return {
        init(data) { setting = { ...data }; },
        clear(data) {
            map.clear();
            if (data)
                this.init(data);
        },
        remove(key1, key2) {
            if (key2 === undefined)
                map.delete(key1);
            else
                map.get(key1)?.delete(key2);
        },
        corr2(val1, val2, key1, key2) {
            const buffer = getBuffer(key1, key2);
            buffer.history1.push(val1);
            buffer.history2.push(val2);
            let dropped1 = 0;
            let dropped2 = 0;
            if (buffer.history1.length > setting.max) {
                dropped1 = buffer.history1.shift();
                dropped2 = buffer.history2.shift();
            }
            else {
                buffer.step++;
            }
            buffer.sum1 = buffer.sum1 + val1 - dropped1;
            buffer.sum2 = buffer.sum2 + val2 - dropped2;
            buffer.pow1 = buffer.pow1 + val1 ** 2 - dropped1 ** 2;
            buffer.pow2 = buffer.pow2 + val2 ** 2 - dropped2 ** 2;
            buffer.mulSum = buffer.mulSum + (val1 * val2) - (dropped1 * dropped2);
            return calculatePearson(buffer, buffer.history1.length);
        }
    };
}
function calculatePearson(buffer, count) {
    if (count < 2)
        return { corr: 0 };
    const { sum1, sum2, pow1, pow2, mulSum } = buffer;
    const { sqrt } = Math;
    if (!Number.isFinite(sum1) || !Number.isFinite(sum2) || !Number.isFinite(mulSum)) {
        console.error("Invalid math values in correlation calculation", { sum1, sum2, mulSum });
        return { corr: 0 };
    }
    const variance1 = count * pow1 - sum1 ** 2;
    const variance2 = count * pow2 - sum2 ** 2;
    if (variance1 <= 0 || variance2 <= 0) {
        return { corr: 0 };
    }
    const dense = sqrt(variance1 * variance2);
    const numerator = count * mulSum - (sum1 * sum2);
    const result = numerator / dense;
    if (result > 1)
        return { corr: 1 };
    if (result < -1)
        return { corr: -1 };
    return { corr: result };
}
