import {LoadQuoteBase, tFuncLoad, tLoadFist, tSetHistoryData} from "../LoadBase";
import {tGetAllData, tSocketInput, tSymbolLoadInfo, tUpDateAllKline} from "../IHistoryBase";
import {TF} from "../../Common/Time";


export {LoadQuoteBase} from "../LoadBase";

type tFetch = any | ((input: any | URL, init?: any | undefined) => Promise<any>)
type tBinanceSymbolsAllObjs = {
    fetch: tFetch,
    quoteAsset?: string
}

class CLoadBars {

}

export function BinanceSymbolsAllObjNew(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api1.binance.com/api/v3/exchangeInfo';
        const result = await (await (data.fetch)(post))?.json()
        const symbols:[]= result.symbols.filter((m:any)=> (m.status=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true ))
        return {
            symbols: symbols.map((m:any)=>({
                    name:   m.symbol,
                    tickSize:   m.filters?.[0]?.tickSize,
                    minPrice:   m.filters?.[1]?.tickSize,
                    minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                    minQty:     m.filters?.[2]?.minQty,
                    stepSize:   m.stepSize?.[2]?.minQty,
                    quoteAsset: m.quoteAsset,
                    baseAsset:  m.baseAsset
            }))
        }
    }
}

export function BinanceSymbolsAllObjNewMargin(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api1.binance.com/api/v3/exchangeInfo';
        const result = await (await (data.fetch)(post))?.json()
        const symbols:[]= result.symbols.filter((m:any)=> (m.status=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true )  && !m.permissions.includes('LEVERAGED') && m.isMarginTradingAllowed && m.permissions.includes('MARGIN'))

        return {
            symbols: symbols.map((m:any)=>({
                    name:   m.symbol,
                    tickSize:   m.filters?.[0]?.tickSize,
                    minPrice:   m.filters?.[1]?.tickSize,
                    minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                    minQty:     m.filters?.[2]?.minQty,
                    stepSize:   m.stepSize?.[2]?.minQty,
                    quoteAsset: m.quoteAsset,
                    baseAsset:  m.baseAsset
                }))
        }
    }
}


