import {tGetAllData} from "../../IHistoryBase";
import {tSymbolData} from "../type";

type tFetch = any | ((input: any | URL, init?: any | undefined) => Promise<any>)
type tBinanceSymbolsAllObjs = {
    fetch: tFetch,
    quoteAsset?: string
}


export const mBinance = {

}

let t : Pick<any, any>
// tSymbolData
type tSpot = {
    symbols(): Promise<tSymbolData[]>,
    
}
const spot = {
    // symbols:
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