import { const_Date, ReadonlyFull } from "../Common/core/BaseTypes";
type Year = number;
type Month = number;
type Day = number;
type Hour = number;
type Minute = number;
export type DateTimeStr = `${Year}-${Month}-${Day} ${Hour}:${Minute}`;
type DateTime = DateTimeStr | const_Date;
export type RangeT<TVal, TStep = TVal> = {
    min: TVal;
    max: TVal;
    step: TStep;
};
export type RangeExtT<TVal, TStep> = RangeT<TVal, TStep> & {
    defaultMin: TVal;
    defaultMax: TVal;
    defaultStep: TStep;
};
export interface NumRange<T extends number = number> extends RangeT<T> {
    min: T;
    max: T;
    step: T;
}
export type NumRangeExt<T extends number> = RangeExtT<T, T>;
export type UserRangeT<TVal, TStep> = Partial<RangeExtT<TVal, TStep>> & ({
    min: TVal;
} | {
    defaultMin: TVal;
}) & ({
    max: TVal;
} | {
    defaultMax: TVal;
}) & ({
    step: TStep;
} | {
    defaultStep: TStep;
});
export type UserNumRange<T extends number = number> = UserRangeT<T, T>;
export type UserTimeRange = Partial<UserRangeT<DateTime, number>>;
type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};
type ParamType = "number" | "string" | "boolean" | "time" | "symbol";
export type AnyEnumVal = number | string | const_Date | object;
interface IParamBase0 {
    name?: string;
    commentary?: string[];
    range?: (number | string | DateTime | object)[] | UserNumRange | UserTimeRange | undefined;
    progressive?: boolean | undefined;
    enabled?: boolean | undefined;
    hidden?: boolean;
    type?: ParamType | undefined;
}
interface IParamBase1<T = never> {
    value: string | number | boolean | DateTime | IParams | T | (number | string | boolean | DateTime | IParams | T)[];
    constLength?: boolean | undefined;
    elementsEnabled?: boolean | undefined | (boolean[]);
}
export interface IParamBase extends IParamBase0, IParamBase1 {
}
export type IParamBaseReadonly = ReadonlyFull<IParamBase>;
interface IParamVal<T extends string | number | boolean | DateTime | IParams | object> extends IParamBase1<T> {
    value: T;
    constLength?: undefined;
    elementsEnabled?: undefined;
}
type ParamVal<TParam extends IParamBase0, T extends string | number | boolean | DateTime | IParams> = TParam & IParamVal<T>;
interface IParamArr<T extends string | number | boolean | DateTime | IParams> extends IParamBase1<T> {
    value: T[];
    constLength?: boolean;
    elementsEnabled?: boolean | (boolean[]);
}
type ParamArr<TParam extends IParamBase0, T extends string | number | boolean | DateTime | IParams> = TParam & IParamArr<T>;
interface IParamBaseDefault extends IParamBase0 {
    progressive?: undefined;
}
interface IParamNumBase<T extends number> extends IParamBase0 {
    range: UserNumRange<T>;
    progressive?: boolean;
    type?: "number" | undefined;
}
export type IParamNum<T extends number = number> = ParamVal<IParamNumBase<T>, T>;
export type IParamNumArr<T extends number = number> = ParamArr<IParamNumBase<T>, T>;
export type ParamNum<T extends number = number> = IParamNum<T> | IParamNumArr<T>;
interface _IParamEnumBase<T extends AnyEnumVal> extends IParamBaseDefault {
    range: T[];
    labels?: string[] | undefined;
    valueToString?: {
        (value: T): string;
    } | undefined;
}
interface IParamEnumBaseAny1<T extends AnyEnumVal> extends _IParamEnumBase<T> {
    labels: string[];
    valueToString?: undefined;
}
interface IParamEnumBaseAny2<T extends AnyEnumVal> extends _IParamEnumBase<T> {
    valueToString(value: T): string;
    labels?: undefined;
}
type IParamEnumBaseAny<T extends AnyEnumVal> = IParamEnumBaseAny1<T> | IParamEnumBaseAny2<T>;
interface IParamEnumBase<T extends number | string | DateTime> extends _IParamEnumBase<T> {
    labels?: string[];
    type?: T extends number ? "number" : "string";
    valueToString?: undefined;
}
export interface IParamEnum<T extends number | string | DateTime = number | string | DateTime> extends ParamVal<IParamEnumBase<T>, T> {
}
export interface IParamEnum<T extends number | string | DateTime = number | string | DateTime> extends ParamVal<IParamEnumBase<T>, T> {
}
export type IParamEnumReadonly<T extends number | string | DateTime = number | string | DateTime> = ReadonlyFull<IParamEnum<T>>;
export type IParamEnumAny<T extends AnyEnumVal = AnyEnumVal> = (T extends number | string | DateTime ? IParamEnumReadonly<T> : IParamEnumBaseAny<T>) & IParamVal<T>;
export interface IParamEnumArr<T extends number | string | DateTime = number | string | DateTime> extends ParamArr<IParamEnumBase<T>, T> {
}
export type ParamEnum<T extends number | string | DateTime = number | string | DateTime> = (IParamEnum<T> | IParamEnumArr<T>);
export type ParamEnumReadonly<T extends number | string | DateTime> = ReadonlyFull<ParamEnum<T>>;
interface IParamTimeBase1 extends IParamBaseDefault {
    range?: DateTimeStr[] | UserTimeRange;
    type: "time";
}
interface IParamTimeBase2 extends IParamBaseDefault {
    range?: const_Date[] | UserTimeRange;
    type?: "time";
}
export interface IParamTime1 extends ParamVal<IParamTimeBase1, DateTimeStr> {
}
export interface IParamTime2 extends ParamVal<IParamTimeBase2, const_Date> {
}
export interface IParamTime1 extends ParamVal<IParamTimeBase1, DateTimeStr> {
}
export interface IParamTimeArr1 extends ParamArr<IParamTimeBase1, DateTimeStr> {
}
export interface IParamTimeArr2 extends ParamArr<IParamTimeBase2, const_Date> {
}
export interface IParamTimeArr2 extends ParamArr<IParamTimeBase2, const_Date> {
}
export type ParamTime = IParamTime1 | IParamTime2 | IParamTimeArr1 | IParamTimeArr2;
export interface IParamEnum2<T extends number | string> extends IParamBaseDefault {
    value: T | T[];
    range: [T, ...T[]];
    enabled?: undefined;
}
interface IParamStringBase extends IParamBaseDefault {
    range?: undefined;
    type?: "string" | "symbol";
}
interface IParamString extends ParamVal<IParamStringBase, string> {
}
interface IParamStringArr extends ParamArr<IParamStringBase, string> {
}
export type ParamString = (IParamString | IParamStringArr);
interface IParamBoolBase extends IParamBaseDefault {
    range?: undefined;
    enabled?: undefined;
    type?: "boolean";
}
export interface IParamBoolean extends ParamVal<IParamBoolBase, boolean> {
}
export interface IParamBooleanArr extends ParamArr<IParamBoolBase, boolean> {
    constLength?: true;
}
export type ParamBoolean = (IParamBoolean | IParamBooleanArr);
export interface IParamGroup extends IParamBaseDefault, IParamBase1 {
    value: IParams;
    range?: undefined;
    enabled?: boolean;
    type?: undefined;
    constLength?: undefined;
    elementsEnabled?: undefined;
}
export type ParamBase<T extends "time" | number | string | boolean | object = "time" | number | string | boolean | object> = T extends "time" ? ParamTime : T extends string ? ParamEnum<T> : T extends number ? ParamNum<T> | ParamEnum<T> : T extends boolean ? ParamBoolean : T extends object ? IParamGroup : never;
export type IParam = ParamTime | ParamNum | ParamEnum<number> | ParamEnum<string> | ParamBoolean | ParamString | boolean | number | string | IParamGroup | (() => any);
export type IParamReadonly = ReadonlyFull<IParam>;
export declare function isParamBase(param: IParam): param is IParam & IParamBase;
export type IParams = {
    [key in string]: IParam;
};
export type IParamsReadonly = {
    readonly [key in string]: IParamReadonly;
};
export declare class CParams implements IParams {
    [key: string]: IParam;
}
export declare class CParamsReadonly implements IParamsReadonly {
    readonly [key: string]: IParamReadonly;
}
export type IParamExpandable = Exclude<IParam, {
    value: any;
}> | (Extract<IParam, {
    value: any;
}> & {
    expanded?: boolean;
});
export type IParamExpandableReadonly = ReadonlyFull<IParamExpandable>;
export type IParamsExpandable = {
    [key: string]: IParamExpandable;
};
export type IParamsExpandableReadonly = ReadonlyFull<IParamsExpandable>;
export declare function isParamGroupOrArray<TParam extends IParamReadonly>(param: TParam): param is Extract<TParam, ReadonlyFull<IParamGroup | IParamArr<any>>>;
export declare function isParamGroup<TParam extends IParamReadonly>(param: TParam): param is Extract<TParam, ReadonlyFull<IParamGroup>>;
export declare function isSimpleParams2<TParams extends IParamsReadonly>(params: TParams | SimpleParams): boolean;
export declare function isSimpleParams<TParams extends IParamsReadonly>(params: TParams | SimpleParams): boolean;
type ObjectKeyPath<TObject extends object = object, TValue = unknown> = readonly string[];
export declare function iterateParams<TObj extends IParamsReadonly, TVal extends IParamReadonly = TObj[string]>(obj: TObj, currentPath?: ObjectKeyPath<TObj, TVal>): Generator<[key: string, value: TVal, path: ObjectKeyPath<TObj, TVal>]>;
export declare function enableAllParams<T extends IParamsReadonly>(params: T, enabled?: boolean): T;
export type SimpleParamsMutable<T> = T extends const_Date ? const_Date : Mutable<{
    [key in keyof T]: (T[key] extends {
        value: IParamsReadonly;
    } ? SimpleParamsMutable<T[key]["value"]> : T[key] extends {
        value: any;
    } ? (T[key] extends {
        value: [];
        elementsEnabled: boolean | [];
    } ? Partial<Mutable<T[key]["value"]>> : Mutable<T[key]["value"]>) : T[key] extends () => infer RES ? RES : Mutable<T[key]>) | (T[key] extends {
        enabled: boolean;
    } ? null : never);
}> & {
    readonly [key: number]: void;
};
export type SimpleParams<T = IParams> = ReadonlyFull<SimpleParamsMutable<T>>;
export declare function GetSimpleParams<T extends ReadonlyFull<IParams>>(params: T): SimpleParamsMutable<T>;
export declare const toValues: typeof GetSimpleParams;
export declare function mergeParamValuesToInfos<TParams extends IParamsReadonly | IParams, TParams2 extends IParamsReadonly | IParams>(srcObj: TParams, valuesObj: SimpleParams<TParams2> | TParams2): TParams;
export declare const fromValues: typeof mergeParamValuesToInfos;
export {};
