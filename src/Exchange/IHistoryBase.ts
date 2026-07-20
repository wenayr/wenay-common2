import {const_Date, TF} from "../Common/Time";
import {CBar, IBars} from "./Bars";
import {CQuotesHistory, CQuotesHistoryMutable} from "./MarketData";
import {iListNodeMini} from "../Common/data/ListNodeAnd";
import {tInfoForLoadHistory, tSetHistoryData, tSymbolLoadInfo} from "./LoadBase";
// this is a very old version - more needed for backward compatibility
export type tPrice = number;
export type tTick = Readonly<{ time: const_Date, price: tPrice, volume: number }>;


export type tSetHistory = tSetHistoryData[]
// export type tSymbolLoadInfo = { readonly name: tSymbol, readonly exchangeName: tExchange, readonly tf: tTF };
// export type tInfoForLoadHistory = tSymbolLoadInfo & { time1: Date, time2: Date , right?:boolean}
// export type tInfoForLoad = tSymbolLoadInfo & ({ time1: Date | number } | { time1: Date, time2: Date })
// export type tHistoryLoad = (SymbolInfo: tSymbolLoadInfo) => tSetHistory | undefined;
export type tLoad = (InfoForLoad:  tInfoForLoadHistory) => Promise<{ bars: tSetHistoryData[], tf: TF }|undefined>;// = (InfoForLoad: tInfoForLoad | tInfoForLoadHistory) => Promise<{ bars: tSetHistoryData[], tf: TF }|undefined>;
export type tSetData =
    {
        data: tTick[];
    }
export type tSetTicks =
    {
        ticks: tTick[],
        history?: CQuotesHistory,
        bars?: IBars
    }

export type tSetTicksMulti =
    {
        ticks: tTick[],
        history: CQuotesHistory,
        bars?: IBars
        symbolKey?: string
    }

export type tSetBars =
    {
        tf: TF
        bars: CBar[]
    }
export type tSetHistoryD = {
    tf: TF
    data: tSetHistoryData[];
}


// export type tCallbackForRefreshSymbol = {history:CQuotesHistoryMutable, link:CRBaseMapAll2}

export type tSocketInput = tSetTicks //= tSetTicks | tSetBars | tSetHistoryD
export type tCallbackSocket = (data: tSetTicks) => void //= (data: tSetTicks | tSetBars | tSetHistoryD) => void
export type tCallbackSocketAll = (mas:{data: tSetTicks, info?: Partial<tSymbolInfo>, name:string}[]) => void //tCallbackSocketAll = (mas:{data: tSetTicks | tSetBars | tSetHistoryD, name:string}[]) => void
export type tCallbackSocket2 = (data: tSetTicks) => void
export type tSocket = (SymbolInfo: tSymbolLoadInfo, callback: tCallbackSocket, disable: () => boolean, statusOff: () => void) => void;
export type tSocketAll = (callback: tCallbackSocketAll, disable: () => boolean, statusOff: () => void) => void;
export type tSocketKlineAll = (callback: (data:{data: Partial<tUpDateAllKline>, name:string})=>void, disable: () => boolean, statusOff: () => void, data: {names: string[]}) => void;

export type tSymbolInfoBase = Readonly<{
    name:string,
    tickSize?:number,
    minPrice?:number,
    minStepLot?:number, //minQty stepSize
    minQty?:number,
    stepSize?:number,
    quoteAsset: string,
    baseAsset: string,
}>
export type tSymbolInfo = tSymbolInfoBase & Readonly<{
    height24?: number,  // rolling
    open24?: number,  // rolling
    low24?: number,  // rolling
    close24?: number,  // rolling
    volumeBase24?: number, // base is the left side   // rolling
    volume24?: number,  // rolling
}>;

export type tGetSymbol = {name:string} & tSymbolInfo
export type tGetAllData = {symbols: tGetSymbol[]}
export type tGetAll = () => Promise<tGetAllData|undefined>;
export type tUpDateAllKline = {
    t: number,      // Kline start time
    T: number,      // Kline close time
    s: string,      // Symbol
    i: TF,          // Interval
    f: number,      // First trade ID
    L: number,      // Last trade ID
    o: number,      // "0.0010",  // Open price
    c: number,      // "0.0020",  // Close price
    h: number,      // "0.0025",  // High price
    l: number,      // "0.0015",  // Low price
    v: number,      // "1000",    // Base asset volume
    n: number,      // Number of trades
    x: boolean,     // Is this kline closed?
    q: number,      // "1.0000",  // Quote asset volume
    V: number,      // "500",     // Taker buy base asset volume
    Q: number,      // "0.500",   // Taker buy quote asset volume
}
export type tSet = {
    loadHistory?: tLoad | undefined,
    socket?: tSocket | undefined,
    allInit?: tGetAll | undefined ,
    socketAll?:tSocketAll
    upDateAllKline?:tSocketKlineAll
};
export type tAddressSymbol = readonly string[];


export interface iLinkMini {
    name?: string;

    getAddress(): tAddressSymbol;
}

// type - type of loading from left or right
export type tLoadBar = "left" | "right"|"Nan"

interface iTypeHistory2<K, V> extends iLinkMini {
    // loading quotes, need to pass key of class from where we ask for these new quotes, so repeated identical keys don't create new feedback
    loadHistory(  tf: TF, time1: Date | number, time2?: Date, right?:boolean): Promise<{ link: iLinkMini, type: tLoadBar } | undefined>;

    socket(callback: tCallbackSocket, node: iListNodeMini | undefined): iListNodeMini

    nameType?: string;

    getNameElement(): K | undefined;

    Address(): tAddressSymbol | null;

    // set function for streaming quotes
    setFunkSocket(socket: tSocket): void;

    // set function for loading quotes
    setFunkLoadHistory(load: tLoad): void;

    setFunkNames(all:tGetAll): void;

    // reference to storage of the history itself
    history?: CQuotesHistoryMutable; // the history itself

    // is there a socket through which quotes come at this moment for this symbol
    _socketStatus:boolean;

    add(key: K): iMega<K, V>

    addByAddress(address: K[]): V;
    getByAddress(address: K[]): V|undefined;
}

export interface iMega<K, V> extends Map<K, V>, iTypeHistory2<K, V> {
    par?: this;

    allInit(): Promise<V | undefined>;

    add(key: K): iMega<K, V>

    setByAddress(address: K[]): V;
    addByAddress(address: K[]): V;
    getByAddress(address: K[]): V|undefined;

    setSetting(data: tSet): this;
}
