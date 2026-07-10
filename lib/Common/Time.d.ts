import { const_Date } from "./core/BaseTypes";
export type DateString = `${number}-${number}-${number}`;
export type TimeStringHHMM = `${number}:${number}`;
export type TimeStringHHMMSS = `${number}:${number}:${number}`;
export type TimeStringHHMMSS_ms = `${number}:${number}:${number}.${number}`;
type TimeString_ = ` ${TimeStringHHMM | TimeStringHHMMSS | TimeStringHHMMSS_ms}`;
export type DateTimeString = `${DateString}${TimeString_ | ""}${"Z" | ""}`;
export { const_Date };
export declare const H1_S = 3600;
export declare const D1_S: number;
export declare const W1_S: number;
export declare const W1_MS: number;
export declare const D1_MS: number;
export declare const H1_MS: number;
export declare const M1_MS: number;
declare enum __E_TF {
    S1 = 1,
    S2 = 2,
    S3 = 3,
    S4 = 4,
    S5 = 5,
    S6 = 6,
    S10 = 7,
    S12 = 8,
    S15 = 9,
    S20 = 10,
    S30 = 11,
    M1 = 12,
    M2 = 13,
    M3 = 14,
    M4 = 15,
    M5 = 16,
    M6 = 17,
    M10 = 18,
    M12 = 19,
    M15 = 20,
    M20 = 21,
    M30 = 22,
    H1 = 23,
    H2 = 24,
    H3 = 25,
    H4 = 26,
    H6 = 27,
    H8 = 28,
    H12 = 29,
    D1 = 30,
    W1 = 31,
    MN1 = 32,
    MN2 = 33,
    MN3 = 34,
    MN4 = 35,
    MN6 = 36,
    Y1 = 37
}
export interface IPeriod {
    readonly msec: number;
    readonly name: string;
}
type __E_TF_KEY = keyof typeof __E_TF;
export declare class TIME_UNIT {
    readonly index: number;
    readonly msec: number;
    readonly sec: number;
    readonly name: string;
    readonly sign: string;
    private static _lastIndex;
    private constructor();
    static readonly MSecond: TIME_UNIT;
    static readonly Second: TIME_UNIT;
    static readonly Minute: TIME_UNIT;
    static readonly Hour: TIME_UNIT;
    static readonly Day: TIME_UNIT;
    static readonly Week: TIME_UNIT;
    static readonly Month: TIME_UNIT;
    static readonly Year: TIME_UNIT;
    readonly [key: number]: void;
}
declare type Nominal<T, Name extends string> = T & {
    readonly [Symbol.species]: Name;
};
export type TFIndex = Nominal<number, 'TFIndex'>;
export declare class TF implements IPeriod {
    readonly sec: number;
    readonly msec: number;
    readonly name: string;
    readonly unit: TIME_UNIT;
    readonly unitCount: number;
    readonly index: TFIndex;
    readonly [key: number]: void;
    valueOf(): number;
    toString(): string;
    private constructor();
    private static constructFromSec;
    static get<T extends string>(name: T): TF | (T extends __E_TF_KEY ? never : null);
    static getAsserted(name: string): TF;
    static fromName<T extends string>(name: T): TF | (T extends "D1" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S10" | "S12" | "S15" | "S20" | "S30" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M10" | "M12" | "M15" | "M20" | "M30" | "H1" | "H2" | "H3" | "H4" | "H6" | "H8" | "H12" | "W1" | "MN1" | "MN2" | "MN3" | "MN4" | "MN6" | "Y1" ? never : null);
    static fromSec(value: number): TF | null;
    static createCustomFromSec(sec: number): TF;
    static createCustom(unit: TIME_UNIT, unitCount: number): TF;
    static readonly all: readonly TF[];
    private static readonly _mapBySec;
    static readonly S1: TF;
    static readonly S2: TF;
    static readonly S3: TF;
    static readonly S4: TF;
    static readonly S5: TF;
    static readonly S6: TF;
    static readonly S10: TF;
    static readonly S12: TF;
    static readonly S15: TF;
    static readonly S20: TF;
    static readonly S30: TF;
    static readonly M1: TF;
    static readonly M2: TF;
    static readonly M3: TF;
    static readonly M4: TF;
    static readonly M5: TF;
    static readonly M6: TF;
    static readonly M10: TF;
    static readonly M12: TF;
    static readonly M15: TF;
    static readonly M20: TF;
    static readonly M30: TF;
    static readonly H1: TF;
    static readonly H2: TF;
    static readonly H3: TF;
    static readonly H4: TF;
    static readonly H6: TF;
    static readonly H8: TF;
    static readonly H12: TF;
    static readonly D1: TF;
    static readonly W1: TF;
    static readonly MN1: TF;
    static readonly MN2: TF;
    static readonly MN3: TF;
    static readonly MN4: TF;
    static readonly MN6: TF;
    static readonly Y1: TF;
    static min(): never;
    static min(...args: [TF, ...TF[]] | [[TF, ...TF[]]]): TF;
    static min(...args: TF[] | [Iterable<TF>]): TF | null;
    static max(): never;
    static max(...args: [TF, ...TF[]] | [[TF, ...TF[]]]): TF;
    static max(...args: TF[] | [Iterable<TF>]): TF | null;
}
declare class MyDate extends Date {
    ToShiftedMsTime(shiftMs: number): Date;
}
export type MyDate_const = Omit<MyDate, keyof Date> & const_Date;
export declare class PeriodSpan {
    readonly period: Period;
    readonly index: number;
    readonly [key: number]: void;
    constructor(period: Period | TF, indexOrTime: number | const_Date);
    next(): PeriodSpan;
    prev(): PeriodSpan;
    get startTime(): MyDate;
    get endTime(): Date;
}
export declare class Period implements IPeriod {
    readonly tf: TF;
    get sec(): number;
    get msec(): number;
    get name(): string;
    valueOf(): number;
    readonly [key: number]: PeriodSpan;
    span(time: const_Date): PeriodSpan;
    constructor(tf: TF);
    static Seconds(tf: TF): number;
    static Name(tf: TF): string;
    IndexFromTime(time: const_Date): number;
    getStartTime(currentTime: const_Date): MyDate;
    private static getW1Shift_ms;
    static W1Shift_ms: number;
    static year0: number;
    static IndexFromTime(tf: TF, time: const_Date): number;
    static StartTimeForIndex(tf: TF, index: number): MyDate;
    static StartTime(tf: TF, currentTime: const_Date, shiftPeriods?: number): MyDate;
    static EndTime(tf: TF, currentTime: const_Date): Date;
}
export declare function timeToStr_hhmmss_ms(date: const_Date): string;
export declare function timeToStr_hhmmss(date: const_Date): string;
export declare function timeToStr_yyyymmdd_hhmm(date: const_Date, dateDelim?: string): string;
export declare function timeToStr_yyyymmdd_hhmmss(date: const_Date, dateDelim?: string): string;
export declare function timeToStr_yyyymmdd_hhmmss_ms(date: const_Date, dateDelim?: string): string;
export declare function timeLocalToStr_hhmmss(date: const_Date): string;
export declare function timeLocalToStr_hhmmss_ms(date: const_Date): string;
export declare function timeLocalToStr_yyyymmdd(date: const_Date, dateDelim?: string): string;
export declare function timeLocalToStr_yyyymmdd_hhmm(date: const_Date, dateDelim?: string): string;
export declare function timeLocalToStr_yyyymmdd_hhmmss(date: const_Date, dateDelim?: string): string;
export declare function timeLocalToStr_yyyymmdd_hhmmss_ms(date: const_Date, dateDelim?: string): string;
export declare function timeToString_yyyymmdd_hhmm_offset(date: const_Date): string;
export declare function timeToString_yyyymmdd_hhmmss_offset(date: const_Date): string;
export type tTimeFormatPattern = 'HH:mm:ss' | 'HH:mm:ss.SSS' | 'yyyy-MM-dd' | 'yyyy-MM-dd HH:mm' | 'yyyy-MM-dd HH:mm:ss' | 'yyyy-MM-dd HH:mm:ss.SSS' | 'yyyy-MM-dd HH:mm O' | 'yyyy-MM-dd HH:mm:ss O';
export declare function format(date: const_Date, pattern: tTimeFormatPattern, opts?: {
    utc?: boolean;
}): string;
export declare function convertDatesToStrings(arg: any): any;
export declare function toPrintObject(arg: any): any;
export declare function durationToStr(duration_ms: number): string;
export declare function durationToStrNullable(duration_ms: number | null | undefined): string | null;
export declare function durationToStr_h_mm_ss(duration_ms: number): string;
export declare function durationToStr_h_mm_ss_ms(duration_ms: number): string;
export type tDurationFormatPattern = 'H:mm:ss' | 'H:mm:ss.SSS';
export declare function formatDuration(duration_ms: number, pattern?: tDurationFormatPattern): string;
export declare class CDelayer {
    protected remainPause: number;
    sleepAsync(pause_ms_getter: () => number | null): Promise<void>;
}
type NullableTime = const_Date | undefined | null;
export declare function MinTime<T1 extends NullableTime, T2 extends NullableTime>(time1: T1, time2: T2): T1 | NonNullable<T2>;
export declare function MaxTime<T1 extends NullableTime, T2 extends NullableTime>(time1: T1, time2: T2): T1 | NonNullable<T2>;
export declare const minDate: typeof MinTime;
export declare const maxDate: typeof MaxTime;
