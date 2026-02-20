import { isListenCallback, Listener, funcListenCallbackBase } from "./Listen";
import { isProxy } from "./isProxy";
import { CreatAPIFacadeServer2, type PromiseServerHooks } from "./commonsServerMini2";

type Socket = { emit: (e: string, d: any) => void; on: (e: string, cb: (d: any) => void) => void };

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

type AutoClientAPI<T> = {
    [K in keyof T]: T[K] extends ListenCallbackBase<infer Args>
        ? (callback: (...args: Args) => void) => void
        : T[K] extends (...args: infer A) => infer R
            ? T[K]
            : T[K] extends object
                ? AutoClientAPI<T[K]>
                : T[K];
};

// ── WeakMap-кэш: уже проверенные объекты ───────────────────────

/** null = не listen, Function = уже сконвертированная обёртка */
const listenCache = new WeakMap<object, Function | null>();

function wrapIfListen(value: any): any {
    if (value == null || typeof value !== "object") return value;

    // Быстрый путь: уже проверяли
    if (listenCache.has(value)) {
        return listenCache.get(value) ?? value;
    }

    if (isListenCallback(value)) {
        const wrapper = (callback: (...args: any[]) => void) => {
            value.addListen(callback as Listener<any>, () => {
                try { callback("___STOP"); } catch (_) {}
            });
        };
        listenCache.set(value, wrapper);
        return wrapper;
    }

    // Не listen — запоминаем чтобы не проверять снова
    listenCache.set(value, null);
    return value;
}

// ── Рекурсивный Proxy-обёртка ───────────────────────────────────

const proxyCache = new WeakMap<object, any>();

function autoWrap<T extends object>(obj: T): AutoClientAPI<T> {
    if (proxyCache.has(obj)) return proxyCache.get(obj);

    const proxy = new Proxy(obj, {
        get(target, prop, receiver) {
            const raw = Reflect.get(target, prop, receiver);

            // Примитивы и функции — как есть (функции сервера не трогаем)
            if (raw == null || typeof raw !== "object") return raw;
            if (typeof raw === "function") return raw;

            // Проверяем: может это listenCallback?
            const converted = wrapIfListen(raw);
            if (converted !== raw) return converted; // подменили на функцию-подписку

            // Если объект, но не proxy — оборачиваем рекурсивно
            if (!isProxy(raw)) return autoWrap(raw);

            // Это proxy (динамический объект) — тоже оборачиваем,
            // потому что за ним могут быть listen-объекты
            return autoWrap(raw);
        },

        // ownKeys / getOwnPropertyDescriptor — пробрасываем для serialize в createServer
        ownKeys(target) {
            return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        has(target, prop) {
            return Reflect.has(target, prop);
        },
    });

    proxyCache.set(obj, proxy);
    return proxy as AutoClientAPI<T>;
}

// ── Фасад ───────────────────────────────────────────────────────

export function CreatAPIFacadeServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks }: {
    socket: Socket;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: PromiseServerHooks<AutoClientAPI<T>>;
}) {
    const wrapped = autoWrap(target);

    CreatAPIFacadeServer2({
        socket,
        object: wrapped,
        socketKey: key,
        debug,
        hooks,
    });

    return { wrapped };
}

export type { AutoClientAPI };
