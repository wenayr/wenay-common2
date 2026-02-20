// import {IIsolatedAcc, ISpotOrderRaw} from "../../binance/interfaces";
// import {apiKey, normalizeLot} from "../../binance/binance.main";
// import {addWeightReq, getSumWeightReq} from "../../tempdata.service";
import axios, {AxiosStatic} from "axios";
import type {tGetSignatureFunc} from "./signatureCoder";
import {NormalizeLot} from "./commonOrder";
import {IBorrowable, IIsolatedAcc, ISpotOrderRaw} from "./interfaces";




export namespace spaceBinance {
    type tOrderSymbolMarket = {
        symbol: string,
        minLot: number,
        stepLot: number,
        stepPrice: number,
    }

    type tOrderMarket = tOrderSymbolMarket & {volume: number, params?: {reduceOnly: boolean} }
    type tOrderLimit = tOrderMarket & {price: number }
    type tOrderCancel = tOrderMarket & {orderId: number }

    type IOrder = {
        buy(data: tOrderMarket): Promise<void>,
        sell(data: tOrderMarket): Promise<void>,
        buyLimit(data: tOrderLimit): Promise<void>,
        sellLimit(data: tOrderLimit): Promise<void>,
        cancelOrders(data: tOrderCancel): Promise<void>,
        getOrders(): Promise<void>
    }

    function NormalizePrice(value :number, priceStep :number):string {
        if(priceStep < 1) return value.toFixed(-Math.log10(priceStep))
        else return value.toFixed(0)
    }
// normalize Lot to String
    const nLot = (data: tOrderMarket) => NormalizeLot(data.volume,data.minLot,data.stepLot).toFixed(6)
// normalize Price
    const nPrice = (data: tOrderLimit) => NormalizePrice(data.price,data.stepPrice) 

    export function binanceSpot(binance: any):IOrder {
        return {
            async buy (data) {await binance.marketBuy(data.symbol, nLot(data))},
            async sell(data) {await binance.marketSell(data.symbol, nLot(data))},
            async buyLimit(data) {await binance.buy(data.symbol, nLot(data), nPrice(data), {type:'LIMIT'})},
            async sellLimit(data) {await binance.sell(data.symbol, nLot(data), nPrice(data), {type:'LIMIT'})},
            async cancelOrders(data) {await binance.cancel(data.symbol, data.orderId)},
            async getOrders(){}
        }
    }

    export function binanceFutures(binance: any):IOrder {
        return {
            async buy(data) {await binance.futuresMarketBuy(data.symbol, nLot(data), data.params??{})},
            async sell(data) {await binance.marketSell(data.symbol, nLot(data), data.params??{})},
            async buyLimit(data) {await binance.futuresBuy(data.symbol, nLot(data), nPrice(data))},
            async sellLimit(data) {await binance.futuresSell(data.symbol, nLot(data), nPrice(data))},
            async cancelOrders(data) {await binance.futuresCancel(data.symbol, {orderId: data.orderId} )},
            async getOrders(){}
        }
    }

    export function binanceIso(binance: any):IOrder {
        return {
            async buy(data) {await binance.mgMarketBuy(data.symbol, nLot(data), {type: 'MARKET'})},
            async sell(data) {await binance.mgMarketSell(data.symbol, nLot(data), {type: 'MARKET'})},
            async buyLimit(data) {await binance.mgBuy(data.symbol, nLot(data), nPrice(data), {type:'LIMIT'})},
            async sellLimit(data) {await binance.mgSell(data.symbol, nLot(data), nPrice(data), {type:'LIMIT'})},
            async cancelOrders(data) {
                await new Promise<{code?:number}|ISpotOrderRaw>((resolve,reject) => {
                    binance.mgCancel(data.symbol, data.orderId, (error: any, response: any) => {
                        if(!error) resolve(response)
                        else {reject(error)}
                    },'TRUE');
                } )
            },
            async getOrders(){}
        }
    }

    type tAcc = "SPOT"|"MARGIN"|"FUTURES"
// asset = USDT
    type tTransfer = {from: tAcc, to: tAcc, amount: number, asset?: string}
    export function transferMoneyF(binance: any) {
        return (data: tTransfer)=>{
            const {from, to, amount} = data
            const asset = data.asset ?? "USDT"
            return new Promise<true>((resolve, reject) => {
                const result = (error: any) => !error ? resolve(true) : reject(error)
                if (from == "SPOT" && to == "MARGIN") binance.mgTransferMainToMargin(asset, amount, result)
                if (from == "MARGIN" && to == "SPOT") binance.mgTransferMarginToMain(asset, amount, result)

                if (from == "SPOT" && to == "FUTURES") binance.transferMainToFutures(asset, amount, result)
                if (from == "FUTURES" && to == "SPOT") binance.transferFuturesToMain(asset, amount, result)
            })
        }
    }


// type tFtt = {apiKey: string, getSignature(object, apiSecret: string): string, axios: AxiosStatic, apiSecret: string}