export function BinanceSymbolsAllObjNewMarginPlus(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api1.binance.com/api/v3/exchangeInfo';
        const result = await (await (data.fetch)(post))?.json()
        const symbols:[]= result.symbols.filter((m:any)=> (m.status=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true ) )
        const ttt = new Set;
        const arr = [
            "BNBUSDT","BTCUSDT","ETHUSDT","TRXUSDT","XRPUSDT","EOSUSDT","LINKUSDT","ONTUSDT","ADAUSDT","ETCUSDT","LTCUSDT","XLMUSDT","USDCUSDT","XMRUSDT","NEOUSDT","ATOMUSDT","DASHUSDT","ZECUSDT","MATICUSDT","BATUSDT","IOSTUSDT","VETUSDT","QTUMUSDT","IOTAUSDT","XTZUSDT","BCHUSDT","RVNUSDT","BUSDUSDT","ZILUSDT","ONEUSDT","ANKRUSDT","TFUELUSDT","IOTXUSDT","HBARUSDT","FTMUSDT","SXPUSDT","DOTUSDT","ALGOUSDT","THETAUSDT","COMPUSDT","KNCUSDT","OMGUSDT","KAVAUSDT","DOGEUSDT","WAVESUSDT","SNXUSDT","CRVUSDT","SUSHIUSDT","UNIUSDT","MANAUSDT","AVAXUSDT","NEARUSDT","FILUSDT","TRBUSDT","SRMUSDT","AAVEUSDT","SANDUSDT","CHZUSDT","COTIUSDT","FETUSDT","CHRUSDT","GRTUSDT","STPTUSDT","LRCUSDT","KSMUSDT","ROSEUSDT","REEFUSDT","STXUSDT","ENJUSDT","RUNEUSDT","SKLUSDT","OGNUSDT","EGLDUSDT","1INCHUSDT","MDTUSDT","CAKEUSDT","SOLUSDT","LINAUSDT","SUPERUSDT","GTCUSDT","PUNDIXUSDT","AUDIOUSDT","BONDUSDT","SLPUSDT","POLSUSDT","PONDUSDT","TVKUSDT","DENTUSDT","FTTUSDT","ARUSDT","DYDXUSDT","UNFIUSDT","AXSUSDT","SHIBUSDT","WINUSDT","ENSUSDT","ALICEUSDT","TLMUSDT","ICPUSDT","C98USDT","FLOWUSDT","BAKEUSDT","CHESSUSDT","GALAUSDT","HIVEUSDT","DARUSDT","IDEXUSDT","MBOXUSDT","ANTUSDT","CLVUSDT","WAXPUSDT","BNXUSDT","KLAYUSDT","TRIBEUSDT","MINAUSDT","RNDRUSDT","JASMYUSDT","QUICKUSDT","LPTUSDT","AGLDUSDT","BICOUSDT","CTXCUSDT","DUSKUSDT","HOTUSDT","SFPUSDT","YGGUSDT","FLUXUSDT","ICXUSDT","CELOUSDT","VOXELUSDT","BETAUSDT","BLZUSDT","MTLUSDT","PEOPLEUSDT","QNTUSDT","PYRUSDT","SUNUSDT","HNTUSDT","KEYUSDT","PAXGUSDT","RAREUSDT","WANUSDT","TWTUSDT","RADUSDT","CVCUSDT","QIUSDT","GMTUSDT","APEUSDT","KDAUSDT","MBLUSDT","API3USDT","CTKUSDT","NEXOUSDT","MOBUSDT","WOOUSDT","ASTRUSDT","GALUSDT","OPUSDT","ANCUSDT","REIUSDT","LEVERUSDT","LDOUSDT","FIDAUSDT","KMDUSDT","FLMUSDT","BURGERUSDT","AUCTIONUSDT","FIOUSDT","IMXUSDT","SPELLUSDT","STGUSDT","BELUSDT","WINGUSDT","AVAUSDT","LOKAUSDT","DEXEUSDT","LUNCUSDT"
        ]
        arr.forEach(e=>ttt.add(e));
        return {
            symbols: symbols.map((m:any)=>({
                    name:   m.symbol,
                    tickSize:   m.filters?.[0]?.tickSize,
                    minPrice:   m.filters?.[1]?.tickSize,
                    minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                    minQty:     m.filters?.[2]?.minQty,
                    stepSize:   m.stepSize?.[2]?.minQty,
                    quoteAsset: m.quoteAsset,
                    baseAsset:  m.baseAsset
                })).filter(e=>ttt.has(e.name))
        }
    }
}


