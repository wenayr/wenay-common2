export type ObjectKeyPath<TObject extends object = object, TValue = unknown> = readonly string[];
export declare function objectSetValueByPath<TObj extends {
    [key: string]: any;
}, TVal>(obj: TObj, path: ObjectKeyPath<TObj, TVal>, value: TVal): void;
export declare const objectSet: typeof objectSetValueByPath;
export declare function objectGetValueByPath<TObj extends {
    readonly [key: string]: any;
}, TVal>(object: TObj, path: ObjectKeyPath<TObj, TVal>): TVal;
export declare const objectGet: typeof objectGetValueByPath;
export declare function objectDeleteValueByPath<TObj extends {
    readonly [key: string]: any;
}, TVal>(object: TObj, path: ObjectKeyPath<TObj, TVal>): boolean;
export declare const objectUnset: typeof objectDeleteValueByPath;
export declare function iterateDeepObjectEntries<TObj extends object>(obj: TObj, filter?: (key: string, value: unknown, path: ObjectKeyPath<TObj>) => boolean, currentPath?: ObjectKeyPath<TObj>): Generator<[key: string, value: unknown, path: ObjectKeyPath<TObj>]>;
export declare const deepEntries: typeof iterateDeepObjectEntries;
