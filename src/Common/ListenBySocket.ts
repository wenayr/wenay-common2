import { isProxy } from "./isProxy";
import { funcListenCallback, funcListenCallbackBase, Listener } from "./Listen";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof funcListenCallback<T>>;

// ── Guard-проверки для deep-обхода ──────────────────────────────
function isLeafValue(value: unknown): boolean {
    return (
        value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object" ||
        isProxy(value)
    );
}
export function funcListenBySocket2<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    d?: {
        readonly status?: () => boolean;
        readonly addListenClose?: ListenCallbackResult<any>;
        readonly stop?: (x: Listener<Z>) => any;
        readonly paramsModify?: (...e: Z) => any[];
    },
) {
    const { stop, addListenClose, status, paramsModify } = d ?? {};
    const { addListen, removeListen, eventClose } = e;

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;

    function removeCallback() {
        if (last) {
            stop?.(last);
            last = null;
        }
        if (active) {
            removeListen(active);
            active = null;
        }
        addListenClose?.removeListen(removeCallback);
        return true;
    }

    function callback(z: Listener<Z>) {
        if (last) stop?.(last);
        if (active) removeListen(active);

        last = z;

        // собираем финальный обработчик за один проход
        let handler: Listener<any> = z;
        if (paramsModify) {
            const orig = handler;
            handler = (...a: any[]) => orig(...paramsModify(...(a as Z)));
        }
        if (status) {
            const wrapped = handler;
            handler = (...a: any[]) => {
                if (status()) wrapped(...a);
                else removeListen(active);
            };
        }

        active = handler;
        addListen(active);
        addListenClose?.addListen(removeCallback);
    }

    return { callback, removeCallback };
}

// ── funcListenBySocket3: передаёт только первый параметр ────────

export function funcListenBySocket3<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof funcListenBySocket2>[1], "paramsModify">,
) {
    const r = funcListenBySocket2(e, {
        ...options,
        paramsModify: ((...args: any[]) => [args[0]]) as (...e: Z) => any[],
    });
    type SingleArgCallback = (a: Z[0]) => void;
    return {
        callback: r.callback as unknown as (z: SingleArgCallback) => void,
        removeCallback: r.removeCallback,
    };
}

// ── funcListenBySocket4: передаёт весь кортеж аргументов ────────

export function funcListenBySocket4<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof funcListenBySocket2>[1], "paramsModify">,
) {
    const r = funcListenBySocket2(e, {
        ...options,
        // paramsModify не передаём — аргументы идут как есть
    });
    return {
        callback: r.callback as (z: (...args: Z) => void) => void,
        removeCallback: r.removeCallback,
    };
}

// ── funcListenBySocket5: auto-unwrap одноэлементного кортежа ────

type UnwrapSingleTuple<Z extends any[]> = Z extends [infer Single] ? [Single] : Z;
type SmartCallback<Z extends any[]> = Z extends [infer Single]
    ? (a: Single) => void
    : (...args: Z) => void;

export function funcListenBySocket5<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof funcListenBySocket2>[1], "paramsModify">,
) {
    // Если кортеж из одного элемента — разворачиваем, иначе передаём как есть
    const r = funcListenBySocket2(e, {
        ...options,
        // runtime: всегда передаём весь кортеж — колбэк и так получит один аргумент если Z = [T]
    });
    return {
        callback: r.callback as unknown as (z: SmartCallback<Z>) => void,
        removeCallback: r.removeCallback,
    };
}

export function funcListenBySocketSmart<Z extends any[] = any[]>(
    e: ReturnType<typeof funcListenCallback<Z>>,
    status: () => boolean,
    onStop?: ReturnType<typeof funcListenCallback<any>>,
) {
    const r = funcListenBySocket5<Z>(e, {
        status,
        addListenClose: onStop,
        stop: (x: any) => (x as any)?.("___STOP"),
    });
    return r;
}

export function deepModifyByListenSocket5<T>(obj: T, data?: Parameters<typeof funcListenBySocket5>[1]) {
    return DeepCompareKeys(obj, NOOP_LISTEN, (e) => funcListenBySocket5(e, data)) as DeepSocket<T>;
}

