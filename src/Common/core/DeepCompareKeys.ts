import {isProxy} from "../isProxy";

function isLeafValue(value: unknown): boolean {
    return (
        value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object" ||
        isProxy(value)
    );
}

type Obj = Record<string, any>;

export function CompareKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean {
    return CompareKeys2(obj1, Object.keys(obj2));
}

export function CompareKeys2<T extends Obj>(obj1: T, keys: string[]): boolean {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}

// ── Deep traversal with transformation on key match ────────────

export function DeepCompareKeys2<T, T3>(
    obj1: T,
    keys: string[],
    func: (a: any) => T3,
): T | T3 | null {
    if (isLeafValue(obj1)) return obj1 as any;
    if (CompareKeys2(obj1 as Obj, keys)) return func(obj1);
    // array remains array — fromEntries would turn it into {0:..,1:..}
    if (Array.isArray(obj1)) return obj1.map((v) => DeepCompareKeys2(v, keys, func)) as any;
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)] as const),
    ) as any;
}
export function DeepCompareKeys<T, T2 extends Obj, T3>(
    obj1: T,
    obj2: T2,
    func: (a: T2) => T3,
): T3 | T | null {
    if (isLeafValue(obj1)) return obj1 as any;
    const keys = Object.keys(obj2);
    if (CompareKeys2(obj1 as Obj, keys)) return func(obj1 as unknown as T2);
    // array remains array — fromEntries would turn it into {0:..,1:..}
    if (Array.isArray(obj1)) return obj1.map((v) => DeepCompareKeys2(v, keys, func)) as any;
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)] as const),
    ) as any;
}

// ── Deep modifiers for socket subscriptions ────────────────────────
