import {FuncTimeWait} from "../Common/funcTimeWait";
import {TF} from "../Common/Time";
import {CBar} from "./Bars";
import {sleepAsync} from "../Common/core/common";

type RequestInfo = any //
type RequestInit = any // this is dom library
type Response = any // this is dom library

export type tSymbol = string;
export type tExchange = string;
export type tTF = TF;
export type tSymbolLoadInfo = { readonly symbol: tSymbol, readonly exchangeName?: tExchange, readonly tf: tTF };
/**
 * `right` is NOT implemented. The chunker anchors at the newest edge and steps backwards,
 * and the dispatch loop only starts a load where the chunk list descends; passing `right: true`
 * merely swaps the two endpoints, so the list ascends and every chunk is skipped — the call
 * resolves to `[]` without ever invoking `funcLoad`. Left in place rather than removed because
 * the option is part of the published type; implementing it means a mirrored forward chunker.
 */
export type tInfoForLoadHistory = tSymbolLoadInfo & { time1: Date, time2: Date , right?:boolean}

type tFetch3 = (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>
export type tFuncLoad<maxLoadBarType extends (number| Date), IntervalNameT extends (number| string) > = {fetch: tFetch3, baseURL: string, symbol: string, interval: IntervalNameT, intervalTF: TF, startTime: Date, endTime?: Date, limit?: maxLoadBarType , maxLoadBars: maxLoadBarType, waitLimit: (weight?: number) => Promise<void>}
export type tLoadFist<IntervalNameT extends (number| string)> = {fetch: tFetch3, baseURL: string, symbol: string, interval: IntervalNameT, intervalTF: TF, waitLimit: (weight?: number) => Promise<void>}


export type tSetHistoryData = CBar & {tf?: TF}
type tBinanceLoadBase<Bar extends {time?: number} | {time?: Date} | object, maxLoadBarType extends (number| Date), IntervalNameT extends (number| string) > = {
    // download address // http
    base : string
    // maximum bars download at once in first request
    maxLoadBars : maxLoadBarType;
    // maximum bars download on retry
    maxLoadBars2? : maxLoadBarType//number|Date;
    // maximum number of requests within time limits
    countConnect : number;
    // period of reset limits
    time?: number,
    // download and save bars
    funcLoad: (data: tFuncLoad<maxLoadBarType,IntervalNameT>) => Promise<Bar[]>,
    // date of start of available history
    funcFistTime: (data: tLoadFist<IntervalNameT>) => Promise<Date>,
    // translate timeframe to interval names
    intervalToName: { time: TF, name: IntervalNameT }[],
    // name of key to which this weight will be applied
    nameKey?: string,
    // control correct time order, auto flip if needed
    controlTimeToNumber?: (bar: Bar) => number
}


// Wrapper for creating quote requests by time and limit
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
        // console.log('info')
        // console.log(info)
        const infoTF = mapTimeToName.get(info.tf.sec)
        if (!_fetch) throw "_fetch - not defined";
        if (!infoTF) throw "no such timeframe";

        let lastTime: number
        const nameForMap = info.exchangeName + info.symbol + infoTF.name
        let leftTime = startMap.get(nameForMap)
        if (!leftTime) {
            await waitLimit()
            try {
                leftTime = await setting.funcFistTime({symbol: info.symbol, baseURL: base, interval: infoTF.name, fetch: _fetch, intervalTF: info.tf, waitLimit}) as Date
                startMap.set(nameForMap, leftTime)
            } catch (e) {
                if (data?.error == true) throw e
                else return [] as Bar[]
            }
        }
        // if request exceeds the first quote on the left, we'll shorten the request to the quote

        const [time1, time2] = [Math.max(info.time1.valueOf(), leftTime.valueOf()), info.time2.valueOf()]
        if (time2 <= time1) {return []}

        const [t1, t2] = info.right ? [time1, time2] : [time2, time1]
        const arr: number[] = []
        const interval = infoTF.time.valueOf()
        // this was in case in the first and second step, different number of bars available
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
                // if (bars<0) arr.push(t2)
                arr.push(t2)
            }
        }


        for (let i = 1; i < arr.length; i++) {
            if (arr[i].valueOf() >= arr[i-1].valueOf()) continue;
            const loader = async ()=> {
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
            }
            map.push(loader())

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
                if (data?.error == true) throw el.reason
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