export function BinanceSymbolsAllObjNewMarginIsolated(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api1.binance.com/api/v3/exchangeInfo';
        const result = await (await (data.fetch)(post))?.json()
        const symbols:[]= result.symbols.filter((m:any)=> (m.status=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true ) )
        const ttt = new Set;
        const arr = [
            "1INCHUSDT","AAVEUSDT","ACAUSDT","ACHUSDT","ADAUSDT","AGLDUSDT","AIONUSDT","AKROUSDT","ALCXUSDT","ALGOUSDT","ALICEUSDT","ALPACAUSDT","ALPHAUSDT","AMPUSDT","ANCUSDT","ANKRUSDT","ANTUSDT","APEUSDT","API3USDT","ARDRUSDT","ARPAUSDT","ARUSDT","ASTRUSDT","ATAUSDT","ATOMUSDT","AUDIOUSDT","AUTOUSDT","AVAUSDT","AVAXUSDT","AXSUSDT","BADGERUSDT","BAKEUSDT","BALUSDT","BANDUSDT","BATUSDT","BCHUSDT","BEAMUSDT","BELUSDT","BETAUSDT","BICOUSDT","BLZUSDT","BNBUSDT","BNTUSDT","BNXUSDT","BONDUSDT","BSWUSDT","BTCSTUSDT","BTCUSDT","BTGUSDT","BTSUSDT","BTTCUSDT","BURGERUSDT","BUSDUSDT","C98USDT","CAKEUSDT","CELOUSDT","CELRUSDT","CFXUSDT","CHESSUSDT","CHRUSDT","CHZUSDT","CKBUSDT","CLVUSDT","COCOSUSDT","COMPUSDT","COSUSDT","COTIUSDT","CRVUSDT","CTKUSDT","CTSIUSDT","CTXCUSDT","CVCUSDT","CVPUSDT","CVXUSDT","DARUSDT","DASHUSDT","DATAUSDT","DCRUSDT","DEGOUSDT","DENTUSDT","DEXEUSDT","DGBUSDT","DIAUSDT","DNTUSDT","DOCKUSDT","DODOUSDT","DOGEUSDT","DOTUSDT","DREPUSDT","DUSKUSDT","DYDXUSDT","EGLDUSDT","ELFUSDT","ENJUSDT","ENSUSDT","EOSUSDT","EPXUSDT","ERNUSDT","ETCUSDT","ETHUSDT","FARMUSDT","FETUSDT","FIDAUSDT","FILUSDT","FIOUSDT","FIROUSDT","FISUSDT","FLMUSDT","FLOWUSDT","FLUXUSDT","FORTHUSDT","FORUSDT","FTMUSDT","FTTUSDT","FUNUSDT","FXSUSDT","GALAUSDT","GALUSDT","GLMRUSDT","GMTUSDT","GNOUSDT","GRTUSDT","GTCUSDT","GTOUSDT","HARDUSDT","HBARUSDT","HIGHUSDT","HIVEUSDT","HNTUSDT","HOTUSDT","ICPUSDT","ICXUSDT","IDEXUSDT","ILVUSDT","IMXUSDT","INJUSDT","IOSTUSDT","IOTAUSDT","IOTXUSDT","IRISUSDT","JASMYUSDT","JOEUSDT","JSTUSDT","KAVAUSDT","KDAUSDT","KEYUSDT","KLAYUSDT","KMDUSDT","KNCUSDT","KP3RUSDT","KSMUSDT","LDOUSDT","LEVERUSDT","LINAUSDT","LINKUSDT","LITUSDT","LOKAUSDT","LPTUSDT","LRCUSDT","LSKUSDT","LTCUSDT","LTOUSDT","LUNAUSDT","LUNCUSDT","MANAUSDT","MASKUSDT","MATICUSDT","MBLUSDT","MBOXUSDT","MCUSDT","MDTUSDT","MDXUSDT","MFTUSDT","MINAUSDT","MITHUSDT","MKRUSDT","MLNUSDT","MOBUSDT","MOVRUSDT","MTLUSDT","NBSUSDT","NEARUSDT","NEOUSDT","NEXOUSDT","NKNUSDT","NMRUSDT","NULSUSDT","OCEANUSDT","OGNUSDT","OGUSDT","OMGUSDT","OMUSDT","ONEUSDT","ONGUSDT","ONTUSDT","OOKIUSDT","OPUSDT","ORNUSDT","OXTUSDT","PAXGUSDT","PEOPLEUSDT","PERLUSDT","PERPUSDT","PHAUSDT","PLAUSDT","PNTUSDT","POLSUSDT","POLYUSDT","PONDUSDT","POWRUSDT","PUNDIXUSDT","PYRUSDT","QIUSDT","QNTUSDT","QTUMUSDT","QUICKUSDT","RADUSDT","RAREUSDT","RAYUSDT","REEFUSDT","REIUSDT","RENUSDT","REPUSDT","REQUSDT","RLCUSDT","RNDRUSDT","ROSEUSDT","RSRUSDT","RUNEUSDT","RVNUSDT","SANDUSDT","SCRTUSDT","SCUSDT","SFPUSDT","SHIBUSDT","SKLUSDT","SLPUSDT","SNXUSDT","SOLUSDT","SPELLUSDT","SRMUSDT","STGUSDT","STMXUSDT","STORJUSDT","STPTUSDT","STRAXUSDT","STXUSDT","SUNUSDT","SUPERUSDT","SUSHIUSDT","SXPUSDT","SYSUSDT","TCTUSDT","TFUELUSDT","THETAUSDT","TKOUSDT","TLMUSDT","TOMOUSDT","TORNUSDT","TRBUSDT","TRIBEUSDT","TROYUSDT","TRUUSDT","TRXUSDT","TUSDT","TUSDUSDT","TVKUSDT","TWTUSDT","UMAUSDT","UNFIUSDT","UNIUSDT","USDCUSDT","UTKUSDT","VETUSDT","VGXUSDT","VIDTUSDT","VITEUSDT","VOXELUSDT","VTHOUSDT","WANUSDT","WAVESUSDT","WAXPUSDT","WINGUSDT","WINUSDT","WNXMUSDT","WOOUSDT","WRXUSDT","WTCUSDT","XECUSDT","XEMUSDT","XLMUSDT","XMRUSDT","XRPUSDT","XTZUSDT","XVSUSDT","YFIIUSDT","YFIUSDT","YGGUSDT","ZECUSDT","ZENUSDT","ZILUSDT","ZRXUSDT"
        ]
        arr.forEach(e=>ttt.add(e));
        return {
            symbols: symbols.map((m:any)=>({
                    name:   m.symbol,
                    tickSize:   m.filters?.[0]?.tickSize,
                    minPrice:   m.filters?.[1]?.tickSize,
                    minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                    minQty:     m.filters?.[2]?.minQty,
                    stepSize:   m.stepSize?.[2]?.minQty,
                    quoteAsset: m.quoteAsset,
                    baseAsset:  m.baseAsset
                })).filter(e=>ttt.has(e.name))
        }
    }
}


