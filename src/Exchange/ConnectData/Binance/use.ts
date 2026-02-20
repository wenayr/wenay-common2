// import Binance from "node-binance-api";
import {spaceBinance} from "./order";
import {FuncTimeWait} from "../../../Common/funcTimeWait";
// import {BinanceSpot} from "./BinanceLib/spot";
import tFtt = spaceBinance.tFtt;

const binanceFunc = spaceBinance.binanceFunc

type tt44<key extends keyof T, T> = T extends { [key in string]: ((...args: infer Z) => infer X) } ? (...args: Z) => X : T[key]//T extends {[key in string]: infer X}? X : any
const helper4 = <T extends ({ wight: spaceBinance.tFF|spaceBinance.tFF[], function: (...a: any) => Promise<any> } & object), key extends keyof T>(obj: T, k: key) => {
    const t = obj[k] as tt44<key, T>
    if (typeof t == "function") {
        return ((...a: any[]) => {
            // проверка на очередь
            const wight = obj.wight

            const func = (wight: spaceBinance.tFF) => {
                const now = FuncTimeWait.weight(wight.type, wight.timeMs)
                if (now + wight.wight > wight.max) {
                    // превышен предел после этого запроса
                    throw {wait: wight.max - now + wight.wight}// надо придумать стандарт ошибки
                }
                FuncTimeWait.add({weight: wight.wight, type: wight.type})
            }

            if (wight) {
                const arr = Array.isArray(wight) ? wight : [wight]
                arr.forEach(e=>func(e))
            }

            return t(...a)
        }) as tt44<key, T>
    }
    return t as tt44<key, T>
}

export type Simple22<T> = {
    [key in keyof T] : (T[key] extends (a: any) => infer Result ?
        (Result extends {function : any} ?
            Result["function"]
            : T[key])
        : T[key])
}


function BinanceFuncConvert(data: spaceBinance.BinanceDataFunc, input: spaceBinance.tFtt) {
    let tt = data as unknown as {[key : string] : any;}
    for (let key in data) {
        const a = data[key]
        if (typeof a == "function") {
            const buf = a(input)
            tt[key] = helper4(buf, "function")
        }
    }
    return tt as Simple22<spaceBinance.BinanceDataFunc>
}


// function BinanceFuncConvert3(data: BinanceSpot.BinanceDataFunc, input: tFtt) {
//     let tt = data as unknown as {[key : string] : any;}
//     for (let key in data) {
//         const a = data[key]
//         if (typeof a == "function") {
//             const buf = a(input)
//             tt[key] = helper4(buf, "function")
//         }
//     }
//     return tt as Simple22<BinanceSpot.BinanceDataFunc>
// }


function BinanceFuncConvert2(data: spaceBinance.BinanceDataFunc, input: spaceBinance.tFtt) {
    let tt = data as unknown as {[key : string] : any;}
    for (let key in data) {
        const a = data[key]
        if (typeof a == "function") {
            const buf = a(input)
            tt[key] = helper4(buf, "function")
        }
    }
    return tt as Simple22<spaceBinance.BinanceDataFunc>
}

export function BinanceAcc2F(data: spaceBinance.tFtt) {
    // Binance lib
    // const BLib = new Binance().options({
    //     APIKEY: data.apiKey,
    //     APISECRET: data.apiSecret,
    //     useServerTime: true,
    //     recvWindow: 60000, // Set a higher recvWindow to increase response timeout
    //     verbose: false, // Add extra output when subscribing to WebSockets, etc
    //     log: log => {
    //         console.log(log);
    //     }
    // });

    // Binance functions
    const BFunc = BinanceFuncConvert(binanceFunc, data)

    // const tt = new BinanceSpot.BinanceDataFunc


    // const BFunc2 = BinanceFuncConvert3(tt, data)
    // BFunc2.DepositHistory({limit:500, status: })

    return {
        all: BFunc,
        transfer: {
            isolatedToSpot:                 BFunc.transferIsolatedToSpotF,
            spotToIsolated:                 BFunc.transferIsolatedF,
            maxTransferableIsolated:        BFunc.maxTransferableIsolatedF,
            maxTransferableCross:           BFunc.maxTransferableCrossF,
            // transferMoney:                  spaceBinance.transferMoneyF(BLib),
        },
        spot: {
            maxBorrowableCross:             binanceFunc.maxBorrowableCrossF,
            // order:                          spaceBinance.binanceSpot(BLib)
        },
        iso: {
            updateIsolatedAccsInfo:         BFunc.updateIsolatedAccsInfoАF,
            maxBorrowableIsolated:          BFunc.maxBorrowableIsolatedF,
            disableIsolatedAcc:             BFunc.disableIsolatedAccF,
            enableIsolatedAcc:              BFunc.enableIsolatedAccF,
            getIsolatedAccountsLimit:       BFunc.getIsolatedAccountsLimitF,
            getIsolationFeeData:            BFunc.getIsolationFeeDataF,
            getIsolationFeeDataBySymbol:    BFunc.getIsolationFeeDataBySymbolF,
            // order:                          spaceBinance.binanceIso(BLib)
        },
        futures: {
            // order:                          spaceBinance.binanceFutures(BLib)
        },
    }
}


