export type Immutable<T> = ReadonlyFull<T> & {
    readonly Mutable: false;
};
export type ReadonlyFull<T> = T extends ((...args: any) => any) ? T : T extends number | string | boolean | symbol ? T : T extends const_Date ? const_Date : {
    readonly [P in keyof T]: ReadonlyFull<T[P]>;
};
export type MutableFull<T> = T extends ((...args: any) => any) ? T : T extends number | string | boolean | symbol ? T : T extends const_Date ? const_Date : {
    -readonly [P in keyof T]: MutableFull<T[P]>;
};
export type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};
export type const_Date = Omit<Date, "setTime" | "setFullYear" | "setMonth" | "setDate" | "setHours" | "setMinutes" | "setSeconds" | "setMilliseconds" | "setUTCFullYear" | "setUTCMonth" | "setUTCDate" | "setUTCHours" | "setUTCMinutes" | "setUTCSeconds" | "setUTCMilliseconds">;
export interface DateConstructor {
    new (value: number | string | Date | const_Date): Date;
}
export declare var Date: DateConstructor;
export interface ArrayConstructor {
    isArray<T>(a: unknown): a is readonly unknown[];
    isArray<T>(a: readonly T[]): a is readonly T[];
    isArray<T>(a: T[]): a is T[];
}
export type ReplaceKeyType<Struct extends object, Key extends keyof Struct, NewType> = {
    [key in keyof Struct]: key extends Key ? NewType : Struct[key];
};
export type KeysByTypeUnchecked<T, PickT> = {
    [key in keyof T]: T[key] extends PickT ? key : never;
}[keyof T];
export type KeysByType<T, PickT extends T[keyof T]> = {
    [key in keyof T]: T[key] extends PickT ? key : never;
}[keyof T];
export type KeysWithoutType<T, ExcludeT> = {
    [key in keyof T]: T[key] extends ExcludeT ? never : key;
}[keyof T];
export type OmitTypes<T, ExcludeT> = Pick<T, KeysWithoutType<T, ExcludeT>>;
export type PickTypes<T, PickT extends T[keyof T]> = Pick<T, KeysByType<T, PickT>>;
export type PickTypesUnchecked<T, PickT> = Pick<T, KeysByTypeUnchecked<T, PickT>>;
export type RequiredExcept<T, E extends keyof T> = Required<Omit<T, E>> & Pick<T, E>;