export function MexcSymbolsAllObjNewMarginIsolated(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api.mexc.com/api/v3/exchangeInfo';
        const result = await (await (data.fetch)(post))?.json()
        const symbols:[]= result.symbols.filter((m:any)=> (m.status=="ENABLED") )
        return {
            symbols: symbols.map((m:any)=>({
                    name:   m.symbol,
                    tickSize:   m.filters?.[0]?.tickSize,
                    minPrice:   m.filters?.[1]?.tickSize,
                    minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                    minQty:     m.filters?.[2]?.minQty,
                    stepSize:   m.stepSize?.[2]?.minQty,
                    quoteAsset: m.quoteAsset,
                    baseAsset:  m.baseAsset
                }))

        }
    }
}


export function SymbolsdUSASymbolsAllObjNewMarginIsolated(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='http://localhost:3013/historyUSA/symbols';
            const result = await (await (data.fetch)(post))?.json()
            const symbols:[]= result.result // .symbols.filter((m:any)=> (m.status=="ENABLED") )
            return {
                symbols: symbols.map((m:any)=>({
                        name:       m.symbol, //+ " " +m.name ,
                        tickSize:   0.01,
                        minPrice:   0.01,
                        minStepLot: 0.01, //minQty stepSize
                        minQty:     0.01,
                        stepSize:   0.01,
                        quoteAsset: "USDT",
                        baseAsset:  m.symbol
                    }))

            }
    }
}

export function GateIoSymbolsAllObjNewMarginIsolated(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://api.gateio.ws/api/v4/margin/currency_pairs';
            const result = await (await (data.fetch)(post))?.json()
            const symbols:[]= result.filter((m:any)=> (m.status==1)  )
            return {
                symbols: symbols.map((m:any)=>({
                        name:   m.id,
                        tickSize:   0.0001,
                        minPrice:   0.0001,
                        minStepLot: 0.0001, //minQty stepSize
                        minQty:     0.0001,
                        stepSize:   0.0001,
                        quoteAsset: m.quote,
                        baseAsset:  m.base
                    }))
            }
    }
}
// export function BinanceSymbolsAllObjUSDT() {return BinanceSymbolsAllObjNew({quoteAsset: "USDT"})}

export function BinanceSymbolsAllFuturesObj2(data: tBinanceSymbolsAllObjs) {
    return async function (): Promise<tGetAllData> {
        const post='https://fapi.binance.com/fapi/v1/exchangeInfo';
            const result = await (await (data.fetch)(post))?.json()
            const symbols:[]= result.symbols.filter((m:any)=> (m.status=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true ))
            return {
                symbols: symbols.map((m:any)=>({
                        name:   m.symbol,
                        tickSize:   m.filters?.[0]?.tickSize,
                        minPrice:   m.filters?.[1]?.tickSize,
                        minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                        minQty:     m.filters?.[2]?.minQty,
                        stepSize:   m.stepSize?.[2]?.minQty,
                        quoteAsset: m.quoteAsset,
                        baseAsset:  m.baseAsset
                    }))
            }
    }
}