    export type tFtt = {apiKey: string, axios: AxiosStatic, apiSecret: string, GetSignatureFunc: tGetSignatureFunc}

    const binanceHeader = (apiKey: string) => ({headers: {'Content-type': 'application/x-www-form-urlencoded', 'X-MBX-APIKEY': apiKey}})

    export type tFF =  {type: "IP" | "UID" | string, wight: number, timeMs: number, max: number}

    type standard<T extends (...args: any)=> any> = {
        wight: tFF | tFF[],
        function: T //((...args: any)=> unknown)
    } //| T

    type tMaxBorrowableCrossF = (asset: string)=>Promise<IBorrowable>
    type tSimpleFunc = (...arg: any) => any
    type tSimpleFunc2<T> = (arg: T) =>  (standard<tSimpleFunc>) //(testT<tSimpleFunc>| tSimpleFunc)
    export class BinanceDataFunc{
        [ket: string]: tSimpleFunc2<tFtt>
        maxBorrowableCrossF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt): standard<tMaxBorrowableCrossF>  {
            return {
                wight: {
                    type: "IP",
                    wight: 50,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function (asset: string): Promise<IBorrowable> {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({asset, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/maxBorrowable?asset=${asset}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {
                        amount: +res.data.amount,
                        borrowLimit: +res.data.borrowLimit
                    }
                }
            }
        }

        maxBorrowableIsolatedF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 50,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function (asset: string, isolatedSymbol:string): Promise<IBorrowable> {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({asset,timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/maxBorrowable?asset=${asset}&timestamp=${timestamp}&isolatedSymbol=${isolatedSymbol}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {
                        amount: +res.data.amount,
                        borrowLimit: +res.data.borrowLimit
                    }
                }
            }
        }

        maxTransferableCrossF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 50,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function (asset: string, isolatedSymbol:string): Promise<{amount:number}> {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({asset,timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/maxTransferable?asset=${asset}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {
                        amount: +res.data.amount
                    }
                }
            }
        }

        maxTransferableIsolatedF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 50,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function (asset: string, isolatedSymbol: string): Promise<{amount:number}> {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({asset, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/maxTransferable?asset=${asset}&timestamp=${timestamp}&isolatedSymbol=${isolatedSymbol}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {
                        amount: +res.data.amount
                    }
                }
            }
        }

        transferIsolatedF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 50,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function (asset:string, symbol:string, amount:number | string, fromAccountType: 'ISOLATED_MARGIN' | 'MARGIN'):Promise<{tranId:number,code?:number}> {
                    const timestamp = Date.now()
                    const type = fromAccountType == "ISOLATED_MARGIN" ? 'ISOLATEDMARGIN_MARGIN' : 'MARGIN_ISOLATEDMARGIN'
                    const signature = fromAccountType == "ISOLATED_MARGIN" ? GetSignatureFunc({type,asset,amount,fromSymbol:symbol,timestamp},apiSecret) : GetSignatureFunc({type,asset,amount,toSymbol:symbol,timestamp},apiSecret)
                    const url = fromAccountType == "ISOLATED_MARGIN" ? `https://api.binance.com/sapi/v1/asset/transfer?type=${type}&asset=${asset}&amount=${amount}&fromSymbol=${symbol}&timestamp=${timestamp}&signature=${signature}` :
                        `https://api.binance.com/sapi/v1/asset/transfer?type=${type}&asset=${asset}&amount=${amount}&toSymbol=${symbol}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.post(url, '',{...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {tranId: +res.data.tranId}
                }
            }
        }

        transferIsolatedToSpotF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 600,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (asset:string, symbol:string, amount:number | string, transFrom: 'ISOLATED_MARGIN' | 'SPOT'):Promise<{tranId:number,code?:number}> {
                    const timestamp = Date.now()
                    const transTo = transFrom == 'ISOLATED_MARGIN' ? 'SPOT' : 'ISOLATED_MARGIN'
                    const signature = GetSignatureFunc({asset, symbol, transFrom, transTo, amount, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolated/transfer?asset=${asset}&symbol=${symbol}&transFrom=${transFrom}&transTo=${transTo}&amount=${amount}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.post(url, '',{...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    return {tranId: +res.data.tranId}
                }
            }
        }


        updateIsolatedAccsInfoАF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 600,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (asset: string, symbol: string, amount: number | string, transFrom: 'ISOLATED_MARGIN' | 'SPOT') {
                    const timestamp = Date.now()
                    const transTo = transFrom == 'ISOLATED_MARGIN' ? 'SPOT' : 'ISOLATED_MARGIN'
                    const signature = GetSignatureFunc({asset, symbol, transFrom, transTo, amount, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolated/account?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    const result: {
                        assets?: IIsolatedAcc[],
                        totalAssetOfBtc?: number
                    } = {
                        assets: res?.data?.assets,
                        totalAssetOfBtc: res.data.totalAssetOfBtc && +res.data.totalAssetOfBtc
                    }
                    return result
                }
            }
        }

        disableIsolatedAccF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 300,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (symbol: string) {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({symbol, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolated/account?symbol=${symbol}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.delete(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    if (res?.data.success) return true
                    throw res?.data?.code
                }
            }
        }


        enableIsolatedAccF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 300,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (symbol: string) {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({symbol, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolated/account?symbol=${symbol}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.post(url, '',{...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    if (res?.data.success) return true
                    throw res?.data?.code
                }
            }
        }

        getIsolatedAccountsLimitF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 300,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (symbol: string) {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({symbol, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolated/accountLimit?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    if (res?.data != undefined) return res.data
                    throw res?.data?.code
                }
            }
        }


        getIsolationFeeDataF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 300,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (symbol: string) {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({symbol, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolatedMarginData?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    if (res?.data != undefined) return res.data
                    throw res?.data?.code
                }
            }
        }

        getIsolationFeeDataBySymbolF({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "UID",
                    wight: 300,
                    max: 150000,
                    timeMs: 60 * 1000
                },
                function: async function (symbol: string) {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({symbol, timestamp}, apiSecret)
                    const url = `https://api.binance.com/sapi/v1/margin/isolatedMarginData?symbol=${symbol}&timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    if (res.data.length) return res.data[0]
                    throw res?.data?.code
                }
            }
        }

        getAllCrossMarginPairs({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 1,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function () {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({timestamp}, apiSecret)

                    const url = `https://api.binance.com/sapi/v1/margin/allPairs?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    // const cross = res.data.filter(item=>item.quote === 'USDT' && item.isMarginTrade && item.isBuyAllowed && item.isSellAllowed)
                    //     .map(item=>item.symbol) // 177

                    if (res?.data != undefined) return res.data
                    throw res?.data?.code
                }
            }
        }

        getAllCrossIsolatePairs({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 1,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function () {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({timestamp}, apiSecret)

                    const url = `https://api.binance.com/sapi/v1/margin/isolated/allPairs?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })
                    // const cross = res.data.filter(item=>item.quote === 'USDT' && item.isMarginTrade && item.isBuyAllowed && item.isSellAllowed)
                    //     .map(item=>item.symbol) // 177

                    if (res?.data != undefined) return res.data
                    throw res?.data?.code
                }
            }
        }
        crossMarginAccountDetails ({axios, apiKey, apiSecret, GetSignatureFunc}: tFtt) {
            return {
                wight: {
                    type: "IP",
                    wight: 10,
                    max: 10000,
                    timeMs: 60 * 1000
                },
                function: async function () {
                    const timestamp = Date.now()
                    const signature = GetSignatureFunc({timestamp}, apiSecret)

                    const url = `https://api.binance.com/sapi/v1/margin/account?timestamp=${timestamp}&signature=${signature}`
                    const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
                        console.log(e) // необходимо написать описание стандартных проблем, с решением
                        throw e
                    })

                    if (res?.data != undefined) return res.data
                    /*
                    * {
      "borrowEnabled": true,
      "marginLevel": "11.64405625",
      "totalAssetOfBtc": "6.82728457", // сколько денег в битках
      "totalLiabilityOfBtc": "0.58633215",
      "totalNetAssetOfBtc": "6.24095242",
      "tradeEnabled": true,
      "transferEnabled": true,
      "userAssets": [
          {
              "asset": "BTC",
              "borrowed": "0.00000000",
              "free": "0.00499500",
              "interest": "0.00000000",
              "locked": "0.00000000",
              "netAsset": "0.00499500"
          },
          {
              "asset": "BNB",
              "borrowed": "201.66666672",
              "free": "2346.50000000",
              "interest": "0.00000000",
              "locked": "0.00000000",
              "netAsset": "2144.83333328"
          },
          {
              "asset": "ETH",
              "borrowed": "0.00000000",
              "free": "0.00000000",
              "interest": "0.00000000",
              "locked": "0.00000000",
              "netAsset": "0.00000000"
          },
          {
              "asset": "USDT",
              "borrowed": "0.00000000",
              "free": "0.00000000",
              "interest": "0.00000000",
              "locked": "0.00000000",
              "netAsset": "0.00000000"
          }
      ]
}
* */
                    throw res?.data?.code
                }
            }
        }

    }
    export const binanceFunc = new BinanceDataFunc
}
