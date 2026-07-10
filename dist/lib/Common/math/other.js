"use strict";
function PriceTOSumPercent(price) {
    const base = price[0];
    return base ? price.map(e => e / base) : price.map(() => 0);
}
function strategyStepOfStepAll(symbols_) {
    const symbols = symbols_.map(e => ({ price: PriceTOSumPercent(e.price), key: e.key }));
    const minK = 0;
    const percentM = 1 / 100;
    const result = [];
    for (let i = 0; i < symbols.length; i++) {
        const tt = { key: symbols[i].key, id: i, leadersId: [], leadersKey: [] };
        result.push(tt);
        for (let y = 0; y < symbols.length; y++) {
            if (i == y)
                continue;
            const r = strategyStepOfStep({ t1: symbols[i].price, t2: symbols[y].price, minK, percentM });
            if (r > 0) {
                tt.leadersKey.push({ key: symbols[y].key, score: r });
                tt.leadersId.push(y);
            }
        }
        tt.leadersKey = tt.leadersKey.sort((a, b) => b.score - a.score);
    }
    return result;
}
function strategyStepOfStep({ t1, t2, minK: _minK, percentM: _percentM, onlyBuy: _onlyBuy }) {
    const onlyBuy = !!_onlyBuy;
    const minK = _minK ?? 0;
    const percentM = _percentM ?? 1 / 100;
    const conArr = (arr) => {
        let last = arr[0], result = 0;
        return arr.map(e => {
            const r = e - last;
            last = e;
            result += r;
            result = result * (1 - percentM);
            return result;
        });
    };
    const [r1, r2] = [t1, t2].map(e => conArr(e));
    const length = r1.length;
    let m1 = 0, m2 = 0;
    const result1 = [0];
    let [lastD1, lastD2] = [0, 0];
    for (let i = 1; i < length; i++) {
        const [d1, d2] = [r1[i], r2[i]];
        const [p1, p2] = [t1[i] - t1[i - 1], t2[i] - t2[i - 1]];
        result1.push((p1) * (d2 - d1));
        [lastD1, lastD2] = [d1, d2];
    }
    const day = { profitDays: 0, lossDays: 0, profit: 0, loss: 0 };
    for (let i = 0; i < result1.length; i++) {
        if (result1[i] > 0) {
            day.profitDays++;
            day.profit += result1[i];
        }
        if (result1[i] < 0) {
            day.lossDays++;
            day.loss += result1[i];
        }
    }
    const k1 = day.profitDays / result1.length;
    const k1b = day.loss / result1.length;
    const k2 = day.profit / ((day.profit + Math.abs(day.loss)) || 1);
    let flag = -1;
    if (day.profitDays > day.lossDays && day.profit > day.loss) {
        flag = 1;
    }
    return k1 * k2 * flag;
}
