"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoadQuoteBase = LoadQuoteBase;
const funcTimeWait_1 = require("../Common/funcTimeWait");
const Time_1 = require("../Common/Time");
const common_1 = require("../Common/core/common");
function LoadQuoteBase(setting, data) {
    const { base, maxLoadBars, countConnect, intervalToName } = setting;
    const maxLoadBars2 = setting.maxLoadBars2 ?? maxLoadBars;
    const startMap = new Map();
    const keyName = setting.nameKey ?? "loadKey";
    const time = setting.time ?? 60000;
    const other = data;
    const getDataEl = (a) => setting.controlTimeToNumber?.(a);
    async function waitLimit(weight = 1) {
        const t1 = funcTimeWait_1.FuncTimeWait.byWeight(keyName, setting.countConnect) - (Date.now() - time) + 1;
        if (t1 > 0) {
            funcTimeWait_1.FuncTimeWait.add({ type: keyName, weight: weight, timeStamp: Date.now() + t1 });
            await (0, common_1.sleepAsync)(t1);
        }
        else {
            funcTimeWait_1.FuncTimeWait.add({ type: keyName, weight: weight, timeStamp: Date.now() });
        }
    }
    const mapTimeToName = new Map(intervalToName.map((e) => [e.time.sec, e]));
    const _fetch = other?.fetch ?? fetch;
    return async (info) => {
        const infoTF = mapTimeToName.get(info.tf.sec);
        if (!_fetch)
            throw "_fetch - not defined";
        if (!infoTF)
            throw "no such timeframe";
        let lastTime;
        const nameForMap = info.exchangeName + info.symbol + infoTF.name;
        let leftTime = startMap.get(nameForMap);
        if (!leftTime) {
            await waitLimit();
            try {
                leftTime = await setting.funcFistTime({ symbol: info.symbol, baseURL: base, interval: infoTF.name, fetch: _fetch, intervalTF: info.tf, waitLimit });
                startMap.set(nameForMap, leftTime);
            }
            catch (e) {
                if (data?.error == true)
                    throw e;
                else
                    return [];
            }
        }
        const [time1, time2] = [Math.max(info.time1.valueOf(), leftTime.valueOf()), info.time2.valueOf()];
        if (time2 <= time1) {
            return [];
        }
        const [t1, t2] = info.right ? [time1, time2] : [time2, time1];
        const arr = [];
        const interval = infoTF.time.valueOf();
        const map = [];
        if (maxLoadBars instanceof Date) {
            const [step1] = [
                maxLoadBars.valueOf()
            ];
            arr.push(lastTime = t1);
            let barsTime = (t1 - t2);
            if (barsTime <= maxLoadBars.valueOf())
                arr.push(t2);
            else {
                barsTime -= maxLoadBars.valueOf();
                arr.push(lastTime = lastTime - step1);
                for (; barsTime > 0; barsTime -= maxLoadBars.valueOf())
                    arr.push(lastTime = lastTime - step1);
                if (barsTime < 0)
                    arr.push(t2);
            }
        }
        else if (typeof maxLoadBars == "number") {
            const [step1] = [
                maxLoadBars * interval,
            ];
            arr.push(lastTime = t1);
            let bars = (t1 - t2) / interval;
            if (bars <= maxLoadBars)
                arr.push(t2);
            else {
                bars -= maxLoadBars;
                arr.push(lastTime = lastTime - step1);
                for (; bars > 0; bars -= maxLoadBars)
                    arr.push(lastTime = lastTime - step1);
                arr.push(t2);
            }
        }
        for (let i = 1; i < arr.length; i++) {
            if (arr[i].valueOf() >= arr[i - 1].valueOf())
                continue;
            const loader = async () => {
                const data = {
                    maxLoadBars: maxLoadBars,
                    fetch: _fetch,
                    baseURL: base,
                    symbol: info.symbol,
                    interval: infoTF.name,
                    startTime: new Date(arr[i]),
                    endTime: new Date(arr[i - 1]),
                    limit: maxLoadBars,
                    intervalTF: info.tf,
                    waitLimit
                };
                await waitLimit();
                let res = await setting.funcLoad(data);
                if (setting.controlTimeToNumber && res.length) {
                    let [t1, t2] = [
                        getDataEl(res[0]),
                        getDataEl(res.at(-1))
                    ];
                    if (t1 && t2 && t1 > t2) {
                        res = res.reverse();
                    }
                }
                return res;
            };
            map.push(loader());
        }
        const resulI = await Promise.allSettled(map);
        const result = [];
        for (let i = resulI.length - 1; i >= 0; i--) {
            const el = resulI[i];
            if (el.status == "fulfilled") {
                result.push(...el.value);
            }
            if (el.status == "rejected") {
                console.error(el.reason);
                if (data?.error == true)
                    throw el.reason;
            }
        }
        return result;
    };
}
async function test() {
    const arr = [];
    for (let i = 0; i < 10000; i++) {
        arr[i] = { time: Date.now() - i * Time_1.TF.H1.msec, price: i };
    }
    let ress = [];
    const tt = LoadQuoteBase({
        base: "",
        countConnect: 2,
        funcFistTime: async ({}) => {
            const time = new Date(arr.at(-1).time);
            console.log("funcFistTime: ", time);
            return time;
        },
        nameKey: "cd",
        maxLoadBars: 100,
        time: 50,
        intervalToName: [{ name: "1", time: Time_1.TF.H1 }],
        funcLoad: (data) => {
            ress.push(data.startTime);
            ress.push(data.endTime);
            return (async () => [{ time: 5 }])();
        }
    });
    const res = await tt({ symbol: "s", time2: new Date(), tf: Time_1.TF.H1, time1: new Date(2015) });
    ress.sort((a, b) => a.valueOf() - b.valueOf());
    console.log(ress);
    console.log(res);
}