export function BinanceSymbolsAllFuturesCoinM(data: tBinanceSymbolsAllObjs) {
    return async function () {
        const post='https://dapi.binance.com/dapi/v1/exchangeInfo';
            const result = await (await (data.fetch)(post))?.json()
            const symbols:[]= result.symbols.filter((m:any)=> (m.contractStatus=="TRADING") && (data?.quoteAsset ? m.quoteAsset==data.quoteAsset : true ))
            return {
                symbols: symbols.map((m:any)=>({
                        name:   m.symbol,
                        tickSize:   m.filters?.[0]?.tickSize,
                        minPrice:   m.filters?.[1]?.tickSize,
                        minStepLot: m.filters?.[0]?.tickSize, //minQty stepSize
                        minQty:     m.filters?.[2]?.minQty,
                        stepSize:   m.stepSize?.[2]?.minQty,
                        quoteAsset: m.quoteAsset,
                        baseAsset:  m.baseAsset
                    }))
            }
    }
}



//Прмиер подключения к АПИ МСтрейду /fapi/v1/klines

export function BinanceSocketRealTimeSpotNew(_WebSocket: any) {
    return function (info:{name : string}, callback:(data: tSocketInput)=> void , disable:()=>boolean, onclose:()=>void):void {
        // подготовка данных для подключения
        if (!info.name) {onclose(); return;}
        const url='wss://stream.Binance.com:9443/ws/'+info.name.toLowerCase()+'@bookTicker';

        //стандартные методы ВебСокета
        let lastPrice: number = 0;
        const socket =  new _WebSocket(url)
        socket.onerror = (e:any)=>{console.error('WebSocket Error: ' , e,' ',info.name);}
        socket.onclose = ()=>{onclose();};
        socket.onmessage = (e:any)=> {
            let data:any = JSON.parse(e.data);
            //проверяем есть ли у нас слушатели с этой стороны, если их нету тозакрваем соединение
            if (lastPrice==data.b) return ;
            lastPrice=data.b;
            if (disable()) { socket.close(); }
            //отправляем полученные данные
            return callback({
                ticks:[{time: new Date(), price: Number(data.b), volume: 1}]
            });
        }
    }
}


export function BinanceSocketKlineAllBase(setting: {WebSocket: any, url: string}) {
    return function (callback:(mas: {data: Partial<tUpDateAllKline>, name:string})=> void , disable:()=>boolean, onclose:()=>void, data:{names: string[]}):void {
        const combiner = "/stream?streams=" +(data.names.map(e=>e.toLowerCase()+"@kline_1m")).join("/")
        const url = setting.url + combiner;
        const socket = new setting.WebSocket(url)
        socket.onerror = (e: any)=> console.error('WebSocket Error: ' , e,' ');
        //при закрытии соединения надо сообщить данный статус
        socket.onclose = ()=>{onclose();};
        socket.onmessage = (e: any)=> {
            const data: any = JSON.parse(e.data);
            const datum = data.data
            //проверяем есть ли у нас слушатели с этой стороны, если их нету тозакрваем соединение
            // if (disable()) {socket.close();}
            //отправляем полученные данные
            const ar:{data: Partial<tUpDateAllKline>, name:string} =
                { //    const {c,h,o,l,v,t, i:tf} = data

                    data: {
                        s: datum.s,
                        i: TF.M1,
                        n: +datum.k.n,
                        V: +datum.k.V,
                        v: +datum.k.v,
                        t: +datum.k.t,
                        f: +datum.k.f,
                        h: +datum.k.h,
                        l: +datum.k.l,
                        o: +datum.k.o,
                        c: +datum.k.c,
                    },
                    name :datum.s
                }

            return callback(ar);
        }
    }
}

