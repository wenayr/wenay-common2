// listen-deep.ts

import { funcListenCallbackBase } from "../events/Listen";
import { listenSocket, listenSocketFirst, listenSocketAll, listenSocketSmart } from "./listen-socket";

type Obj = Record<string, any>;
type ListenBase<T extends any[]> = ReturnType<typeof funcListenCallbackBase<T>>;
type InferArgs<T> = T extends ListenBase<infer R> ? R : never;
type SocketResult<T extends any[]> = ReturnType<typeof listenSocket<T>>;

type TransformValue<V> =
    V extends ListenBase<any>
        ? SocketResult<InferArgs<V>>
        : V extends typeof Promise
            ? V
            : V extends (...a: any) => any
                ? V
                : V extends object
                    ? { [K in keyof V]: TransformValue<V[K]> }
                    : V;

export type DeepSocketListen<T> = {
    [K in keyof T]: TransformValue<T[K]>;
};

// ── Утилиты ─────────────────────────────────────────────────────

function isLeafValue(value: unknown): boolean {
    return (
        value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object"
    );
}

export function matchKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean {
    return matchKeysList(obj1, Object.keys(obj2));
}

export function matchKeysList<T extends Obj>(obj1: T, keys: string[]): boolean {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}

export function deepMapByKeysList<T, T3>(
    obj1: T,
    keys: string[],
    func: (a: any) => T3,
): T | T3 | null {
    if (isLeafValue(obj1)) return obj1 as any;
    if (matchKeysList(obj1 as Obj, keys)) return func(obj1);
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, deepMapByKeysList(v, keys, func)] as const),
    ) as any;
}

export function deepMapByKeys<T, T2 extends Obj, T3>(
    obj1: T,
    obj2: T2,
    func: (a: T2) => T3,
): T3 | T | null {
    if (isLeafValue(obj1)) return obj1 as any;
    const keys = Object.keys(obj2);
    if (matchKeysList(obj1 as Obj, keys)) return func(obj1 as unknown as T2);
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, deepMapByKeysList(v, keys, func)] as const),
    ) as any;
}

// ── Deep-модификаторы ───────────────────────────────────────────

const NOOP_LISTEN = funcListenCallbackBase((_e) => {});

export function deepListenFirst<T>(obj: T, data?: Parameters<typeof listenSocketFirst>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketFirst(e, data)) as DeepSocketListen<T>;
}

export function deepListenAll<T>(obj: T, data?: Parameters<typeof listenSocketAll>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketAll(e, data)) as DeepSocketListen<T>;
}

export function deepListenSmart<T>(obj: T, data?: Parameters<typeof listenSocketSmart>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketSmart(e, data)) as DeepSocketListen<T>;
}