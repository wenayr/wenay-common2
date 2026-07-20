
// interface Iterable<T> {
//     [Symbol.iterator](): Iterator<T>;
// }

//type MyReadonly<T> = { readonly [P in keyof T] : T[P] } & (T extends Iterable<infer TT> ? Iterable<TT> : {})

//interface Readonly<T extends Iterable<any>> { [Symbol.iterator](): T extends Iterable<infer TT> ? TT : never }
//
export type Immutable<T> =  ReadonlyFull<T> & { readonly Mutable : false; } //{ [key in keyof T] : T[key] }


export type ReadonlyFull<T> =
    T extends ((...args:any)=>any) ? T :
        T extends number|string|boolean|symbol ? T :
            T extends const_Date ? const_Date :
                { readonly [P in keyof T] : ReadonlyFull<T[P]> };


//type MutableFull<T> = T extends Function ? T : { -readonly [P in keyof T] : MutableFull<T[P]> } //T[P] extends object ? ReadonlyFull<T[P]> : T[P] }

export type MutableFull<T> =
    T extends ((...args:any)=>any) ? T :
        T extends number|string|boolean|symbol ? T :
            T extends const_Date ? const_Date :
                { -readonly [P in keyof T] : MutableFull<T[P]> };

/**
 * Removes "readonly" from all properties
 */
export type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};

//type ReadonlyFull<T> = T extends ((...args:any)=>any) ? T : T extends object ? { readonly [P in keyof T] : ReadonlyFull<T[P]> } : T;


export type const_Date = Omit<Date, "setTime"|"setFullYear"|"setMonth"|"setDate"|"setHours"|"setMinutes"|"setSeconds"|"setMilliseconds"|"setUTCFullYear"|"setUTCMonth"|"setUTCDate"|"setUTCHours"|"setUTCMinutes"|"setUTCSeconds"|"setUTCMilliseconds">;
//type const_Date = Readonly<Omit<Date, "setTime"|"setFullYear"|"setMonth"|"setDate"|"setHours"|"setMinutes"|"setSeconds"|"setMilliseconds"|"setUTCFullYear"|"setUTCMonth"|"setUTCDate"|"setUTCHours"|"setUTCMinutes"|"setUTCSeconds"|"setUTCMilliseconds">>;


export interface DateConstructor {
    new (value: number | string | Date | const_Date): Date;
}

export declare var Date : DateConstructor;

export interface ArrayConstructor {
    isArray<T>(a :unknown) : a is readonly unknown[];
    isArray<T>(a :readonly T[]) : a is readonly T[];
    isArray<T>(a :T[]) : a is T[];
}


// replace field type in structure
export type ReplaceKeyType<Struct extends object, Key extends keyof Struct, NewType> = {[key in keyof Struct] : key extends Key ? NewType : Struct[key]}; //Omit<TObj,Key> & (TObj extends {-readonly [key in Key] :any} ? { [key in Key]: TVal } : { readonly [key in Key]: TVal });



// get only keys (fields) of given type (without checking their presence)
export type KeysByTypeUnchecked<T, PickT> = {
    [key in keyof T]: T[key] extends PickT ? key : never;
}[keyof T];

// get only keys (fields) of given type (with checking their presence)
export type KeysByType<T, PickT extends T[keyof T]> = {
    [key in keyof T]: T[key] extends PickT ? key : never;
}[keyof T];

// get only keys (fields) of types different from given
export type KeysWithoutType<T, ExcludeT> = {
    [key in keyof T]: T[key] extends ExcludeT ? never : key
}[keyof T];

// exclude from structure fields with given types
export type OmitTypes<T, ExcludeT> = Pick<T, KeysWithoutType<T, ExcludeT>>

// include in structure only fields with given types (with checking their presence)
export type PickTypes<T, PickT extends T[keyof T]> = Pick<T, KeysByType<T, PickT>>

// include in structure only fields with given types (without checking their presence)
export type PickTypesUnchecked<T, PickT> = Pick<T, KeysByTypeUnchecked<T, PickT>>

// make all fields Required except fields E
export type RequiredExcept<T, E extends keyof T> = Required<Omit<T,E>> & Pick<T,E>;

//type III = Iterable<number>;

//export function fff(a : Readonly<III>) { for(let t of a) { } }

//declare interface Readonly<T> { }