export function BinanceSocketKlineSpotAllNew(_WebSocket: any) {
    return BinanceSocketKlineAllBase({WebSocket: _WebSocket, url: 'wss://stream.binance.com:9443'})
}
export function BinanceSocketKlineFAll(_WebSocket: any) {
    return BinanceSocketKlineAllBase({WebSocket: _WebSocket, url: 'wss://fstream.binance.com:9443'})
}
export function BinanceSocketKlineDAll(_WebSocket: any) {
    return BinanceSocketKlineAllBase({WebSocket: _WebSocket, url: 'wss://dstream.binance.com:9443'})
}
// export function BinanceSocketKlineSpotAll(){return BinanceSocketKlineSpotAllNew()}

export function BinanceSocketSpotAllTurboNew(_WebSocket: any) {
    return function (callback:(mas: {data: tSocketInput, name:string}[])=> void , disable:()=>boolean, onclose:()=>void):void {
        const url='wss://stream.Binance.com:9443/ws/!bookTicker';
        /*
         "s":"BNBUSDT",     // symbol
          "b":"25.35190000", // best bid price
          "B":"31.21000000", // best bid qty
          "a":"25.36520000", // best ask price
          "A":"40.66000000"  // best ask qty
  */
        const socket : any = new _WebSocket(url);
        socket.onerror= (e: any)=>console.error('WebSocket Error: ' , e,' ');
        socket.onclose=()=>{onclose();};
        socket.onmessage=(e: any)=> {
            let data:any= JSON.parse(e.data);
            //проверяем есть ли у нас слушатели с этой стороны, если их нет, то закрываем соединение
            // if (disable()) {socket.close();}
            //отправляем полученные данные
            const ar:{data: tSocketInput, name:string}[] = [
                {
                    data: {
                        ticks:[{time: new Date(), price: +data.b, volume:0}]
                    },
                    name :data.s
                }
            ]
            return callback(ar);
        }
    }
}



//Пример подключения к АПИ Bicnance потдключение к юарам в 1000мс
//обьемы приходя от начала дня сумированные

export function BinanceSocketAllBase(data: {WebSocket: any , url?: string}) {
    const url= data.url ?? 'wss://stream.Binance.com:9443/ws/!ticker@arr';

    return function (callback:(mas: {data: tSocketInput, name:string}[])=> void , disable:()=>boolean, onclose:()=>void):void {
        const socket  = new data.WebSocket(url)
        socket.onerror =    (e: any) => console.error('WebSocket Error: ' , e,' ');
        socket.onopen =     (e: any) => { }
        socket.onclose =    (e: any) => {onclose();};
        socket.onmessage =  (e: any) => {
            let data : any = JSON.parse(e.data);
            //проверяем есть ли у нас слушатели с этой стороны, если их нету тозакрваем соединение
            // if (disable()) {socket.close();}
            //отправляем полученные данные
            const ar : {data: tSocketInput, info: Partial<tSymbolLoadInfo>, name:string}[] =data.map((e:any)=>{
                return {
                    data: {
                        ticks:[{time: new Date(+e.E), price: +e.c, volume:0}]
                    },
                    name :e.s,
                    info: {
                        close24: +e.c,
                        open24: +e.o,
                        volumeBase24: +e.v,
                        volume24: +e.q
                    }
                }
            })
            return callback(ar);
        }
    }
}
// spot
export function BinanceSocketSpotAllNew(WebSocket: any) {
    return BinanceSocketAllBase({
        WebSocket: WebSocket,
        url: 'wss://stream.binance.com:9443/ws/!ticker@arr'
    })
}
// для фьючерсов USDⓈ-M
export function BinanceSocketFuturesAll(WebSocket: any) {
    return BinanceSocketAllBase({
        WebSocket: WebSocket,
        url: 'wss://fstream.binance.com/ws/!ticker@arr'
    })
}
// Futures COIN-M
export function BinanceSocketDCoinMAll(WebSocket: any) {
    return BinanceSocketAllBase({
        WebSocket: WebSocket,
        url: 'wss://dstream.binance.com/ws/!ticker@arr'
    })
}



