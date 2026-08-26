import { Immutable, KeysWithoutType, Mutable, MutableFull, ReadonlyFull } from "./BaseTypes";
export declare function GetEnumKeys<TT extends {
    [key: string]: any;
}>(T: TT): readonly (keyof typeof T)[];
type const_Date = Omit<Date, "setTime" | "setFullYear" | "setMonth" | "setDate" | "setHours" | "setMinutes" | "setSeconds" | "setMilliseconds" | "setUTCFullYear" | "setUTCMonth" | "setUTCDate" | "setUTCHours" | "setUTCMinutes" | "setUTCSeconds" | "setUTCMilliseconds">;
export declare function isDate<T>(value: T & (Extract<T, const_Date> extends never ? never : T)): value is Extract<typeof value, const_Date>;
export { Mutable };
export declare function shallowClone<T>(val: T): Mutable<T>;
export declare function _deepClone<T>(src: T, map?: Map<object, object>): T;
export declare function deepClone<T>(object: T): T;
export declare const clone: typeof deepClone;
export declare function deepCloneMutable<T>(value: T): MutableFull<T>;
export declare function deepCloneObject<T extends object>(object: T): T;
export declare function deepCloneObjectMutable<T extends object>(object: T): MutableFull<T>;
export declare function toImmutable<T extends object>(object: T): Immutable<T>;
export declare function readonlyFull<T>(arg: T): ReadonlyFull<T>;
export declare function deepEqual(object1: any, object2: any): boolean;
export declare const isEqual: typeof deepEqual;
export declare function shallowEqual<T extends {
    [key: string]: unknown;
} | undefined>(object1: T, object2: T): boolean;
export declare function arrayShallowEqual<T extends unknown>(arr1: readonly T[], arr2: readonly T[]): boolean;
export declare function sleepAsync(msec?: number): Promise<unknown>;
export declare class CBase {
    readonly [key: number]: void;
}
export declare enum E_SORTMODE {
    DESCEND = 0,
    ASCEND = 1
}
export declare enum E_MATCH {
    LESS_OR_EQUAL = -1,
    EQUAL = 0,
    GREAT_OR_EQUAL = 1
}
export type SearchMatchMode = E_MATCH | "lessOrEqual" | "equal" | "greatOrEqual";
export type SortMode = E_SORTMODE | "ascend" | "descend";
export declare function BSearch<T extends {
    valueOf(): number;
}>(array: ArrayLike<T>, value: T, match?: SearchMatchMode, mode?: SortMode): number;
export declare namespace BSearch {
    var EQUAL: E_MATCH;
    var LESS_OR_EQUAL: E_MATCH;
    var GREAT_OR_EQUAL: E_MATCH;
}
export declare function BSearch<T, T2>(array: ArrayLike<T>, value: T2, comparer: (a: T, b: T2) => number, match?: SearchMatchMode, mode?: SortMode): number;
export declare function BSearch<T>(array: ArrayLike<T>, compareElement: (item: T) => number, match?: SearchMatchMode, mode?: SortMode): number;
export declare const BSearchAsync: typeof ___BSearchAsync;
export declare function BSearchDefault<T extends {
    valueOf(): number;
}>(array: ArrayLike<T>, value: T, match?: SearchMatchMode, mode?: SortMode): number;
declare function ___BSearchAsync(length: number, compareIndexToValue: (index: number) => Promise<number>, matchMode?: SearchMatchMode, sortMode?: SortMode): Promise<number>;
export declare function BSearchIndex(length: number, compareIndex: (index: number) => number, matchMode?: SearchMatchMode, sortMode?: SortMode): number;
export declare function BSearchValueInRange(from: number, to: number, precision: number, compare: (val: number) => number, matchMode: SearchMatchMode): number | null;
export declare function BSearchNearest(array: ArrayLike<number>, searchValue: number, maxDelta?: number): number;
export declare function BSearchNearest<T>(array: ArrayLike<T>, searchValue: number, arrayGetValue: (element: T) => number, maxDelta?: number): number;
export declare function _BSearchNearest<T>(array: ArrayLike<T>, searchValue: number, arrayGetValue: (element: T) => number, maxDelta?: number): number;
export declare function NormalizeDouble(value: number, digits: number): number;
export declare function round(value: number, digits?: number): number;
export declare function MaxCommonDivisor(a: number, b: number, digits?: number): number;
export declare function MaxCommonDivisorOnArray(values: Iterable<number>, precisDigits?: number): number;
export declare function gcd(a: number, b: number, digits?: number): number;
export declare function gcd(values: Iterable<number>, digits?: number): number;
export declare function GetDblPrecision2(value: number, mindigits: number, maxdigits: number): number;
export declare function GetDblPrecision(value: number, maxdigits?: number): number;
export declare function decimals(value: number, maxDigits?: number, minDigits?: number): number;
export declare function DblToStrAuto(value: number, maxprecis?: number): string;
export declare const formatAuto: typeof DblToStrAuto;
export declare function NormalizeDoubleAnd(a: number, options?: {
    digitsPoint?: number;
    digitsR?: number;
    type?: "max" | "min";
}): number;
export declare const roundSig: typeof NormalizeDoubleAnd;
export declare function DblToStrAnd(a: number, options?: {
    digitsPoint?: number;
    digitsR?: number;
    type?: "max" | "min";
}): string;
export declare const formatSig: typeof DblToStrAnd;
export declare function ArrayItemHandler<T extends {
    [key: number]: any;
}>(getter: (target: T, i: number) => T[number], setter?: (target: T, i: number, value: T[number]) => void): ProxyHandler<T>;
export declare function CreateArrayProxy<T extends {
    [key: number]: any;
}>(target: T, getter: (i: number) => T[number], setter?: (i: number, value: T[number]) => void): T;
export declare function CreateArrayProxy<T extends {
    [key: number]: any;
}, T2 extends {
    [key: number]: T[number];
}>(target: T, srcArray: T2): T;
declare class __NumMap<T> {
    [nkey: number]: T;
    keys(): Generator<number, void, unknown>;
    values(): Generator<T, void, unknown>;
    entries(): Generator<readonly [number, T], void, unknown>;
    clone(): __NumMap<unknown> & this;
    clear(): void;
}
export declare class __MyMap<K extends {
    valueOf(): number;
}, V> {
    protected map: __NumMap<{
        key: K;
        value: V;
    }>;
    protected keys?: readonly K[] | null;
    protected values?: readonly V[] | null;
    protected createArrays(): void;
    protected OnModify?(key: K): void;
    Set(key: K, value: V): void;
    Get(key: K): V | undefined;
    Contains(key: K): boolean;
    TryAdd(key: K, value: V): boolean;
    Add(key: K, value: V): void;
    Remove(key: K): void;
    Clear(): void;
    Count(): number;
    get sortedKeys(): readonly K[];
    get Values(): readonly V[];
    assign(other: __MyMap<K, V>): void;
    set(key: K, value: V): void;
    get(key: K): V | undefined;
    has(key: K): boolean;
    delete(key: K): void;
    clear(): void;
    get size(): number;
}
export declare class MyMap<K extends {
    valueOf(): number;
}, V> extends __MyMap<K, V> {
    readonly [key: number]: void;
    Clone(): MyMap<K, V>;
    clone(): MyMap<K, V>;
}
export declare class MyNumMap<VAL> extends __MyMap<number, VAL> {
    [key: number]: VAL | undefined;
    constructor();
    Clone(): MyNumMap<VAL>;
    clone(): MyNumMap<VAL>;
}
export declare class StructMap<TKey extends (Required<TKey> & {
    [key: string]: number | string;
}) | {
    [key: number]: number | string;
}, TResult> {
    private _data;
    private _keys;
    private _values;
    [Symbol.iterator](): Generator<(TKey | TResult)[], void, unknown>;
    set(key: TKey, value: TResult): void;
    get(key: TKey): TResult | undefined;
    has(key: TKey): boolean;
    keys(): TKey[];
    values(): TResult[];
    entries(): Generator<(TKey | TResult)[], void, unknown>;
}
export declare class StructSet<TKey extends (Required<TKey> & {
    [key: string]: number | string;
}) | {
    [key: number]: number | string;
}> {
    private data;
    [Symbol.iterator](): TKey[];
    add(key: TKey): void;
    has(key: TKey): boolean;
    keys(): TKey[];
    values(): TKey[];
}
export declare class ArrayMap<TKey extends number | string, TVal> extends StructMap<readonly TKey[], TVal> {
}
export declare class ArraySet<TKey extends number | string> extends StructSet<readonly TKey[]> {
}
export interface IItems<T> extends ArrayLike<T> {
    readonly [i: number]: T;
    readonly length: number;
    [Symbol.iterator](): Iterator<T>;
}
export declare class VirtualItems<T> implements IItems<T> {
    private getLength;
    readonly getValue: (i: number) => T;
    get length(): number;
    readonly [i: number]: T;
    [Symbol.iterator](): Generator<T, void, unknown>;
    constructor(itemGetter: (i: number) => T, lengthGetter: () => number);
}
type ParsedUrlQueryInputObj<T> = T extends never | never[] ? never : {
    readonly [key in KeysWithoutType<T, Function>]: ParsedUrlQueryInputMy<T[key]>;
};
type ParsedUrlQueryInputArr<T extends any[]> = T extends never ? never : ParsedUrlQueryInputMy<T[0]>[];
export type ParsedUrlQueryInputMy<T = any> = Extract<T, number | string | boolean | null | undefined | readonly (number | string | boolean | null | undefined)[]> | (T extends const_Date ? string : T extends const_Date[] ? readonly string[] : never) | ParsedUrlQueryInputArr<Extract<Exclude<T, readonly const_Date[]>, object[]>> | ParsedUrlQueryInputObj<Extract<Exclude<T, const_Date | readonly any[]>, object>>;
export interface JSON {
    stringify(obj?: ParsedUrlQueryInputMy): string;
    parse<T = any>(str: string): ParsedUrlQueryInputMy<T>;
}
export declare function JSON_clone<T>(obj: T): ParsedUrlQueryInputMy<T>;
export interface ICancelToken {
    isCancelled(): boolean;
}
export declare class CancelToken implements ICancelToken {
    private _cancel;
    isCancelled(): boolean;
    cancel(): void;
    get aborted(): boolean;
    abort(): void;
}
export declare class CancelablePromise<T> extends Promise<T> {
    private readonly _reject?;
    private readonly _onCancel?;
    constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void, onCancel?: () => void);
    cancel(msg?: string): void;
    static resolve(): CancelablePromise<void>;
    static resolve<T>(value: T | PromiseLike<T>): CancelablePromise<T>;
}
export declare function createCancellableTimer(interval_ms: number, onTimer: () => boolean | void, onStop?: () => void): CancelablePromise<never>;
export declare function createCancellableTaskWrapper<T>(task: Promise<T>, isStopped: () => boolean, interval_ms?: number): Promise<"stopped" | T>;
export declare class MyTimerInterval {
    private _timer;
    private _onstop;
    constructor(period_ms: number, onTimer: () => void, onStop?: () => void);
    stop(): void;
}
export declare class Mutex {
    private mutex;
    lock(): PromiseLike<() => void>;
    dispatch<T>(fn: () => T | PromiseLike<T>): Promise<T>;
    runExclusive<T>(fn: () => T | PromiseLike<T>): Promise<T>;
    static createLock(): PromiseLike<() => void>;
}
export declare function copyToClipboard(textToCopy: string): Promise<any>;
export type ObjectID<TObject, TOwner> = {
    readonly value: number;
    readonly [Symbol.species]: ObjectID<TObject, TOwner>;
};
export declare class CObjectID<TObject, TOwner> implements ObjectID<TObject, TOwner> {
    #private;
    readonly value: number;
    readonly [Symbol.species]: ObjectID<TObject, TOwner>;
    readonly toString: () => string;
    readonly toJSON: () => string;
    constructor(object: TObject, owner: TOwner);
    static getInfo<TObject, TOwner>(id: ObjectID<TObject, TOwner>): {
        object: TObject;
        owner: TOwner;
    };
    static getObjectByOwner<TObject, TOwner>(id: ObjectID<TObject, TOwner>, owner: TOwner): TObject | undefined;
}
export declare class MapExt<K, V> extends Map<K, V> {
    private immutArray?;
    set(key: K, value: V): this;
    delete(key: K): boolean;
    clear(): void;
    valuesArrayImmutable(): readonly V[];
    getOrSetFunc(key: K, val: () => V): V;
    getOrSet(key: K, val: V): V;
}
export declare class WeakMapExt<K extends object, V> extends WeakMap<K, V> {
    getOrSetFunc(key: K, val: () => V): V;
    getOrSet(key: K, val: V): V;
}
export declare class CCachedValueT<TKey extends [any, ...any], TVal> {
    private key?;
    private val?;
    private size;
    constructor(size: number);
    getOrSet(key: TKey, valFunc: () => TVal): TVal;
}
export declare class CCachedValue2<TKey extends [any, any], TVal> extends CCachedValueT<TKey, TVal> {
    constructor();
}
export declare function isObjectCastableTo<T extends object>(object: {}, members: readonly (keyof T)[]): object is T;
