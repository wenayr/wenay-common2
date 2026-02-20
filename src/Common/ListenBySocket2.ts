import { funcListenCallback, funcListenCallbackBase, Listener } from "./Listen";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof funcListenCallback<T>>;

// ── Guard-проверки для deep-обхода ──────────────────────────────
function isLeafValue(value: unknown): boolean {
    return (
        value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object"
    );
}

// ── Базовая подписка через socket ───────────────────────────────

export function listenSocket<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    d?: {
        readonly status?: () => boolean;
        readonly addListenClose?: ListenCallbackResult<any>;
        readonly stop?: (x: Listener<Z>) => any;
        readonly paramsModify?: (...e: Z) => any[];
    },
) {
    const { stop, addListenClose, status, paramsModify } = d ?? {};
    const { addListen, removeListen, eventClose, removeEventClose } = e;

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;
    let resolveWait: (() => void) | null = null;

    function finish() {
        if (resolveWait) { resolveWait(); resolveWait = null; }
    }

    function removeCallback() {
        if (last) { stop?.(last); last = null; }
        if (active) { removeListen(active); active = null; }
        addListenClose?.removeListen(removeCallback);
        finish();
        return true;
    }

    async function callback(z: Listener<Z>): Promise<void> {
        if (last) stop?.(last);
        if (active) {
            removeListen(active);
        }
        if (resolveWait) { resolveWait(); resolveWait = null; }

        last = z;

        let handler: Listener<any> = z;
        if (paramsModify) {
            const orig = handler;
            handler = (...a: any[]) => orig(...paramsModify(...(a as Z)));
        }
        if (status) {
            const wrapped = handler;
            handler = (...a: any[]) => {
                if (status()) wrapped(...a);
                else removeCallback();
            };
        }

        const inner = handler;
        active = (...a: any[]) => {
            if (a[0] === "___STOP") {
                z(...a as Z);
                if (last) { stop?.(last); }
                last = null;
                if (active) { removeListen(active); active = null; }
                addListenClose?.removeListen(removeCallback);
                finish();
                return;
            }
            inner(...a);
        };

        addListen(active, removeCallback);
        addListenClose?.addListen(removeCallback);

        // const closeUnsub = eventClose(removeCallback);

        return new Promise<void>((resolve) => {
            resolveWait = () => {resolve()};
        });
    }

    return { callback, removeCallback };
}

// ── listenSocketFirst: передаёт только первый параметр ──────────

export function listenSocketFirst<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, {
        ...options,
        paramsModify: ((...args: any[]) => [args[0]]) as (...e: Z) => any[],
    });
    type SingleArgCallback = (a: Z[0]) => void;
    return {
        callback: r.callback as unknown as (z: SingleArgCallback) => void,
        removeCallback: r.removeCallback,
    };
}

// ── listenSocketAll: передаёт весь кортеж аргументов ────────────

export function listenSocketAll<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as (z: (...args: Z) => void) => void,
        removeCallback: r.removeCallback,
    };
}

// ── listenSocketSmart: auto-unwrap одноэлементного кортежа ──────

type SmartCallback<Z extends any[]> = Z extends [infer Single]
    ? (a: Single) => void
    : (...args: Z) => void;

export function listenSocketSmart<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as unknown as (z: SmartCallback<Z>) => void,
        removeCallback: r.removeCallback,
    };
}

// ── Сравнение ключей ────────────────────────────────────────────

type Obj = Record<string, any>;

export function matchKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean {
    return matchKeysList(obj1, Object.keys(obj2));
}

export function matchKeysList<T extends Obj>(obj1: T, keys: string[]): boolean {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}

// ── Deep-обход с преобразованием по совпадению ключей ────────────

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

type ListenBase<T extends any[]> = ReturnType<typeof funcListenCallbackBase<T>>;
type InferArgs<T> = T extends ListenBase<infer R> ? R : never;
type SocketResult<T extends any[]> = ReturnType<typeof listenSocket<T>>;

// ── Хвостовая рекурсия: обработка одного ключа ─────────────────

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

// ── Хвостовая DeepSocketListen через mapped type ────────────────

export type DeepSocketListen<T> = {
    [K in keyof T]: TransformValue<T[K]>;
};

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

// ── Deep-модификаторы для socket-подписок ────────────────────────

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