type tMBar = tSetHistoryData
const binanceFuncLoad = async ({symbol,interval,startTime,endTime,limit,baseURL,fetch}: tFuncLoad<number, string>): Promise<tMBar[]> => {
    const _interval =   `&interval=${interval}`
    const _startTime =  `&startTime=${startTime.valueOf()}`
    const _endTime =    endTime?`&endTime=${endTime.valueOf()}`:``
    const _limit =      endTime?`&limit=${limit}`:``
    const url =         baseURL +`symbol=${symbol}` + _interval + _startTime + _endTime + _limit

    const data = (await (await fetch(url)).json());
    return data?.map((m: any):tSetHistoryData => ({
        time: new Date(+m[0]),
        open:   +m[1],
        high:   +m[2],
        low:    +m[3],
        close:  +m[4],
        volume:     +m[5],
        tickVolume  : +m[8]
    })) ?? []
}
const binanceFuncFistTime = async ({symbol,interval,baseURL,fetch}: tLoadFist<string>): Promise<Date> => {
    const data =  baseURL +`symbol=${symbol}` + `&interval=${interval}` + `&startTime=${String(new Date('2000').valueOf())}` + `&limit=1`
    const parseData = (await (await fetch(data)).json());
    return new Date(Number(parseData?.[0]?.[0] as number|string))
}

const binanceInterval: { time: TF, name: string }[] = [
    {time: TF.M1,       name: '1m'}
    , {time: TF.M3,     name: '3m'}
    , {time: TF.M5,     name: '5m'}
    , {time: TF.M15,    name: '15m'}
    , {time: TF.M30,    name: '30m'}
    , {time: TF.H1,     name: '1h'}
    , {time: TF.H2,     name: '2h'}
    , {time: TF.H4,     name: '4h'}
    , {time: TF.H6,     name: '6h'}
    , {time: TF.H8,     name: '8h'}
    , {time: TF.H12,    name: '12h'}
    , {time: TF.D1,     name: '1d'}
    , {time: TF.W1,     name: '1w'}
]




export const BinanceLoadEasySpot = (data?: { fetch?: tFetch }) => LoadQuoteBase({
    base: 'https://api1.binance.com/api/v3/klines?',
    maxLoadBars2: 1000,
    countConnect: 1150,
    maxLoadBars: 1000,
    time: 60000,
    funcLoad: binanceFuncLoad,
    funcFistTime: binanceFuncFistTime,
    intervalToName: binanceInterval
}, data)



export const BinanceLoadEasyFutures = (data?: { fetch?: tFetch }) => LoadQuoteBase({
    base: 'https://fapi.binance.com/fapi/v1/klines?', // 'https://fapi.binance.com/fapi/v1/klines?symbol='
    maxLoadBars2: 1000,
    countConnect: 450,
    maxLoadBars: 1000,
    time: 60000,
    funcLoad: binanceFuncLoad,
    funcFistTime: binanceFuncFistTime,
    intervalToName: binanceInterval
}, data) // dapi/v1/klines hj

export const BinanceLoadEasyFuturesM = (data?: { fetch?: tFetch }) =>  LoadQuoteBase({
    base: 'https://dapi.binance.com/dapi/v1/klines?', // 'https://fapi.binance.com/fapi/v1/klines?symbol='
    maxLoadBars2: 1000,
    countConnect: 450,
    maxLoadBars: 1000,
    time: 60000,
    funcLoad: binanceFuncLoad,
    funcFistTime: binanceFuncFistTime,
    intervalToName: binanceInterval
}, data)

export const MexcLoadEasyFuturesM = (data?: { fetch?: tFetch }) =>  LoadQuoteBase({
    base: 'https://api.mexc.com/api/v3/klines?', // 'https://fapi.binance.com/fapi/v1/klines?symbol='
    maxLoadBars2: 1000,
    countConnect: 1150,
    maxLoadBars: 1000,
    time: 60000,
    funcLoad: async ({symbol,interval,startTime,endTime,limit,baseURL,fetch}): Promise<tSetHistoryData[]> => {
        const _interval =   `&interval=${interval}`
        const _startTime =  `&startTime=${startTime.valueOf()}`
        const _endTime =    endTime?`&endTime=${endTime.valueOf()}`:``
        const _limit =      endTime?`&limit=${limit}`:``
        const url =         baseURL +`symbol=${symbol}` + _interval + _startTime + _endTime + _limit
        const data = (await (await fetch(url)).json());
        return data?.map((m: any):tSetHistoryData => ({
            time: new Date(+m[0]),
            open:   +m[1],
            high:   +m[2],
            low:    +m[3],
            close:  +m[4],
            volume: +m[5],
            tickVolume: +m[8]
        }))
    },
    funcFistTime: async (e) => new Date('2022')
    ,
    intervalToName: binanceInterval
}, data)


