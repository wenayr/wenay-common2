import {TF} from "../Common/Time";
import type {CBar} from "./Bars";
import {FuncTimeWait} from "../Common/funcTimeWait";
import {sleepAsync} from "../Common/core/common";


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
    const {base,maxLoadBars,intervalToName} = setting
    const startMap = new Map<string, Date>()
    const keyName = setting.nameKey ?? "loadKey"
    const time = setting.time ?? 60000
    const other = data

    const getDataEl = (a: Bar) => setting.controlTimeToNumber?.(a)

    async function waitLimit(weight = 1) {
        // byWeight возвращает timestamp старейшего элемента в окне лимита,
        // нам нужно подождать пока он "выпадет" из окна
        const oldestTs = FuncTimeWait.byWeight(keyName, setting.countConnect)
        const t1 = oldestTs > 0 ? oldestTs - Date.now() + time + 1 : 0
        if (t1 > 0) {
            await sleepAsync(t1)
        }
        FuncTimeWait.add({type: keyName, weight: weight, timeStamp: Date.now()})
    }

    const mapTimeToName = new Map(intervalToName.map((e)=>[e.time.sec, e]))

    // @ts-ignore
    const _fetch = other?.fetch ?? fetch

    return async (info: tInfoForLoadHistory) : Promise<Bar[]> => {
        const infoTF = mapTimeToName.get(info.tf.sec)
        if (!_fetch) throw "_fetch - не определен";
        if (!infoTF) throw "нет такого таймфрейма";

        const nameForMap = info.exchangeName + info.symbol + infoTF.name
        let leftTime = startMap.get(nameForMap)
        if (!leftTime) {
            await waitLimit()
            leftTime = await setting.funcFistTime({
                symbol: info.symbol, baseURL: base, interval: infoTF.name,
                fetch: _fetch, intervalTF: info.tf, waitLimit
            }) as Date
            startMap.set(nameForMap, leftTime)
        }

        // если запрос превышает первую котировку слева — сократим до неё
        const time1 = Math.max(info.time1.valueOf(), leftTime.valueOf())
        const time2 = info.time2.valueOf()
        if (time2 <= time1) { return [] }

        // Строим массив точек разбивки от новейшего к старейшему (убывающий)
        // t1 = более новый конец, t2 = более старый конец
        const [tNewer, tOlder] = info.right ? [time2, time1] : [time2, time1]
        const arr: number[] = []
        const interval = infoTF.time.valueOf()

        if (maxLoadBars instanceof Date) {
            const step = maxLoadBars.valueOf()
            arr.push(tNewer)
            let span = tNewer - tOlder
            while (span > step) {
                arr.push(arr[arr.length - 1] - step)
                span -= step
            }
            if (arr[arr.length - 1] > tOlder) arr.push(tOlder)
        } else if (typeof maxLoadBars === "number") {
            const step = maxLoadBars * interval
            arr.push(tNewer)
            let bars = (tNewer - tOlder) / interval
            while (bars > maxLoadBars) {
                arr.push(arr[arr.length - 1] - step)
                bars -= maxLoadBars
            }
            if (arr[arr.length - 1] > tOlder) arr.push(tOlder)
        }

        // Последовательная загрузка чтобы не нарушать rate limit
        const result: Bar[] = []
        for (let i = 0; i < arr.length - 1; i++) {
            const endTime = arr[i]
            const startTime = arr[i + 1]
            if (startTime >= endTime) continue

            await waitLimit()
            const reqData: tFuncLoad<T, T2> = {
                maxLoadBars,
                fetch:      _fetch,
                baseURL:    base,
                symbol:     info.symbol,
                interval:   infoTF.name,
                startTime:  new Date(startTime),
                endTime:    new Date(endTime),
                limit:      maxLoadBars,
                intervalTF: info.tf,
                waitLimit
            }
            try {
                let res = await setting.funcLoad(reqData)
                if (setting.controlTimeToNumber && res.length > 0) {
                    const t1 = getDataEl(res[0])
                    const t2 = getDataEl(res.at(-1)!)
                    if (t1 != null && t2 != null && t1 > t2) {
                        res = res.reverse()
                    }
                }
                // Результаты добавляем в начало — т.к. идём от новых к старым
                result.unshift(...res)
            } catch (e) {
                console.error(e)
                if (data?.error === true) throw e
            }
        }

        return result
    }
}
//
// runTest()
//
// async function runTest() {
//     console.log("=== LoadQuoteBase real-world stress-test ===\n")
//
//     let passed = 0
//     let failed = 0
//
//     function check(label: string, ok: boolean, detail = "") {
//         if (ok) { console.log(`  ✅ ${label}`); passed++ }
//         else    { console.error(`  ❌ FAIL: ${label}` + (detail ? ` — ${detail}` : "")); failed++ }
//     }
//
//     // ─── Универсальный прогон одного кейса ───────────────────────────────────────
//     async function runCase(opts: {
//         label: string
//         years: number           // сколько лет истории качаем
//         tf: TF                  // таймфрейм
//         maxLoadBars: number     // лимит баров за 1 запрос (как на реальной бирже)
//         countConnect: number    // лимит запросов в окне (rate limit)
//         windowMs: number        // ширина окна rate limit в мс
//         symbols: string[]       // список символов
//     }) {
//         console.log(`\n[${ opts.label }]`)
//         const interval = opts.tf.msec
//         const barsPerYear = Math.floor(365.25 * 24 * 60 * 60 * 1000 / interval)
//         const totalBarsPerSymbol = Math.round(barsPerYear * opts.years)
//         const expectedChunksPerSymbol = Math.ceil(totalBarsPerSymbol / opts.maxLoadBars)
//         const expectedTotalChunks = expectedChunksPerSymbol * opts.symbols.length
//
//         console.log(`  tf=${opts.tf.name}, лет=${opts.years}, баров/символ≈${totalBarsPerSymbol}, чанков/символ≈${expectedChunksPerSymbol}, символов=${opts.symbols.length}`)
//         console.log(`  ожидаемых чанков всего≈${expectedTotalChunks}, countConnect=${opts.countConnect}, window=${opts.windowMs}мс`)
//
//         const now = Date.now()
//         // история начинается за opts.years лет до now
//         const historyStart = new Date(now - Math.round(barsPerYear * opts.years) * interval)
//
//         let totalFuncLoadCalls = 0
//         let fistTimeCallsPerSymbol: Record<string, number> = {}
//
//         // Замеряем реальные timestamps вызовов waitLimit (через funcLoad)
//         const callTimestamps: number[] = []
//
//         // Для каждого символа свой loader чтобы проверить независимость кэшей
//         const allCalls: { sym: string; s: number; e: number }[] = []
//
//         const loader = LoadQuoteBase({
//             base: "http://fake",
//             countConnect: opts.countConnect,
//             time: opts.windowMs,
//             nameKey: `stress-${opts.label}`,
//             maxLoadBars: opts.maxLoadBars,
//             intervalToName: [{ name: opts.tf.name, time: opts.tf }],
//             funcFistTime: async (d) => {
//                 fistTimeCallsPerSymbol[d.symbol] = (fistTimeCallsPerSymbol[d.symbol] ?? 0) + 1
//                 return historyStart
//             },
//             funcLoad: async (d) => {
//                 totalFuncLoadCalls++
//                 console.log(totalFuncLoadCalls)
//                 callTimestamps.push(Date.now())
//                 allCalls.push({ sym: (d as any).symbol ?? "?", s: d.startTime.valueOf(), e: d.endTime!.valueOf() })
//                 // Не генерируем реальные бары чтобы не убивать память при 175k баров × 700 символов
//                 return [] as any
//             },
//         })
//
//         const time2 = new Date(now)
//         const time1 = historyStart
//
//         for (const sym of opts.symbols) {
//             await loader({ symbol: sym, tf: opts.tf, time1, time2 })
//         }
//
//         console.log(`  итого вызовов funcLoad: ${totalFuncLoadCalls} (ожид. ≈${expectedTotalChunks})`)
//
//         // 1. Кол-во чанков примерно правильное (±1 на символ допускаем из-за граничных эффектов)
//         const chunksOk = Math.abs(totalFuncLoadCalls - expectedTotalChunks) <= opts.symbols.length
//         check("кол-во чанков в допустимой погрешности", chunksOk,
//             `получено ${totalFuncLoadCalls}, ожидалось ${expectedTotalChunks}`)
//
//         // 2. funcFistTime вызвана ровно 1 раз для каждого символа (кэш работает)
//         const cacheOk = opts.symbols.every(s => (fistTimeCallsPerSymbol[s] ?? 0) === 1)
//         check("funcFistTime кэшируется для каждого символа", cacheOk,
//             JSON.stringify(fistTimeCallsPerSymbol))
//
//         // 3. Проверка непрерывности чанков по каждому символу
//         let contOk = true
//         for (const sym of opts.symbols) {
//             const symCalls = allCalls.filter(c => c.sym === sym).sort((a, b) => a.s - b.s)
//             for (let i = 1; i < symCalls.length; i++) {
//                 if (symCalls[i].s !== symCalls[i - 1].e) {
//                     contOk = false
//                     console.error(`    [${sym}] разрыв: чанк ${i-1} end=${symCalls[i-1].e}, чанк ${i} start=${symCalls[i].s}`)
//                     break
//                 }
//             }
//             if (!contOk) break
//         }
//         check("чанки непрерывны по всем символам", contOk)
//
//         // 4. Проверка rate limit: ни в одном окне не было больше countConnect запросов
//         if (opts.windowMs > 0 && callTimestamps.length > opts.countConnect) {
//             let rateLimitOk = true
//             for (let i = opts.countConnect; i < callTimestamps.length; i++) {
//                 const windowStart = callTimestamps[i - opts.countConnect]
//                 const windowEnd = callTimestamps[i]
//                 // если opts.countConnect запросов уместились в окно — лимит нарушен
//                 if (windowEnd - windowStart < opts.windowMs) {
//                     rateLimitOk = false
//                     console.error(`    rate limit нарушен: ${opts.countConnect} запросов за ${windowEnd - windowStart}мс < ${opts.windowMs}мс`)
//                     break
//                 }
//             }
//             check(`rate limit: не более ${opts.countConnect} запросов за ${opts.windowMs}мс`, rateLimitOk)
//         }
//     }
//     // ─── T4: 100 символов / 1 год / M15 — средний прод ──────────────────────────
//     await runCase({
//         label: "T4: 100 символов / 1 год / M15",
//         years: 1, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 10, windowMs: 10000,
//         symbols: Array.from({ length: 200 }, (_, i) => `SYM${i}`),
//     })
//
//
//     // ─── T1: 1 символ, 1 год M15, как реальный биннс-запрос ─────────────────────
//     await runCase({
//         label: "T1: 1 символ / 1 год / M15 / limit=1000",
//         years: 1, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 10, windowMs: 10000,
//         symbols: ["BTCUSDT"],
//     })
//
//     // ─── T2: 1 символ, 5 лет M15 ─────────────────────────────────────────────────
//     await runCase({
//         label: "T2: 1 символ / 5 лет / M15 / limit=1000",
//         years: 5, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 1200, windowMs: 300,
//         symbols: ["BTCUSDT"],
//     })
//
//     // ─── T3: 10 символов / 2 года / M15 — проверка независимости кэшей ──────────
//     await runCase({
//         label: "T3: 10 символов / 2 года / M15",
//         years: 2, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 1200, windowMs: 300,
//         symbols: Array.from({ length: 10 }, (_, i) => `SYM${i}`),
//     })
//
//     // ─── T4: 100 символов / 1 год / M15 — средний прод ──────────────────────────
//     await runCase({
//         label: "T4: 100 символов / 1 год / M15",
//         years: 1, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 1200, windowMs: 300,
//         symbols: Array.from({ length: 100 }, (_, i) => `SYM${i}`),
//     })
//
//     // ─── T5: 700 символов / 5 лет / M15 — максимальный прод ─────────────────────
//     await runCase({
//         label: "T5: 700 символов / 5 лет / M15  ← FULL PROD",
//         years: 5, tf: TF.M15, maxLoadBars: 1000,
//         countConnect: 1200, windowMs: 300,
//         symbols: Array.from({ length: 700 }, (_, i) => `SYM${i}`),
//     })
//
//     // ─── T6: жёсткий rate limit — только 5 запросов в 500мс ─────────────────────
//     await runCase({
//         label: "T6: жёсткий rate limit (5 req / 500ms)",
//         years: 1, tf: TF.H1, maxLoadBars: 100,
//         countConnect: 5, windowMs: 500,
//         symbols: ["BTCUSDT"],
//     })
//
//     // ─── Итог ─────────────────────────────────────────────────────────────────────
//     console.log(`\n${"=".repeat(50)}`)
//     console.log(`  ✅ Пройдено: ${passed}   ❌ Провалено: ${failed}`)
//     console.log(`${"=".repeat(50)}`)
//     if (failed > 0) process.exit(1)
// }