// ── Устаревшая версия — делегирует в funcListenBySocket2 ────────
// TODO: мигрировать все вызовы на funcListenBySocket2/3 и удалить

/**  используйте funcListenBySocket2 */
export function funcListenBySocket<Z extends any[] = any[]>(
    e: ReturnType<typeof funcListenCallback<Z>>,
    status: () => boolean,
    onStop?: ReturnType<typeof funcListenCallback<any>>,
) {
    const r = funcListenBySocket3<Z>(e, {
        status,
        addListenClose: onStop,
        stop: (x: any) => (x as any)?.("___STOP"),
    });
    return r;
}

export function funcListenBySocketFull<Z extends any[] = any[]>(
    e: ReturnType<typeof funcListenCallback<Z>>,
    status: () => boolean,
    onStop?: ReturnType<typeof funcListenCallback<any>>,
) {
    const r = funcListenBySocket4<Z>(e, {
        status,
        addListenClose: onStop,
        stop: (x: any) => (x as any)?.("___STOP"),
    });
    return r;
}

/** алиас для funcListenBySocket */
export const funcListenBySocket1 = funcListenBySocket;

// ── Сравнение ключей ────────────────────────────────────────────

type Obj = Record<string, any>;

export function CompareKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean {
    return CompareKeys2(obj1, Object.keys(obj2));
}

export function CompareKeys2<T extends Obj>(obj1: T, keys: string[]): boolean {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}

// ── Deep-обход с преобразованием по совпадению ключей ────────────

export function DeepCompareKeys2<T, T3>(
    obj1: T,
    keys: string[],
    func: (a: any) => T3,
): T | T3 | null {
    if (isLeafValue(obj1)) return obj1 as any;
    if (CompareKeys2(obj1 as Obj, keys)) return func(obj1);
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)] as const),
    ) as any;
}

type ListenBase<T extends any[]> = ReturnType<typeof funcListenCallbackBase<T>>;
type InferArgs<T> = T extends ListenBase<infer R> ? R : never;
type SocketResult<T extends any[]> = ReturnType<typeof funcListenBySocket1<T>>;
type DeepSocket<T> = {
    [K in keyof T]: T[K] extends ListenBase<any>
        ? SocketResult<InferArgs<T[K]>>
        : T[K] extends typeof Promise
            ? T[K]
            : T[K] extends (...a: any) => any
                ? T[K]
                : T[K] extends object
                    ? DeepSocket<T[K]>
                    : T[K];
};

export function DeepCompareKeys<T, T2 extends Obj, T3>(
    obj1: T,
    obj2: T2,
    func: (a: T2) => T3,
): T3 | T | null {
    if (isLeafValue(obj1)) return obj1 as any;
    const keys = Object.keys(obj2);
    if (CompareKeys2(obj1 as Obj, keys)) return func(obj1 as unknown as T2);
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, DeepCompareKeys2(v, keys, func)] as const),
    ) as any;
}

// ── Deep-модификаторы для socket-подписок ────────────────────────

const NOOP_LISTEN = funcListenCallbackBase((_e) => {});

export function deepModifyByListenSocket<T>(obj: T, status: () => boolean) {
    return DeepCompareKeys(obj, NOOP_LISTEN, (e) => funcListenBySocket1(e, status)) as DeepSocket<T>;
}

export function deepModifyByListenSocket2<T>(obj: T, data?: Parameters<typeof funcListenBySocket2>[1]) {
    return DeepCompareKeys(obj, NOOP_LISTEN, (e) => funcListenBySocket2(e, data)) as DeepSocket<T>;
}

export function deepModifyByListenSocket3<T>(obj: T, data?: Parameters<typeof funcListenBySocket4>[1]) {
    return DeepCompareKeys(obj, NOOP_LISTEN, (e) => funcListenBySocket4(e, data)) as DeepSocket<T>;
}

export function deepModifyByListenSocket4<T>(obj: T, status: () => boolean) {
    return DeepCompareKeys(obj, NOOP_LISTEN, (e) => funcListenBySocketFull(e, status)) as DeepSocket<T>;
}
/** @deprecated используйте deepModifyByListenSocket */
export const funcListenBySocketObj = deepModifyByListenSocket;