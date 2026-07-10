import * as lib from "../Common/core/common";
import { IItems, ParsedUrlQueryInputMy, SearchMatchMode } from "../Common/core/common";
import { TF } from "../Common/Time";
import { ByteStreamR, ByteStreamW, Nullable, NumericTypes } from "../Common/data/ByteStream";
import { const_Date, ReadonlyFull } from "../Common/core/BaseTypes";
export * from "../Common/Time";
export declare class OHLC {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    constructor(open: number, high: number, low: number, close: number);
}
export type IBar = CBarBase;
export declare class CBarBase {
    readonly time: const_Date;
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume: number;
    readonly tickVolume: number;
    constructor(data: CBarBase);
    constructor(time: const_Date, open: number, high: number, low: number, close: number, volume?: number, tickVolume?: number);
}
export declare class CBar extends CBarBase {
    static new(time: const_Date, ohlc: OHLC, volume?: number, tickVolume?: number): CBar;
    static fromParsedJSON(data: ParsedUrlQueryInputMy<CBar>): CBar;
}
export type BarInfo = Readonly<{
    bar: CBar;
    closed: boolean;
    index: number;
    getAllBars: () => IBars;
}>;
export interface ITick {
    readonly time: const_Date;
    readonly price: number;
    readonly volume: number;
}
export declare class CTick implements ITick {
    readonly time: const_Date;
    readonly price: number;
    readonly volume: number;
    constructor(time: const_Date, price: number, volume: number);
}
export declare abstract class IBars implements Iterable<CBar> {
    readonly [key: number]: CBar;
    [Symbol.iterator](): Iterator<CBar>;
    readonly Tf: TF;
    constructor(tf: TF);
    abstract get data(): readonly CBar[];
    abstract readonly Mutable: boolean;
    get Immutable(): boolean;
    toImmutable(): IBarsImmutable;
    get count(): number;
    get length(): number;
    get last(): CBar | undefined;
    backwardBar(i: number): CBar;
    _getBar(i: number, prop: string): CBar;
    at(i: number): CBar | undefined;
    time(i: number): const_Date;
    open(i: number): number;
    high(i: number): number;
    low(i: number): number;
    close(i: number): number;
    volume(i: number): number;
    tickVolume(i: number): number;
    closeTime(i: number): const_Date;
    get firstTime(): const_Date | null;
    get lastTime(): const_Date | null;
    get lastCloseTime(): const_Date | null;
    abstract get tickSize(): number;
    Values<T>(getter: (bar: CBar) => T): lib.VirtualItems<T>;
    get times(): lib.VirtualItems<const_Date>;
    get opens(): lib.VirtualItems<number>;
    get highs(): lib.VirtualItems<number>;
    get lows(): lib.VirtualItems<number>;
    get closes(): lib.VirtualItems<number>;
    get volumes(): lib.VirtualItems<number>;
    entries(): IterableIterator<[number, CBar]>;
    indexOf(time: const_Date, match?: SearchMatchMode): number;
    indexOfLessOrEqual(time: const_Date): number;
    concat(newBars: readonly CBar[] | CBar): CBars | null;
    slice(startIndex: number, stopIndex?: number): CBars;
    sliceMutable(startIndex: number, stopIndex?: number): CBarsMutable;
    sliceByTime(startTime: const_Date | null, lastTime?: const_Date | null): CBars;
    range(timeStart?: const_Date, timeEnd?: const_Date): Generator<CBar, void, unknown>;
    getArray(startTime?: const_Date | null, lastTime?: const_Date | null): CBar[] | null;
    toBars(tf: TF, endDayTime_s?: number): CBarsMutableBase;
    toBarsImmutable(tf: TF, endDayTime_s?: number): IBarsImmutable;
    toBarsArray(dstTf: TF, endDayTime_s?: number): CBar[];
    _getHighestHigh(i0: number, i1: number): number;
    _getLowestLow(i0: number, i1: number): number;
    getBest(comparer: (prevBar: CBar, newBar: CBar) => boolean, iFirst?: number | undefined, iLast?: number | undefined): undefined[] | (number | CBar)[];
    getFirstHighest(iFirst: number | undefined, iLast: number | undefined): undefined[] | (number | CBar)[];
    getFirstLowest(iFirst: number | undefined, iLast: number | undefined): undefined[] | (number | CBar)[];
    getSumVolume(i0: number, i1: number): number;
    getSumTickVolume(i0: number, i1: number): number;
}
export interface IBarsExt extends IBars {
    readonly lastBarClosed: boolean;
    readonly barInfo: (i: number) => BarInfo;
}
export declare abstract class CBarsBase extends IBars {
    protected _data: readonly CBar[];
    protected _ticksize?: number;
    get _tickSize(): number | undefined;
    get data(): readonly CBar[];
    get tickSize(): number;
    protected _Add(bars: readonly CBar[]): void;
    constructor(tf: TF, bars: Iterable<CBar>, tickSize?: number);
    static fromParsedJSON(data: ParsedUrlQueryInputMy<IBars>): CBars;
}
export type IBarsImmutable = IBars & {
    readonly Mutable: false;
};
export declare class CBars extends CBarsBase implements IBarsImmutable {
    constructor(tf: TF, bars: readonly CBar[], tickSize?: number);
    readonly Mutable = false;
    static createCopy(bars: IBars): CBars;
    static createCopyExt(bars: IBars, lastBarClosed: boolean): IBarsExt;
    static createBarInfo(bars: IBarsExt, i: number): BarInfo;
}
export declare abstract class CBarsMutableBase extends CBarsBase {
    private _tickSizeAuto;
    get data(): CBar[];
    constructor(tf: TF, bars?: readonly CBar[], tickSize?: number);
    Add(Bars: readonly CBar[] | CBar): void;
    push(bars: readonly CBar[] | CBar): void;
    updateLast(bar: CBar): void;
    AddTick(tick: ITick): boolean;
    AddTicks(ticks: readonly ITick[]): boolean;
    addTick(tick: ITick): boolean;
    addTicks(ticks: readonly ITick[]): boolean;
}
export declare class CBarsMutable extends CBarsMutableBase {
    readonly Mutable = true;
}
export declare class CBarsMutableExt extends CBarsMutable implements IBarsExt {
    lastBarClosed: boolean;
    readonly barInfo: (i: number) => BarInfo;
}
export declare function CreateRandomBars(tf: TF, startTime: const_Date, endTime: const_Date, startPrice?: number, volatility?: number | `${number}%`, ticksize?: number): CBars;
export declare function CreateRandomBars(tf: TF, startTime: const_Date, barsCount: number, startPrice?: number, volatility?: number | `${number}%`, ticksize?: number): CBars;
export declare const createRandomBars: typeof CreateRandomBars;
export type TimeValue<T> = {
    readonly time: const_Date;
    readonly value: T;
};
export interface ITimeseries<T = number> extends IItems<Readonly<TimeValue<T>>> {
    time(i: number): const_Date;
    value(i: number): T;
    readonly times: IItems<const_Date>;
    readonly values: IItems<T>;
    indexOf(time: const_Date, match?: SearchMatchMode): number;
}
export declare abstract class CTimeSeriesBase<T = number> implements ITimeseries<T> {
    abstract get points(): readonly TimeValue<T>[];
    abstract get name(): string | undefined;
    time(i: number): const_Date;
    value(i: number): T;
    get last(): TimeValue<T> | undefined;
    get times(): IItems<const_Date>;
    get values(): IItems<T>;
    get length(): number;
    indexOf(time: const_Date, match?: SearchMatchMode): number;
    protected constructor();
    [Symbol.iterator](): ArrayIterator<TimeValue<T>>;
    readonly [key: number]: Readonly<TimeValue<T>>;
}
export declare class CTimeSeries<T = number> extends CTimeSeriesBase<T> {
    points: TimeValue<T>[];
    name: string | undefined;
    constructor(name?: string, points?: readonly TimeValue<T>[]);
    static fromParsedJSON<T extends never>(data: ParsedUrlQueryInputMy<CTimeSeries<T>>): CTimeSeries<ParsedUrlQueryInputMy<T>>;
    static fromParsedJSON<T extends null | undefined>(data: T): T;
    write(stream: ByteStreamW, valueWriter: ((stream: ByteStreamW, value: T) => boolean | void)): boolean;
    write(stream: ByteStreamW, valueType: T extends number ? NumericTypes | Nullable<NumericTypes> : never): boolean;
    static read<T extends NumericTypes | Nullable<NumericTypes>>(stream: ByteStreamR, type: T): T extends NumericTypes ? CTimeSeries<number> : CTimeSeries<number | null>;
    static read<T>(stream: ByteStreamR, valueGetter: (stream: ByteStreamR) => T): CTimeSeries<T>;
}
export type CTimeSeriesReadonly<T> = ReadonlyFull<CTimeSeries<T>>;
export declare function findBarsShallow(srcBars: readonly CBar[], barsToFind: readonly CBar[]): number;