export const GateIoLoadEasySpot = (data?: { fetch?: tFetch }) => LoadQuoteBase({
    base: 'https://api.gateio.ws/api/v4/spot/candlesticks?',
    maxLoadBars2: 500,
    countConnect: 500000,
    maxLoadBars: 500,
    time: 60000,
    funcLoad: async ({symbol,interval,startTime,endTime,limit,baseURL,fetch}): Promise<tSetHistoryData[]> => {
        const _interval =   `&interval=${interval}`
        const _startTime =  `&startTime=${startTime.valueOf()}`
        const _endTime =    endTime?`&endTime=${endTime.valueOf()}`:``
        const _limit =      endTime?`&limit=${limit}`:``
        const url =         baseURL +`symbol=${symbol}` + _interval + _startTime + _endTime + _limit
        const data = (await (await fetch(url)).json());
        return data?.map((m: any):tSetHistoryData => ({
            time: new Date(+m[0]*1000),
            open:   +m[5],
            high:   +m[3],
            low:    +m[4],
            close:  +m[2],
            volume: +m[1],
            tickVolume: 0
        }))
    },
    funcFistTime: async ({symbol,interval,baseURL,fetch}): Promise<Date> => {
        const url = baseURL + `currency_pair=${symbol}` + '&interval=' + interval + '&from=' + String(Math.round(new Date('2022-01-15').valueOf()/1000))  + '&to=' + String(Math.round((new Date('2022-01-15').valueOf()/1000) + 60))
        const data = (await (await fetch(url)).json());
        const result = data?.[0]?.[0] as number|string
        return new Date(Number(result)*1000)
    },
    intervalToName: binanceInterval
}, data)


export const USALoadEasyFuturesM = (data?: { fetch?: tFetch }) =>  LoadQuoteBase({
    base: 'http://localhost:3013/historyUSA/history?', // 'https://fapi.binance.com/fapi/v1/klines?symbol='
    maxLoadBars2: 10000,
    countConnect: 1,
    maxLoadBars: 10000,
    time: 300,
    funcLoad: async ({symbol,interval,startTime,endTime:__endTime,limit,baseURL,fetch}): Promise<tSetHistoryData[]> => {
        // end,limit,start,tf,fetch,symbol
        const maxBarTime = (Date.now() - 60*1000*16)
        const endTime = !__endTime || __endTime.valueOf() > maxBarTime ? new Date(maxBarTime) : __endTime
        const _interval =   `&tf=${interval}`
        const _startTime =  `&start=${startTime.toISOString()}`
        const _endTime =    endTime?`&end=${endTime.toISOString()}`:``
        const _limit =      endTime?`&limit=${limit}`:``
        const url =         baseURL +`symbol=${symbol}` + _interval + _startTime + _endTime + _limit

        const data = (await (await fetch(url)).json())?.data ;
        /*
            t: '2022-10-06T19:30:00Z',
            o: 11.84,
            h: 11.86,
            l: 11.79,
            c: 11.82,
            v: 18972,
            n: 336,
            vw: 11.825596
        * */
        return data?.map(({t,o,h,l,c,v,n,nw}: any):tSetHistoryData => {
            return ({
                time: new Date(t),
                open: +o,
                high: +h,
                low: +l,
                close: +c,
                volume: +v,
                tickVolume: +0
            })
        }) ?? []
    },
    funcFistTime: async ({symbol,interval,baseURL,fetch}): Promise<Date> => {
        return new Date('2022')
    },
    intervalToName: [
        {time: TF.M1, name: '1Min'}
        , {time: TF.M5,     name: '5Min'}
        , {time: TF.M15,    name: '15Min'}
        , {time: TF.M30,    name: '30Min'}
        , {time: TF.H1,     name: '1Hour'}
        , {time: TF.H4,     name: '4Hour'}
    ]
}, data)



export namespace Test{
    export function Test1(){}
    function Test2(){}
}