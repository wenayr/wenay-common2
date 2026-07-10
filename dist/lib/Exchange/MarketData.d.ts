import { CBar, CBarsMutableBase, const_Date, IBars, IBarsImmutable, ITick, TF } from "./Bars";
import { MyNumMap, ParsedUrlQueryInputMy } from "../Common/core/common";
export * from "./Bars";
declare class CBarsInternal extends CBarsMutableBase {
    set data(bars: CBar[]);
    get data(): CBar[];
    set tickSize(value: number);
    get tickSize(): number;
    Mutable: boolean;
    constructor(tf: TF, bars?: readonly CBar[], tickSize?: number);
    static newFrom(other: IBars): CBarsInternal;
}
type TBarsInfo = {
    bars: IBars;
    modifyInfo?: {
        id: number;
        time: const_Date;
        srcTf: TF;
    };
};
export declare class CQuotesHistory {
    protected _modifyCounter: number;
    readonly [key: number]: void;
    protected barsMainMap: MyNumMap<IBars>;
    protected barsInfoMap: MyNumMap<TBarsInfo>;
    protected _ticksize?: number;
    protected _minTf?: TF | null;
    protected _GetTickSize(): number;
    readonly name?: string;
    static fromParsedJSON(data: ParsedUrlQueryInputMy): CQuotesHistory;
    get stateID(): number;
    get minTf(): TF | null;
    get minTfBars(): IBarsImmutable | null;
    minTfForTime(time: const_Date): TF | null;
    minTfBarsForTime(time: const_Date): IBars | null;
    get tickSize(): number;
    get mainDatas(): readonly IBars[];
    get isMutable(): boolean;
    constructor(Datas: readonly IBars[] | IBars, name?: string);
    protected _OnModify(tf: TF, startTime: const_Date, endTime: const_Date, toEnd: boolean): void;
    protected _CombineBars(myBars: IBars, newBars: readonly CBar[] | CBar, startTime: const_Date, endtime?: const_Date): IBars;
    protected _CreateUpdatedBars(myBars: IBars, updatedBars: IBars, startTime: const_Date): IBars;
    private _getLessTf;
    protected _BuildNewBars(tf: TF): CBarsInternal | null;
    private _Bars;
    protected _GetBars(tf: TF): IBars | null;
    Bars(tf: TF): IBarsImmutable | null;
    get(tf: TF): IBarsImmutable | null;
}
export declare class CQuotesHistoryMutable extends CQuotesHistory {
    private _endTickTime?;
    get isMutable(): boolean;
    constructor(name?: string);
    AddEndBars(bars: IBars): boolean;
    AddEndBars(bars: readonly CBar[] | CBar, tf: TF): boolean;
    append(bars: IBars): boolean;
    append(bars: readonly CBar[] | CBar, tf: TF): boolean;
    AddStartBars(bars: IBars): boolean;
    AddStartBars(bars: readonly CBar[] | CBar, tf: TF): boolean;
    prepend(bars: IBars): boolean;
    prepend(bars: readonly CBar[] | CBar, tf: TF): boolean;
    private checkBars;
    protected _AddBarsExt(Bars: readonly CBar[] | CBar | IBars, tf: TF | undefined, toEnd: boolean): boolean;
    AddTicks(ticks: readonly ITick[]): boolean;
    AddTick(tick: ITick): boolean;
    addTicks(ticks: readonly ITick[]): boolean;
    private getOrSetMutableBars;
    AddNewTicks(ticks: readonly ITick[]): void;
    AddNewTick(tick: ITick): void;
    deleteBefore(time: const_Date): void;
}
export declare class CQuotesHistoryMutable2 extends CQuotesHistory {
    private _source?;
    private _time?;
    private _sourceCounter;
    get tickSize(): number;
    get minTf(): TF | null;
    get isMutable(): boolean;
    constructor(name: string);
    protected _CreateNewBars(tf: TF): CBarsInternal | null;
    Update(other: CQuotesHistory, endTime?: const_Date): void;
}
