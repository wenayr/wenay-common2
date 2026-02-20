import {isDate, sleepAsync} from "../Common/common";
import {TF} from "../Common/Time";
import type {CBar} from "./Bars";
import {FuncTimeWait} from "../Common/funcTimeWait";


type RequestInfo = any //
type RequestInit = any // это библиотека dom
type Response = any // это библиотека dom

export type tSymbol = string;
export type tExchange = string;
export type tTF = TF;
export type tSymbolLoadInfo = { readonly symbol: tSymbol, readonly exchangeName?: tExchange, readonly tf: tTF };
export type tInfoForLoadHistory = tSymbolLoadInfo & { time1: Date, time2: Date , right?:boolean}

type tFetch3 = (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>
export type tFuncLoad<maxLoadBarType extends (number| Date), IntervalNameT extends (number| string) > = {fetch: tFetch3, baseURL: string, symbol: string, interval: IntervalNameT, intervalTF: TF, startTime: Date, endTime?: Date, limit?: maxLoadBarType , maxLoadBars: maxLoadBarType, waitLimit: (weight?: number) => Promise<void>}
export type tLoadFist<IntervalNameT extends (number| string)> = {fetch: tFetch3, baseURL: string, symbol: string, interval: IntervalNameT, intervalTF: TF, waitLimit: (weight?: number) => Promise<void>}


export type tSetHistoryData = CBar & {tf?: TF}
type tBinanceLoadBase<Bar extends {time?: number} | {time?: Date} | object, maxLoadBarType extends (number| Date), IntervalNameT extends (number| string) > = {
    // адрес загрузки // http
    base : string
    // максимум загрузки баров за раз при первом запроса
    maxLoadBars : maxLoadBarType;
    // максимум загрузки баров при докачке
    maxLoadBars2? : maxLoadBarType//number|Date;
    // максимальное количество запросов в пределах времени лимитов
    countConnect : number;
    // период сброса лимитов
    time?: number,
    // загрузка и сохранения баров
    funcLoad: (data: tFuncLoad<maxLoadBarType,IntervalNameT>) => Promise<Bar[]>,
    // дата начала доступной истории
    funcFistTime: (data: tLoadFist<IntervalNameT>) => Promise<Date>,
    // перевод timeframe в название интервалов
    intervalToName: { time: TF, name: IntervalNameT }[],
    // имя ключа, к которому будет применяться данный веся
    nameKey?: string,
    // контроль верного порядка времени, авто переворот при необходимости
    controlTimeToNumber?: (bar: Bar) => number
}


// Обертка для создания запросов котировок по времени и лимиту
export function LoadQuoteBase<Bar extends object, T extends (number| Date), T2 extends (number| string) > (setting: tBinanceLoadBase<Bar, T, T2> & {maxLoadBars : T}, data?: { fetch?: tFetch3, error?: boolean}){
    const {base,maxLoadBars,countConnect,intervalToName} = setting
    const maxLoadBars2 = setting.maxLoadBars2 ?? maxLoadBars
    const startMap = new Map<string, Date>()
    const keyName = setting.nameKey ?? "loadKey"
    const time = setting.time ?? 60000
    const other = data

    const getDataEl = (a: Bar) => setting.controlTimeToNumber?.(a)

    async function waitLimit(weight = 1) {
        //await sleepAsync(0)
        const t1 = FuncTimeWait.byWeight(keyName, setting.countConnect) - (Date.now() - time) +1
        if (t1 > 0 ) {
            FuncTimeWait.add({type: keyName, weight: weight, timeStamp: Date.now() + t1})
            await sleepAsync(t1)
        }
        else {
            FuncTimeWait.add({type: keyName, weight: weight, timeStamp: Date.now()})
        }
    }

    const mapTimeToName = new Map(intervalToName.map((e)=>[e.time.sec, e]))

    // @ts-ignore
    const _fetch = other?.fetch??fetch

    return async (info: tInfoForLoadHistory ) : Promise<Bar[]>  => {   //
        const infoTF = mapTimeToName.get(info.tf.sec)
        if (!_fetch) throw "_fetch - не определен";
        if (!infoTF) throw "нет такого таймфрейма";

        let lastTime: number
        const nameForMap = info.exchangeName + info.symbol + infoTF.name
        let leftTime = startMap.get(nameForMap)
        if (!leftTime) {
            await waitLimit()
            leftTime = await setting.funcFistTime({symbol: info.symbol, baseURL: base, interval: infoTF.name, fetch: _fetch, intervalTF: info.tf, waitLimit}) as Date
            startMap.set(nameForMap, leftTime)
        }
        // если запрос превышает первую котировку слева, то сократим, запрос, до котировки

        const [time1, time2] = [Math.max(info.time1.valueOf(), leftTime.valueOf()), info.time2.valueOf()]
        if (time2 <= time1) {return []}

        const [t1, t2] = info.right ? [time1, time2] : [time2, time1]
        const arr: number[] = []
        const interval = infoTF.time.valueOf()
        // это было на случай если в первом и втором шаге, доступно различное количество баров
        const map: Promise <Bar[]>[]= []
        if (maxLoadBars instanceof Date) {
            const [step1//, step2
            ] = [
                 maxLoadBars.valueOf()
                // maxLoadBars2 instanceof Date ? maxLoadBars2.valueOf(): maxLoadBars2 * interval
            ]

            arr.push(lastTime = t1)
            let barsTime = (t1 - t2)
            if (barsTime <= maxLoadBars.valueOf()) arr.push(t2)
            else {
                barsTime -= maxLoadBars.valueOf()
                arr.push(lastTime = lastTime - step1)
                for (; barsTime>0; barsTime -= maxLoadBars.valueOf()) arr.push(lastTime = lastTime - step1)
                if (barsTime<0) arr.push(t2)
            }
        }
        else if (typeof maxLoadBars == "number") {
            const [step1 //, step2
            ] = [
                maxLoadBars * interval,
                // maxLoadBars2 instanceof Date ? maxLoadBars2.valueOf(): maxLoadBars2 * interval
            ]

            arr.push(lastTime = t1)
            let bars = (t1 - t2) / interval
            if (bars <= maxLoadBars) arr.push(t2)
            else {
                bars -= maxLoadBars
                arr.push(lastTime = lastTime - step1)
                for (; bars>0; bars -= maxLoadBars) arr.push(lastTime = lastTime - step1)
                if (bars<0) arr.push(t2)
            }
        }


        for (let i = 1; i < arr.length; i++) {
            if (arr[i].valueOf() >= arr[i-1].valueOf()) continue;
            map.push((async ()=>{
                const data: tFuncLoad<T, T2> = {
                    maxLoadBars:    maxLoadBars,
                    fetch:      _fetch,
                    baseURL:    base,
                    symbol:     info.symbol,
                    interval:   infoTF.name,
                    startTime:  new Date(arr[i]),
                    endTime:    new Date(arr[i-1]),
                    limit:      maxLoadBars,
                    intervalTF: info.tf,
                    waitLimit
                }
                await waitLimit()
                let res = await setting.funcLoad(data)
                if (setting.controlTimeToNumber && res.length) {
                    let [t1, t2] = [
                        getDataEl(res[0]),
                        getDataEl(res.at(-1)!)
                    ]
                    if (t1 && t2 && t1 > t2) {
                        res = res.reverse()
                    }
                }
                return res
            })())

        }

        const resulI = await Promise.allSettled(map)
        const result: Bar[] = []
        // resulI.forEach((e,i)=>{
        //     if (e.status == "fulfilled") result.unshift(...e.value)
        //     if (e.status == "rejected") console.error(e.reason)
        // })

        for (let i = resulI.length - 1; i >= 0; i--) {
            const el = resulI[i]
            if (el.status == "fulfilled") {
                result.push(...el.value)
            }
            if (el.status == "rejected") {
                console.error(el.reason)
                if (data?.error === true) throw el.reason
            }
        }

        return result
    }}

// test()
async function test() {
    const arr:{time: number, price: number}[] = []
    for (let i = 0; i < 10000; i++) {
        arr[i] = {time: Date.now() - i * TF.H1.msec, price: i}
    }
    let ress: Date[] = []
    const tt =LoadQuoteBase({
        base: "",
        countConnect: 2,
        funcFistTime: async ({})=> {
            const time = new Date(arr.at(-1)!.time)
            console.log("funcFistTime: ", time)
            return time
        },
        nameKey: "cd",
        maxLoadBars: 100,
        time: 50,
        intervalToName: [{name:"1", time:TF.H1}],
        funcLoad:  (data) => {
            ress.push(data.startTime)
            ress.push(data.endTime!)
            return (async ()=>[{time: 5}])()
            // return []
        }
    })
    const res = await tt({symbol:"s", time2: new Date(), tf: TF.H1, time1: new Date(2015)})
    ress.sort((a,b)=> a.valueOf() - b.valueOf())
    console.log(ress)
    console.log(res)
}