import { TF } from "../Common/Time";
import { CBar } from "./Bars";
type RequestInfo = any;
type RequestInit = any;
type Response = any;
export type tSymbol = string;
export type tExchange = string;
export type tTF = TF;
export type tSymbolLoadInfo = {
    readonly symbol: tSymbol;
    readonly exchangeName?: tExchange;
    readonly tf: tTF;
};
export type tInfoForLoadHistory = tSymbolLoadInfo & {
    time1: Date;
    time2: Date;
    right?: boolean;
};
type tFetch3 = (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>;
export type tFuncLoad<maxLoadBarType extends (number | Date), IntervalNameT extends (number | string)> = {
    fetch: tFetch3;
    baseURL: string;
    symbol: string;
    interval: IntervalNameT;
    intervalTF: TF;
    startTime: Date;
    endTime?: Date;
    limit?: maxLoadBarType;
    maxLoadBars: maxLoadBarType;
    waitLimit: (weight?: number) => Promise<void>;
};
export type tLoadFist<IntervalNameT extends (number | string)> = {
    fetch: tFetch3;
    baseURL: string;
    symbol: string;
    interval: IntervalNameT;
    intervalTF: TF;
    waitLimit: (weight?: number) => Promise<void>;
};
export type tSetHistoryData = CBar & {
    tf?: TF;
};
type tBinanceLoadBase<Bar extends {
    time?: number;
} | {
    time?: Date;
} | object, maxLoadBarType extends (number | Date), IntervalNameT extends (number | string)> = {
    base: string;
    maxLoadBars: maxLoadBarType;
    maxLoadBars2?: maxLoadBarType;
    countConnect: number;
    time?: number;
    funcLoad: (data: tFuncLoad<maxLoadBarType, IntervalNameT>) => Promise<Bar[]>;
    funcFistTime: (data: tLoadFist<IntervalNameT>) => Promise<Date>;
    intervalToName: {
        time: TF;
        name: IntervalNameT;
    }[];
    nameKey?: string;
    controlTimeToNumber?: (bar: Bar) => number;
};
export declare function LoadQuoteBase<Bar extends object, T extends (number | Date), T2 extends (number | string)>(setting: tBinanceLoadBase<Bar, T, T2> & {
    maxLoadBars: T;
}, data?: {
    fetch?: tFetch3;
    error?: boolean;
}): (info: tInfoForLoadHistory) => Promise<Bar[]>;
export {};
