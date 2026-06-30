import { isListenCallback, funcListenCallbackBase, isListenOn, getListenByOn } from "../events/Listen";
import { listenSocket, } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from "./rpc-server";
import {DeepSocketListen} from "./listen-deep";
import {SocketTmpl, IS_RPC_LISTEN, RPC_STOP} from "./rpc-protocol";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

export function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    auth?: RpcServerAuth;
    /** Opt-in потолок числа подписчиков на ОДИН Listen-узел этого сокета. undefined = без
     *  лимита (поведение прежнее, байт-в-байт). Лишние подписки тихо игнорируются —
     *  щит против багнутого/злого клиента, шлющего `*.callback(fn)` в цикле. */
    maxPerListen?: number;
    /** Opt-in min-interval (мс) для КАЖДОГО серверного Listen-узла этого сокета:
     *  эмитить не чаще раза в `throttle` мс (leading + trailing-latest). undefined/0 =
     *  без троттлинга. Серверная сторона — лучшее место для back-to-back: лишние
     *  эмиссии гасятся ДО упаковки/отправки в провод. */
    throttle?: number;
    /** Оптимизации провода (договорные): { compact?: false } отключает уплотнение тиков. */
    opt?: RpcOpt;
}) {
    // Один listenSocket-wrapper на Listen ЗАТИРАЛ предыдущего подписчика при повторной
    // подписке (его callback заменяет last/active). Мультиплексор: каждый подписчик
    // получает собственный listenSocket; записи чистятся по завершении подписки.
    // Кэш по ИДЕНТИЧНОСТИ Listen-узла. Важно для re-auth: фасады разных principal должны
    // переиспользовать ОДИН и тот же Listen-объект (один UseListen-хендл), иначе при смене principal
    // старая серверная подписка не снимается и продолжает слать события. Чтобы СМЕНИТЬ видимость
    // стрима у клиента — переподключение (dispose+reconnect), а не reauth по живому сокету.
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();
    // WeakMap нельзя обойти — держим параллельный ИТЕРИРУЕМЫЙ реестр узлов с ЖИВЫМИ
    // подписчиками, ТОЛЬКО для статистики/потолка. Ключ — тот же узел identity, что и в cache.
    // Реестр НАПОЛНЯЕТСЯ ЛЕНИВО в subscribe() (не в getListenSocket): resolveTransform зовёт
    // getListenSocket ЭЙДЖЕРНО на каждый задекларированный Listen при старте и на каждом re-auth,
    // поэтому регистрация там (а) показала бы в stats нулевые узлы и (б) пинила бы узлы старого
    // principal на сильной Map → утечка по числу re-auth. Регистрируем только реальную подписку.
    const registry = new Map<object, { subs: Map<Function, ReturnType<typeof listenSocket>> }>();
    function unsubscribeAllActive() {
        for (const {subs} of registry.values()) {
            subs.forEach(w => w.removeCallback());
            subs.clear();
        }
        registry.clear();
    }

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (!result) {
            const subs = new Map<Function, ReturnType<typeof listenSocket>>();
            function subscribe(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen callback expects a function"));
                // Opt-in потолок на узел: лишнего подписчика тихо игнорируем — стрим для него
                // не стартует, серверная подписка не создаётся. Без опции ветка не берётся.
                if (maxPerListen != null && subs.size >= maxPerListen) return Promise.resolve();
                // ленивая (ре-)регистрация узла при РЕАЛЬНОЙ подписке — переживает drain→re-sub
                if (!registry.has(parent)) registry.set(parent, { subs });
                subs.get(z)?.removeCallback();
                const w = listenSocket(parent, { addListenClose: disconnectListen, throttle });
                subs.set(z, w);
                const done = w.callback(z);
                done.then(() => {
                    if (subs.get(z) == w) subs.delete(z);
                    if (subs.size == 0) registry.delete(parent); // узел опустел — снимаем со счёта stats()
                });
                return done;
            }
            // once — однократная подписка: первое событие → CB, затем RPC_STOP→CB_END и off.
            function subscribeOnce(z: any) {
                if (typeof z !== "function") return Promise.reject(new TypeError("Listen once expects a function"));
                if (maxPerListen != null && subs.size >= maxPerListen) return Promise.resolve();
                if (!registry.has(parent)) registry.set(parent, { subs });
                subs.get(z)?.removeCallback();
                const w = listenSocket(parent, { addListenClose: disconnectListen, throttle });
                let fired = false;
                const oneShot = (...a: any[]) => {
                    if (fired) return;
                    fired = true;
                    try {
                        z(...a);        // первое событие → CB
                        z(RPC_STOP);    // конец стрима → CB_END
                    }
                    finally {
                        w.removeCallback();
                    }
                };
                subs.set(z, w);
                const done = w.callback(oneShot);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); if (subs.size == 0) registry.delete(parent); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.removeCallback());
                subs.clear();
                registry.delete(parent); // узел снесён — убираем из реестра
                return true;
            }
            // close — закрыть весь Listen-источник (полный teardown; влияет на ВСЕХ потребителей узла).
            result = { callback: subscribe, removeCallback: unsubscribeAll, on: subscribe, once: subscribeOnce, close: () => (parent as any).close?.() };
            (result as any)[IS_RPC_LISTEN] = true; // сервер задекларирует адрес узла в Pkt.MAP
            cache.set(parent, result);
        }
        return result;
    }

    // ===================================================================
    // api: наблюдаемость подписок (аддитивно — раньше фабрика возвращала void)
    // ===================================================================
    const api = {
        /** Живые серверные Listen-узлы этого сокета и число их локальных потребителей. */
        subscriptions: () => Array.from(registry, ([parent, e], i) => ({
            // ключ — стабильный токен идентичности узла (НЕ адрес провода): для дебага/метрик.
            key: (parent as any)?.constructor?.name ? `${(parent as any).constructor.name}#${i}` : `listen#${i}`,
            consumers: e.subs.size,
        })),
    };

    createRpcServer({
        socket, object: target as any, socketKey: key, debug, limits, auth, opt,
        hooks: {
            ...hooks,
            onDispose: () => { unsubscribeAllActive(); hooks?.onDispose?.(); },
            resolveTransform: (obj: any) => {
                if (isListenCallback(obj)) return getListenSocket(obj, disconnectListen);
                // bare `on`-функция: по реестру (WeakMap) находим её api и оборачиваем — позволяет
                // прокинуть через веб ТОЛЬКО ссылку on, а клиент получит подписку {on, once, close}.
                if (isListenOn(obj)) return getListenSocket(getListenByOn(obj), disconnectListen);
                return obj;
            },
        } as any,
    });

    return { api }; // аддитивно: раньше void. Старые вызовы (harness x3, test.ts) игнорируют возврат.
}
