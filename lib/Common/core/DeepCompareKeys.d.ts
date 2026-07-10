type Obj = Record<string, any>;
export declare function CompareKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean;
export declare function CompareKeys2<T extends Obj>(obj1: T, keys: string[]): boolean;
export declare function DeepCompareKeys2<T, T3>(obj1: T, keys: string[], func: (a: any) => T3): T | T3 | null;
export declare function DeepCompareKeys<T, T2 extends Obj, T3>(obj1: T, obj2: T2, func: (a: T2) => T3): T3 | T | null;
export {};
