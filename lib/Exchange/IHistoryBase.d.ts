import { const_Date, TF } from "../Common/Time";
import { CBar, IBars } from "./Bars";
import { CQuotesHistory, CQuotesHistoryMutable } from "./MarketData";
import { iListNodeMini } from "../Common/data/ListNodeAnd";
import { tInfoForLoadHistory, tSetHistoryData, tSymbolLoadInfo } from "./LoadBase";
export type tPrice = number;
export type tTick = Readonly<{
    time: const_Date;
    price: tPrice;
    volume: number;
}>;
export type tSetHistory = tSetHistoryData[];
export type tLoad = (InfoForLoad: tInfoForLoadHistory) => Promise<{
    bars: tSetHistoryData[];
    tf: TF;
} | undefined>;
export type tSetData = {
    data: tTick[];
};
export type tSetTicks = {
    ticks: tTick[];
    history?: CQuotesHistory;
    bars?: IBars;
};
export type tSetTicksMulti = {
    ticks: tTick[];
    history: CQuotesHistory;
    bars?: IBars;
    symbolKey?: string;
};
export type tSetBars = {
    tf: TF;
    bars: CBar[];
};
export type tSetHistoryD = {
    tf: TF;
    data: tSetHistoryData[];
};
export type tSocketInput = tSetTicks;
export type tCallbackSocket = (data: tSetTicks) => void;
export type tCallbackSocketAll = (mas: {
    data: tSetTicks;
    info?: Partial<tSymbolInfo>;
    name: string;
}[]) => void;
export type tCallbackSocket2 = (data: tSetTicks) => void;
export type tSocket = (SymbolInfo: tSymbolLoadInfo, callback: tCallbackSocket, disable: () => boolean, statusOff: () => void) => void;
export type tSocketAll = (callback: tCallbackSocketAll, disable: () => boolean, statusOff: () => void) => void;
export type tSocketKlineAll = (callback: (data: {
    data: Partial<tUpDateAllKline>;
    name: string;
}) => void, disable: () => boolean, statusOff: () => void, data: {
    names: string[];
}) => void;
export type tSymbolInfoBase = Readonly<{
    name: string;
    tickSize?: number;
    minPrice?: number;
    minStepLot?: number;
    minQty?: number;
    stepSize?: number;
    quoteAsset: string;
    baseAsset: string;
}>;
export type tSymbolInfo = tSymbolInfoBase & Readonly<{
    height24?: number;
    open24?: number;
    low24?: number;
    close24?: number;
    volumeBase24?: number;
    volume24?: number;
}>;
export type tGetSymbol = {
    name: string;
} & tSymbolInfo;
export type tGetAllData = {
    symbols: tGetSymbol[];
};
export type tGetAll = () => Promise<tGetAllData | undefined>;
export type tUpDateAllKline = {
    t: number;
    T: number;
    s: string;
    i: TF;
    f: number;
    L: number;
    o: number;
    c: number;
    h: number;
    l: number;
    v: number;
    n: number;
    x: boolean;
    q: number;
    V: number;
    Q: number;
};
export type tSet = {
    loadHistory?: tLoad | undefined;
    socket?: tSocket | undefined;
    allInit?: tGetAll | undefined;
    socketAll?: tSocketAll;
    upDateAllKline?: tSocketKlineAll;
};
export type tAddressSymbol = readonly string[];
export interface iLinkMini {
    name?: string;
    getAddress(): tAddressSymbol;
}
export type tLoadBar = "left" | "right" | "Nan";
interface iTypeHistory2<K, V> extends iLinkMini {
    loadHistory(tf: TF, time1: Date | number, time2?: Date, right?: boolean): Promise<{
        link: iLinkMini;
        type: tLoadBar;
    } | undefined>;
    socket(callback: tCallbackSocket, node: iListNodeMini | undefined): iListNodeMini;
    nameType?: string;
    getNameElement(): K | undefined;
    Address(): tAddressSymbol | null;
    setFunkSocket(socket: tSocket): void;
    setFunkLoadHistory(load: tLoad): void;
    setFunkNames(all: tGetAll): void;
    history?: CQuotesHistoryMutable;
    _socketStatus: boolean;
    add(key: K): iMega<K, V>;
    addByAddress(address: K[]): V;
    getByAddress(address: K[]): V | undefined;
}
export interface iMega<K, V> extends Map<K, V>, iTypeHistory2<K, V> {
    par?: this;
    allInit(): Promise<V | undefined>;
    add(key: K): iMega<K, V>;
    setByAddress(address: K[]): V;
    addByAddress(address: K[]): V;
    getByAddress(address: K[]): V | undefined;
    setSetting(data: tSet): this;
}
export {};
