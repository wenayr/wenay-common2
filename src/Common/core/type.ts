// === Promise ===
export type PromiseResult<T extends Promise<any>> = T extends Promise<infer R> ? R : never
export type PromiseArrayResult<T extends Promise<any>[]> = T extends Promise<infer R>[] ? R[] : never
export type ResolvedReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R extends Promise<any> ? PromiseResult<R> : R : any;

// === Object ===
export type ObjectValueType<T extends object> = T extends {[k: string]: infer R} ? R : never;
export type ObjectEntries<T extends object> = { [K in keyof T]: [K, T[K]] }[keyof T];

// === Array / Tuple ===
export type ArrayElementType<T extends any[]> = T extends (infer R)[] ? R : never
export type ElementOfArray<T extends any[]> = ArrayElementType<T>
export type TupleFirst<T extends any[]> = T extends [infer F, ...any[]] ? F : never
export type TupleLast<T extends any[]> = T extends [...any[], infer L] ? L : never

// === String Literal ===
export type StringKeys<T> = Extract<keyof T, string>

// === Nullable ===
export type Nullable<T> = T | null | undefined
export type NonNullableDeep<T> = T extends object ? { [K in keyof T]-?: NonNullableDeep<NonNullable<T[K]>> } : NonNullable<T>

// === Partial / Required ===
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
export type RequiredBy<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

// === Map / Set ===
export type MapKeyType<T extends Map<any, any>> = T extends Map<infer K, any> ? K : never
export type MapValueType<T extends Map<any, any>> = T extends Map<any, infer V> ? V : never
export type SetElementType<T extends Set<any>> = T extends Set<infer R> ? R : never

// === Constructor ===
export type InstanceOf<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : never
export type ConstructorArgs<T extends abstract new (...args: any) => any> = T extends abstract new (...args: infer A) => any ? A : never