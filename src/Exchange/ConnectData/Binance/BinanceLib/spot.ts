// import {IBorrowable} from "../interfaces";
// import {GetSignatureFunc, MilliSec, tInputBase} from "../signatureCoder";
// import {aBinanceDataFunc, binanceHeader, standard, tFtt, tSimpleFunc2} from "./base";
// import {tErrorBinance} from "./type";
//
//
// type NumberString = string
//
// type tInputBase2 = tInputBase & {
//     timestamp: MilliSec
// }
//
// type LONG = number
// type ARRAY = string[]
// type INT = number
// type INTEGER = number
// type DECIMAL = number
// type STRING = string
// type BOOLEAN = boolean
// type ENUM =  "MAIN_UMFUTURE"|                        // Spot account transfer to USDⓈ-M Futures account
//     "MAIN_CMFUTURE"|                        // Spot account transfer to COIN-M Futures account
//     "MAIN_MARGIN"|                      // Spot account transfer to Margin（cross）account
//     "UMFUTURE_MAIN"|                        // USDⓈ-M Futures account transfer to Spot account
//     "UMFUTURE_MARGIN"|                      // USDⓈ-M Futures account transfer to Margin（cross）account
//     "CMFUTURE_MAIN"|                        // COIN-M Futures account transfer to Spot account
//     "CMFUTURE_MARGIN"|                      // COIN-M Futures account transfer to Margin(cross) account
//     "MARGIN_MAIN"|                      // Margin（cross）account transfer to Spot account
//     "MARGIN_UMFUTURE"|                      // Margin（cross）account transfer to USDⓈ-M Futures
//     "MARGIN_CMFUTURE"|                      // Margin（cross）account transfer to COIN-M Futures
//     "ISOLATEDMARGIN_MARGIN"|                        // Isolated margin account transfer to Margin(cross) account
//     "MARGIN_ISOLATEDMARGIN"|                        // Margin(cross) account transfer to Isolated margin account
//     "ISOLATEDMARGIN_ISOLATEDMARGIN"|                        // Isolated margin account transfer to Isolated margin account
//     "MAIN_FUNDING"|                     // Spot account transfer to Funding account
//     "FUNDING_MAIN"|                     // Funding account transfer to Spot account
//     "FUNDING_UMFUTURE"|                     // Funding account transfer to UMFUTURE account
//     "UMFUTURE_FUNDING"|                     // UMFUTURE account transfer to Funding account
//     "MARGIN_FUNDING"|                       // MARGIN account transfer to Funding account
//     "FUNDING_MARGIN"|                       // Funding account transfer to Margin account
//     "FUNDING_CMFUTURE"|                     // Funding account transfer to CMFUTURE account
//     "CMFUTURE_FUNDING"|                     // CMFUTURE account transfer to Funding account
//     "MAIN_OPTION"|                      // Spot account transfer to Options account
//     "OPTION_MAIN"|                      // Options account transfer to Spot account
//     "UMFUTURE_OPTION"|                      // USDⓈ-M Futures account transfer to Options account
//     "OPTION_UMFUTURE"|                      // Options account transfer to USDⓈ-M Futures account
//     "MARGIN_OPTION"|                        // Margin（cross）account transfer to Options account
//     "OPTION_MARGIN"|                        // Options account transfer to Margin（cross）account
//     "FUNDING_OPTION"|                       // Funding account transfer to Options account
//     "OPTION_FUNDING"//                      Options account transfer to Funding account
// type TimeString = string
// export namespace BinanceSpot {
//     const base = {
//         error: (e: tErrorBinance)=> {
//             console.error(e);
//             throw e
//         },
//         funcGetSSH: async <T extends tInputBase> ({data, params, url: urlBase}:{data: tFtt, params: T|undefined , url: string}) => {
//             const obj = { ...(params ?? {}) } as T
//             const {apiSecret,apiKey} = data
//             obj.timestamp = obj.timestamp ?? Date.now()
//             obj.recvWindow = obj.recvWindow ?? 5000
//             const signature =  GetSignatureFunc({...obj}, apiSecret)
//
//             const st: string[] = []
//             for (const key in params) st.push(key + String(params[key]))
//             const str = st.join("&")
//             const url = urlBase + str + "&signature="+signature
//
//             return await data.axios
//                 .get(url, {...binanceHeader(apiKey)})
//                 .catch(e=>base.error(e))
//         },
//         ///
//         funcPostSSH: async <T extends tInputBase> ({data, params, url: urlBase}:{data: tFtt, params: T|undefined , url: string}) => {
//             const obj = { ...(params ?? {}) } as T
//             const {apiSecret,apiKey} = data
//             obj.timestamp = obj.timestamp ?? Date.now()
//             obj.recvWindow = obj.recvWindow ?? 5000
//             const signature =  GetSignatureFunc({...obj}, apiSecret)
//
//             const st: string[] = []
//             for (const key in params) st.push(key + String(params[key]))
//             const str = st.join("&")
//             const url = urlBase + str + "&signature="+signature
//
//             return await data.axios
//                 .post(url, {...binanceHeader(apiKey)})
//                 .catch(e=>base.error(e))
//         },
//         funcGet: async <T extends tInputBase> ({data, params, url: urlBase}:{data: tFtt, params: T|undefined , url: string}) => {
//             const obj = { ...(params ?? {}) } as T
//             const {apiSecret,apiKey} = data
//
//             obj.timestamp = obj.timestamp ?? Date.now()
//             obj.recvWindow = obj.recvWindow ?? 5000
//
//             const st: string[] = []
//             for (const key in params) st.push(key + String(params[key]))
//             const str = st.join("&")
//             const url = urlBase + str
//
//             return await data.axios
//                 .get(url, {...binanceHeader(apiKey)})
//                 .catch(e=>base.error(e))
//         }
//     }
//
//     export class BinanceDataFunc //extends aBinanceDataFunc
//     { // sapi/v1/system/status standard<tMaxBorrowableCrossF>
//
//         [ket: string]: tSimpleFunc2<tFtt>
//         // maxBorrowableCrossF({axios, apiKey, apiSecret}: tFtt) {
//         //     //
//         //     const f = async function (asset: string) {
//         //         const timestamp = Date.now()
//         //         const signature = GetSignatureFunc({asset, timestamp}, apiSecret)
//         //         const url = `https://api.binance.com/sapi/v1/margin/maxBorrowable?asset=${asset}&timestamp=${timestamp}&signature=${signature}`
//         //         const res = await axios.get(url, {...binanceHeader(apiKey)}).catch(e=>{
//         //             console.log(e) // необходимо написать описание стандартных проблем, с решением
//         //             throw e
//         //         })
//         //         return {
//         //             amount: +res.data.amount,
//         //             borrowLimit: +res.data.borrowLimit
//         //         }
//         //     }
//         //     return {
//         //         wight: {
//         //             type: "IP",
//         //             wight: 50,
//         //             max: 10000,
//         //             timeMs: 60 * 1000
//         //         },
//         //         function: f
//         //     } satisfies standard<typeof f>
//         // }
//         // System Status (System)
//
//         SystemStatus(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq =  {}
//             const name = "/sapi/v1/margin/maxBorrowable"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGet({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//
//         }
//
//
//         //All Coins' Information (USER_DATA)
//         AllCoinsInformation(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq =  {
//                 "coin": string,//"BTC",
//                 "depositAllEnable": boolean,//true,
//                 "free": NumberString,// "0.08074558",
//                 "freeze": NumberString,// "0.00000000",
//                 "ipoable": NumberString,// "0.00000000",
//                 "ipoing": NumberString,// "0.00000000",
//                 "isLegalMoney": boolean,//false,
//                 "locked": NumberString,// "0.00000000",
//                 "name": string,//"Bitcoin",
//                 "networkList":
//                     {
//                         "addressRegex": string,//"^(bnb1)[0-9a-z]{38}$",
//                         "coin": string,//"BTC",
//                         "depositDesc"?: string,//"Wallet Maintenance, Deposit Suspended", // shown only when "depositEnable" is false.
//                         "depositEnable": false,
//                         "isDefault": boolean,//false,
//                         "memoRegex": string|"",//"^[0-9A-Za-z\\-_]{1,120}$",
//                         "minConfirm": number,//1,  // min number for balance confirmation
//                         "name": string,//"BEP2",
//                         "network": string,//"BNB",
//                         "resetAddressStatus": boolean,//false,
//                         "specialTips": string,//"Both a MEMO and an Address are required to successfully deposit your BEP2-BTCB tokens to Binance.",
//                         "unLockConfirm": number,//0,  // confirmation number for balance unlock
//                         "withdrawDesc"?: string,//"Wallet Maintenance, Withdrawal Suspended", // shown only when "withdrawEnable" is false.
//                         "withdrawEnable": boolean,//false,
//                         "withdrawFee": NumberString,// "0.00000220",
//                         "withdrawIntegerMultiple": NumberString,// "0.00000001",
//                         "withdrawMax": NumberString,// "9999999999.99999999",
//                         "withdrawMin": NumberString,// "0.00000440",
//                         "sameAddress": boolean,//true,  // If the coin needs to provide memo to withdraw
//                         "estimatedArrivalTime": number,//25,
//                         "busy": boolean,//false
//                     }[]
//                 ,
//                 "storage": NumberString,// "0.00000000",
//                 "trading": boolean,//true,
//                 "withdrawAllEnable": boolean,//true,
//                 "withdrawing": NumberString,// "0.00000000"
//             }[]
//             const name = "/sapi/v1/capital/config/getall"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         //(USER_DATA)
//         DailyAccountSnapshot (data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 type:	 	"SPOT"| "MARGIN"| "FUTURES",
//                 startTime?:	LONG
//                 endTime?:	LONG
//                 //	min 7, max 30, default 7
//                 limit?:	INT
//             } & tInputBase
//             // ответ
//             type tReqSpot =  {
//                 // 200 for success; others are error codes
//                 "code":number|200,//200,
//                 //"", // error message
//                 "msg":string|"",
//                 "snapshotVos":
//                     {
//                         "data":{
//                             "balances":
//                                 {//"BTC",
//                                     "asset": string,//
//                                     "free": NumberString,//"0.09905021",
//                                     "locked": NumberString,//"0.00000000"
//                                 }[]
//                             ,
//                             "totalAssetOfBtc": NumberString,//"0.09942700"
//                         },
//                         //"spot",
//                         "type":"spot",
//                         //1576281599000
//                         "updateTime":number,
//                     }[]
//
//             }
//             type tReqMargin ={
//                 // 200 for success; others are error codes
//                 "code":number|200,//200,
//                 //"", // error message
//                 "msg":string|"",
//                 "snapshotVos":
//                     {
//                         "data":{
//                             "marginLevel": NumberString,//"2748.02909813",
//                             "totalAssetOfBtc": NumberString,//"0.00274803",
//                             "totalLiabilityOfBtc": NumberString,//"0.00000100",
//                             "totalNetAssetOfBtc": NumberString,//"0.00274750",
//                             "userAssets":[
//                                 {
//                                     "asset": string,//"XRP",
//                                     "borrowed": NumberString,//"0.00000000",
//                                     "free": NumberString,//"1.00000000",
//                                     "interest": NumberString,//"0.00000000",
//                                     "locked": NumberString,//"0.00000000",
//                                     "netAsset": NumberString,//"1.00000000"
//                                 }
//                             ]
//                         },
//                         "type":"margin",
//                         "updateTime": number //1576281599000
//                     }[]
//
//             }
//             type tReqFutures ={
//                 // 200 for success; others are error codes
//                 "code":number|200,//200,
//                 //"", // error message
//                 "msg":string|"",
//                 "snapshotVos":
//                     {
//                         "data":{
//                             "assets":[
//                                 {
//                                     "asset": string,//"USDT",
//                                     "marginBalance": NumberString,//"118.99782335", // Not real-time data, can ignore
//                                     "walletBalance": NumberString,//"120.23811389"
//                                 }
//                             ],
//                             "position":[
//                                 {
//                                     "entryPrice": NumberString,//"7130.41000000",
//                                     "markPrice": NumberString,//"7257.66239673",
//                                     "positionAmt": NumberString,//"0.01000000",
//                                     "symbol": string,//"BTCUSDT",
//                                     "unRealizedProfit": NumberString,//"1.24029054"  // Only show the value at the time of opening the position
//                                 }
//                             ]
//                         },
//                         "type": "futures",
//                         "updateTime": number//1576281599000
//                     }[]
//
//             }
//             const name = "/sapi/v1/accountSnapshot"
//             const baseUrl = "https://api.binance.com/"
//
//             const f= async (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReqSpot | tReqMargin| tReqFutures
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 2400,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         DisableFastWithdrawSwitch(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq =  {}
//             const name = "/sapi/v1/account/disableFastWithdrawSwitch"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         EnableFastWithdrawSwitch(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq =  {}
//             const name = "/sapi/v1/account/enableFastWithdrawSwitch"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         Withdraw(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 coin:	STRING,
//                 //client id for withdraw
//                 withdrawOrderId?:	STRING,
//                 network?:	STRING,
//                 address:	STRING,
//                 //	Secondary address identifier for coins like XRP,XMR etc.
//                 addressTag?:	STRING,
//                 amount:	DECIMAL,
//                 //	When making internal transfer, true for returning the fee to the destination account; false for returning the fee back to the departure account. Default false.
//                 transactionFeeFlag?:	BOOLEAN,
//                 //	Description of the address. Space in name should be encoded into %20.
//                 name?:	STRING,
//                 //	The wallet type for withdraw，0-spot wallet ，1-funding wallet. Default walletType is the current "selected wallet" under wallet->Fiat and Spot/Funding->Deposit
//                 walletType?:	INTEGER | 0 | 1,
//             } & tInputBase
//             // ответ
//             type tReq =  {
//                 "id": string,//"7213fea8e94b4a5593d507237e5a555b"
//             }
//             const name = "/sapi/v1/capital/withdraw/apply"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "UID",
//                     wight: 600,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (supporting network) (USER_DATA)
//         // Please notice the default startTime and endTime to make sure that time interval is within 0-90 days.
//         // If both startTime and endTime are sent, time between startTime and endTime must be less than 90 days.
//         DepositHistory(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 //	NO
//                 coin?:	STRING,
//                 //	NO	0(0:pending,6: credited but cannot withdraw, 7=Wrong Deposit,8=Waiting User confirm, 1:success)
//                 status?:	INT,
//                 //	NO	Default: 90 days from current timestamp
//                 startTime?:	LONG,
//                 //	NO	Default: present timestamp
//                 endTime?:	LONG,
//                 //	NO	Default:0
//                 offset?:	INT,
//                 //	NO	Default:1000, Max:1000
//                 limit?:	INT,
//                 txId?:	STRING,
//             } & tInputBase
//             // ответ
//             type tReq =   [ {
//                 "id": NumberString,//"769800519366885376",
//                 "amount": NumberString,//"0.001",
//                 "coin": string,//"BNB",
//                 "network": string,//"BNB",
//                 //0
//                 "status": 0,//0,
//                 "address": string,//"bnb136ns6lfw4zs5hg4n85vdthaad7hq5m4gtkgf23",
//                 "addressTag": NumberString,//"101764890",
//                 "txId": string,//"98A3EA560C6B3336D348B6C83F0F95ECE4F1F5919E94BD006E5BF3BF264FACFC",
//                 "insertTime": string,//1661493146000,
//                 "transferType": string,//0,
//                 //"1/1",
//                 "confirmTimes": string,
//                 "unlockConfirm": string,//0,
//                 "walletType": string,//0
//             },
//             {
//                 "id": NumberString,//"769800519366885376",
//                 "amount": NumberString,//"0.001",
//                 "coin": string,//"BNB",
//                 "network": string,//"BNB",
//                 //1
//                 "status": 1,//0,
//                 "address": string,//"bnb136ns6lfw4zs5hg4n85vdthaad7hq5m4gtkgf23",
//                 "addressTag": NumberString,//"101764890",
//                 "txId": string,//"98A3EA560C6B3336D348B6C83F0F95ECE4F1F5919E94BD006E5BF3BF264FACFC",
//                 "insertTime": string,//1661493146000,
//                 "transferType": string,//0,
//                 //"1/1",
//                 "confirmTimes": string,
//                 "unlockConfirm": string,//0,
//                 "walletType": string,//0
//             }]
//             const name = "/sapi/v1/capital/deposit/hisrec"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         //  (supporting network) (USER_DATA)
//         // network may not be in the response for old withdraw.
//         // Please notice the default startTime and endTime to make sure that time interval is within 0-90 days.
//         // If both startTime and endTimeare sent, time between startTimeand endTimemust be less than 90 days.
//         // If withdrawOrderId is sent, time between startTime and endTime must be less than 7 days.
//         // If withdrawOrderId is sent, startTime and endTime are not sent, will return last 7 days records by default.
//         WithdrawHistory(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 coin?:	STRING,//	NO
//                 withdrawOrderId?:	STRING,//	NO
//                 //	0(0:Email Sent,1:Cancelled 2:Awaiting Approval 3:Rejected 4:Processing 5:Failure 6:Completed)
//                 status?:	INT,
//                 offset?:	INT,//	NO
//                 //	NO	Default: 1000, Max: 1000
//                 limit?:	INT,
//                 //	NO	Default: 90 days from current timestamp
//                 startTime?:	LONG,
//                 //	NO	Default: present timestamp
//                 endTime?:	LONG,
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 // Withdrawal id in Binance
//                 "id": string,//"b6ae22b3aa844210a7041aee7589627c",
//                 "amount": NumberString,//"8.91000000",   // withdrawal amount
//                 "transactionFee":  NumberString,//"0.004", // transaction fee
//                 "coin": string,//"USDT",
//                 "status": number,
//                 "address": string,//"0x94df8b352de7f46f64b01d3666bf6e936e44ce60",
//                 // withdrawal transaction id
//                 "txId": string,//"0xb5ef8c13b968a406cc62a93a8bd80f9e9a906ef1b3fcf20a2e48573c17659268"
//                 // UTC time "2019-10-12 11:12:02",
//                 "applyTime": TimeString,
//                 //"ETH",
//                 "network": string,
//                 // 1 for internal transfer, 0 for external transfer
//                 "transferType": 0 |1
//                 // will not be returned if there's no withdrawOrderId for this withdraw. "WITHDRAWtest123"
//                 "withdrawOrderId"?: string, //
//                 // reason for withdrawal failure
//                 "info": "The address is not valid. Please confirm with the recipient" | "" | string,
//                 // confirm times for withdraw
//                 "confirmNo": number,
//                 //1: Funding Wallet 0:Spot Wallet
//                 "walletType": 0|1,
//                 "txKey": "",
//                 // complete UTC time when user's asset is deduct from withdrawing, only if status =  6(success)
//                 "completeTime": TimeString// "2023-03-23 16:52:41"
//             }[]
//             const name = "/sapi/v1/capital/withdraw/history"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         //  (supporting network) (USER_DATA)
//         // If network is not send, return with default network of the coin.
//         // You can get network and isDefault in networkList in the response of Get /sapi/v1/capital/config/getall (HMAC SHA256).
//         DepositAddress(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 coin:	STRING,
//                 network?:	STRING,
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 //"1HPn8Rx2y6nNSfagQBKy27GB99Vbzg89wv",
//                 "address": string, //"BTC",
//                 "coin": string
//                 "tag": string|"" // "https://btc.com/1HPn8Rx2y6nNSfagQBKy27GB99Vbzg89wv"
//                 "url": string//
//             }
//             const name = "/sapi/v1/capital/deposit/address"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 10,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         //  (USER_DATA)
//         // Fetch account status detail.
//         AccountStatus(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq = {//"Normal"
//                 "data": string
//             }
//             const name = "/sapi/v1/account/status"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGet({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         // Fetch account api trading status detail.
//         AccountAPITradingStatus(data: tFtt) {
//             // входные параметры
//             type tParam = undefined | tInputBase
//             // ответ
//             type tReq = {  // API trading status detail
//                 "data": { // API trading function is locked or not
//                     "isLocked": boolean,   // If API trading function is locked, this is the planned recover time
//                     "plannedRecoverTime": number,
//                     "triggerCondition": { // Number of GTC orders
//                         "GCR": number,  // Number of FOK/IOC orders
//                         "IFER": number, // Number of orders
//                         "UFR": number
//                     },
//                     "updateTime": number
//                 }
//             }
//             const name = "/sapi/v1/account/apiTradingStatus"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         // Only return last 100 records
//         // Only return records after 2020/12/01
//         DustLog(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 startTime?:	LONG//	NO
//                 endTime?:	LONG//	NO
//             } & tInputBase
//             // ответ
//             type tReq = {//Total counts of exchange
//                 "total": number,
//                 "userAssetDribblets":  {
//                     "operateTime": number, // Total transfered BNB amount for this exchange.
//                     "totalTransferedAmount": NumberString,//"0.00132256",      //Total service charge amount for this exchange.
//                     "totalServiceChargeAmount": NumberString,
//                     "transId": number, //Details of  this exchange.
//                     "userAssetDribbletDetails": {
//                         "transId": number,
//                         "serviceChargeAmount": NumberString,//"0.000009",
//                         "amount": NumberString,//"0.0009",
//                         "operateTime": number,
//                         "transferedAmount": NumberString,//"0.000441",
//                         "fromAsset": string//"USDT"
//                     }[]
//                 }[]
//             }
//             const name = "/sapi/v1/asset/dribblet"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         GetAssetsThatCanBeConvertedIntoBNB(data: tFtt) {
//             // входные параметры
//             type tParam =   tInputBase
//             // ответ
//             type tReq = {
//                 "details": [
//                     {
//                         "asset": string, //
//                         "assetFullName": string, //, //Convertible amount
//                         "amountFree": NumberString, //    //BTC amount
//                         "toBTC": NumberString, //   //BNB amount（Not deducted commission fee）
//                         "toBNB": NumberString, //   //BNB amount（Deducted commission fee）
//                         "toBNBOffExchange": NumberString, // "0.01741756", //Commission fee
//                         "exchange": NumberString, // "0.00035546"
//                     }
//                 ],
//                 "totalTransferBtc": NumberString, // "0.00016848",
//                 "totalTransferBNB": NumberString, // "0.01777302", //Commission fee
//                 "dribbletPercentage": NumberString, // "0.02"
//             }
//             const name = "/sapi/v1/asset/dust-btc"
//             const baseUrl = "https://api.binance.com"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         DustTransfer(data: tFtt) {
//             // входные параметры
//             type tParam = { // The asset being converted. For example: asset=BTC,USDT
//                 asset:	ARRAY
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 "totalServiceCharge":NumberString,
//                 "totalTransfered":NumberString,
//                 "transferResult":{
//                     "amount": NumberString,
//                     //"ETH",
//                     "fromAsset": string
//                     "operateTime":number,
//                     "serviceChargeAmount": NumberString,
//                     "tranId": number,
//                     "transferedAmount": NumberString
//                 }[]
//             }
//             const name = "/sapi/v1/asset/dust"
//             const baseUrl = "https://api.binance.com"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 10,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         // Query asset dividend record.
//         // There cannot be more than 180 days between parameter startTime and endTime.
//         AssetDividendRecord(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 asset?:	    STRING	//NO
//                 startTime?:	LONG	//NO
//                 endTime?:	LONG
//                 // Default 20, max 500
//                 limit?:	    INT	//NO
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 "rows":
//                     {
//                         "id":       number,
//                         "amount":   NumberString,
//                         "asset":    string,
//                         "divTime":  number,
//                         "enInfo":   string,
//                         "tranId":   number
//                     }[],
//                 "total":2
//             }
//             const name = "/sapi/v1/asset/assetDividend"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 10,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         // Fetch details of assets supported on Binance.
//         // Please get network and other deposit or withdraw details from GET /sapi/v1/capital/config/getall.
//         AssetDetail(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 asset?:	    STRING	//NO
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 [key: string]: { //min withdraw amount
//                     "minWithdrawAmount": NumberString,  // deposit status (false if ALL of networks' are false)
//                     "depositStatus": boolean,           // withdraw fee
//                     "withdrawFee": number               //withdraw status (false if ALL of networks' are false)
//                     "withdrawStatus": boolean,
//                     "depositTip"?: string//"Delisted, Deposit Suspended" //reason
//                 }
//             }
//             const name = "/sapi/v1/asset/assetDetail"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//         // (USER_DATA)
//         TradeFee(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 symbol?:	STRING
//             } & tInputBase
//             // ответ
//             type tReq = {
//                     "symbol": string,//"ADABNB",
//                     "makerCommission": NumberString,//"0.001",
//                     "takerCommission": NumberString,//"0.001"
//                 }[]
//             const name = "/sapi/v1/asset/assetDetail"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         // You need to enable Permits Universal Transfer option for the API Key which requests this endpoint.
//         UserUniversalTransfer(data: tFtt) {
//             // входные параметры
//
//             type tParam = {
//                 type:	ENUM//	YES
//                 asset:	STRING//	YES
//                 amount:	DECIMAL//	YES
//                 fromSymbol?:	STRING//	NO
//                 toSymbol?:	STRING//	NO
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 "tranId": number
//             }
//
//             const name = "/sapi/v1/asset/transfer "
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "UID",
//                     wight: 900,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//
//         // (USER_DATA)
//         // fromSymbol must be sent when type are ISOLATEDMARGIN_MARGIN and ISOLATEDMARGIN_ISOLATEDMARGIN
//         // toSymbol must be sent when type are MARGIN_ISOLATEDMARGIN and ISOLATEDMARGIN_ISOLATEDMARGIN
//         // Support query within the last 6 months only
//         // If startTimeand endTime not sent, return records of the last 7 days by default
//         QueryUserUniversalTransferHistory(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 type:	ENUM//	YES
//                 startTime:	LONG//	NO
//                 endTime:	LONG//	Default 1
//                 current:	INT//	Default 10, Max 100
//                 size:	INT//
//                 fromSymbol:	STRING//	NO
//                 toSymbol:	STRING//	NO
//             } & tInputBase
//             // ответ
//             type tReq = {
//                 "total":2,
//                 "rows": {
//                         "asset": string,//"USDT",
//                         "amount": NumberString,//"1",
//                         "type":string,//"MAIN_UMFUTURE",
//                         "status": "CONFIRMED" | "FAILED" | "PENDING",//"CONFIRMED", // status: CONFIRMED / FAILED / PENDING
//                         "tranId": number,//11415955596,
//                         "timestamp": number,//1544433328000
//                     }[]
//             }
//             const name = "/sapi/v1/asset/transfer"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//         // (USER_DATA)
//         // Currently supports querying the following business assets：Binance Pay, Binance Card, Binance Gift Card, Stock Token
//         FundingWallet(data: tFtt) {
//             // входные параметры
//             type tParam = {
//                 asset:	STRING	//NO	true or false
//                 needBtcValuation:	STRING
//             } & tInputBase
//             // ответ
//             type tReq = {//"USDT"
//                     "asset": string,//avalible balance
//                     "free": NumberString,//"1",    //locked asset
//                     "locked": NumberString,//"0",  //freeze asset
//                     "freeze": NumberString,//"0",  //
//                     "withdrawing": NumberString,//"0",
//                     "btcValuation": NumberString,//"0.00000091"
//                 }[]
//             const name = "/sapi/v3/asset/getUserAsset"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcPostSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//
//
//         // (USER_DATA)
//         // If asset is set, then return this asset, otherwise return all assets positive.
//         // If needBtcValuation is set, then return btcValudation.
//         UserAsset(data: tFtt) {
//             // входные параметры
//             type tParam = {//	NO	If asset is blank, then query all positive assets user have.
//                 asset:	STRING//	NO	Whether need btc valuation or not.
//                 needBtcValuation:	BOOLEAN
//             } & tInputBase
//             // ответ
//             type tReq = {//"AVAX",
//                 "asset": string,//
//                 "free": NumberString,//"1",
//                 "locked": NumberString,//""0",
//                 "freeze": NumberString,//""0",
//                 "withdrawing": NumberString,//""0",
//                 "ipoable": NumberString,//""0",
//                 "btcValuation": NumberString,//""0"
//             }[]
//             const name = "/sapi/v3/asset/getUserAsset"
//             const baseUrl = "https://api.binance.com/"
//
//             const f = async  (params?: tParam )=>  (await base.funcGetSSH({data, params, url: baseUrl+name})).data as tReq
//             return {
//                 wight: {
//                     type: "IP",
//                     wight: 1,
//                     max: 10000,
//                     timeMs: 60 * 1000
//                 },
//                 function: f
//             } satisfies standard<typeof f>
//         }
//
//     }
// }
//
