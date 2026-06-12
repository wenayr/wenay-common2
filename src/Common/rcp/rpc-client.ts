import { Pkt, type SocketTmpl } from "./rpc-protocol";
import {createIdPool, type idPool} from "../id-pool";
import {pack, resolveCA, unpackResult} from "./rpc-walk";
import {resolveLimits, type RpcLimits} from "./rpc-limits";
import {MyError} from "../../toError/myThrow";

// Общий пул id на (socket × key): два клиента на одном сокете+ключе делят id-пространство,
// иначе их reqId коллизируют и чужой RESP резолвит оба ожидания.
const SHARED_POOLS = new WeakMap<object, Map<string, idPool>>();
function sharedPool(socket: object, key: string) {
    let byKey = SHARED_POOLS.get(socket);
    if (!byKey) { byKey = new Map(); SHARED_POOLS.set(socket, byKey); }
    let pool = byKey.get(key);
    if (!pool) { pool = createIdPool(); byKey.set(key, pool); }
    return pool;
}

// Объект ошибки с провода → экземпляр MyError (name/stack/code/data/cause сохраняются).
// Не-объекты и чужие формы отдаём как есть.
const reviveErr = (o: any): any => {
    if (o == null || typeof o != "object" || typeof o.message != "string" || typeof o.name != "string") return o;
    const err = MyError.fromWire(o);
    if (o.cause !== undefined) (err as any).cause = reviveErr(o.cause);
    return err;
};
// Вспомогательные типы
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

export type DeepDataOnly<T> = T extends Function
    ? never
    : T extends Array<infer U>
        ? Array<DeepDataOnly<U>>
        : T extends object
            ? { [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]> }
            : T;

// --- 1. ТИПИЗАЦИЯ ДЛЯ ОБЫЧНЫХ ВЫЗОВОВ (БЕЗ PIPE) ---
export type ClientAPIAll<T> = {
    [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]:
        T[K] extends (...args: infer A) => infer R
            // Обычный вызов возвращает ТОЛЬКО Promise с чистыми данными. Никакого продолжения цепочки.
            ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>
            : T[K] extends object
                ? ClientAPIAll<T[K]>
                : never;
};

type NonFalsy<T> = Exclude<T, false | null | 0 | "" | undefined>;

export type ClientAPIStrict<T> = {
    [K in keyof T as NonFalsy<T[K]> extends Function
        ? K
        : NonFalsy<T[K]> extends object
            ? K
            : never]:
    NonFalsy<T[K]> extends (...args: infer A) => infer R
        ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>
        : NonFalsy<T[K]> extends object
            ? ClientAPIStrict<NonFalsy<T[K]>>
            : never;
};



// --- 2. ТИПИЗАЦИЯ ДЛЯ PIPE ВЫЗОВОВ ---
// Интерфейс для работы с массивами внутри pipe (если сервер возвращает массив, 
// мы можем продолжить путь по индексу или через map)
export interface PipeArrayAPI<T> extends Promise<DeepDataOnly<T[]>> {
    [index: number]: PipeAPI<T>;
    // map и filter можно добавить, если серверная часть (и наш Proxy) научится их обрабатывать
}

export type PipeAPI<T> = T extends Array<infer U>
    ? PipeArrayAPI<U>
    : {
        [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]:
            T[K] extends (...args: infer A) => infer R
                // Pipe-вызов возвращает и Promise (для await), и продолжает PipeAPI для цепочки
                ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>> & PipeAPI<UnwrapPromise<R>>
                : T[K] extends object
                    ? PipeAPI<T[K]>
                    : never;
    };

type ClientApiHandle = {
    log: (s: boolean) => void;
    pending: () => number;
    callbacks: () => number;
    clearPromises: (reject?: boolean) => void;
    clearCallbacks: () => void;
    remove: (fn: Function) => void;
    end: (fn: Function) => void;
    /** Живые сетевые подписки (дедуп включён): адрес + число локальных потребителей. */
    subscriptions: () => { key: string; consumers: number }[];
};

const IS_RPC_PIPE = Symbol.for("isRpcPipe");

function createClient<T extends object>(socket: SocketTmpl, key: string, opts?: { limit?: number; limits?: RpcLimits; dedupeListen?: boolean }) {
    const limit = opts?.limit ?? 10000;
    // opt-in: без опции limits поведение прежнее (ответы сервера не ограничиваются)
    const lim = opts?.limits ? resolveLimits(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    const pending = new Map<number, { ok: Function; fail: Function; cbs: number[] }>();
    const callbacks = new Map<number, Function>();
    // id отменённых запросов/колбэков: НЕ возвращаем в пул сразу — поздний RESP/CB_END
    // сервера по переиспользованному id угнал бы чужой новый запрос
    const zombies = new Set<number>();
    const retire = (id: number) => { zombies.add(id); };
    let disposed = false;
    const routeCache: Record<string, number> = {};
    let strictData: any = {};
    let strictWaiters: ((v: unknown) => void)[] = [];
    let debug = false;

    socket.on(key, (msg: any) => {
        if (!Array.isArray(msg)) return;
        if (disposed) {
            // после dispose только возвращаем зомби-id в общий пул, остальное игнорируем
            if ((msg[0] == Pkt.RESP || msg[0] == Pkt.CB_END) && zombies.delete(msg[1])) pool.release(msg[1]);
            return;
        }
        switch (msg[0]) {
            case Pkt.RESP: {
                const req = pending.get(msg[1]);
                if (!req) { if (zombies.delete(msg[1])) pool.release(msg[1]); break; }
                pending.delete(msg[1]);
                pool.release(msg[1]);
                for (const cbId of req.cbs) { if (callbacks.delete(cbId)) pool.release(cbId); }
                if (msg[3]) req.fail(reviveErr(msg[3]));
                else {
                    // нарушение лимитов/битый payload в ответе — отклоняем именно этот запрос
                    try { req.ok(unpackResult(msg[2], lim)); }
                    catch (e) { req.fail(e); }
                }
                break;
            }
            case Pkt.CB: {
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                let cbArgs: any[];
                // у стрима нет канала ошибки — битый/превышающий лимиты пакет дропаем
                // (раньше .map(unpackResult) ещё и передавал index вторым аргументом как lim)
                try { cbArgs = (msg[2] || []).map((a: any) => unpackResult(a, lim)); }
                catch (e) { if (debug) console.log("[RPC CB] dropped:", e); break; }
                cb(...cbArgs);
                break;
            }
            case Pkt.CB_END: {
                const cbId = msg[1] as number;
                // release только если id наш (трекался) — чужой/поздний CB_END не должен
                // освобождать id, занятый другим запросом
                if (callbacks.delete(cbId)) pool.release(cbId);
                else if (zombies.delete(cbId)) pool.release(cbId);
                break;
            }
            case Pkt.MAP: {
                if (msg[1]) Object.assign(routeCache, msg[1]);
                // новый сервер декларирует адреса Listen-узлов — дедуп подписок становится точным
                if (Array.isArray(msg[3])) { declaredListens ??= new Set(); for (const p of msg[3]) declaredListens.add(p); }
                if (msg[2]) {
                    for (const k of Object.keys(strictData)) delete strictData[k];
                    Object.assign(strictData, msg[2]);
                    for (const r of strictWaiters) r(undefined);
                    strictWaiters = [];
                }
                break;
            }
        }
    });

    const sendPipe = (path: string[], steps: any[], wait: boolean): any => {
        if (disposed) return wait ? Promise.reject(new Error("RPC client disposed")) : Promise.resolve();
        const cbIds: number[] = [];
        // Упаковываем аргументы во всех шагах вызова (call)
        const cleanSteps = steps.map(step => {
            if (step.type === 'call') {
                return { type: 'call', args: pack(step.args, pool, callbacks, cbIds) };
            }
            return step;
        });
        const ref: number | string[] = routeCache[path.join(".")] ?? path;

        if (!wait) {
            socket.emit(key, [Pkt.PIPE, 0, ref, cleanSteps, false]);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (pending.size >= limit) return reject(new Error("RPC limit"));
            const reqId = pool.next();
            pending.set(reqId, { ok: resolve, fail: reject, cbs: cbIds });
            if (debug) console.log("[RPC PIPE]", path.join("."), "steps=", steps.length, "id=", reqId);
            socket.emit(key, [Pkt.PIPE, reqId, ref, cleanSteps]);
        });
    };

    const buildPipeProxy = (path: string[], steps: any[], wait: boolean): any => {
        const proxy = new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p === IS_RPC_PIPE) return true;
                if (p === "then") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => promise.then(...a);
                }
                if (p === "catch") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => promise.catch(...a);
                }
                if (p === "finally") {
                    if (path.length === 0) return undefined;
                    const promise = sendPipe(path, steps, wait);
                    return (...a: any[]) => (promise as any).finally(...a);
                }
                if (p === "__executeRemainingPipe") {
                    // Для серверной прозрачной ретрансляции
                    return (remaining: any[]) => sendPipe(path, [...steps, ...remaining], wait);
                }
                if (p === Symbol.toPrimitive) return undefined;

                if (path.length === 0) {
                    return buildPipeProxy([String(p)], steps, wait);
                }
                return buildPipeProxy(path, [...steps, { type: 'get', prop: String(p) }], wait);
            },
            apply(_, __, args) {
                if (path.length === 0) throw new Error("Cannot call root pipe object");
                return buildPipeProxy(path, [...steps, { type: 'call', args }], wait);
            },
        });
        return proxy;
    };

    const sendCallWire = (path: string[], args: any[], wait: boolean): any => {
        if (disposed) return wait ? Promise.reject(new Error("RPC client disposed")) : Promise.resolve();
        const cbIds: number[] = [];
        const clean = pack(args, pool, callbacks, cbIds);
        const ref: number | string[] = routeCache[path.join(".")] ?? path;

        if (!wait) {
            socket.emit(key, [Pkt.CALL, 0, ref, clean, false]);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (pending.size >= limit) return reject(new Error("RPC limit"));
            const reqId = pool.next();
            pending.set(reqId, { ok: resolve, fail: reject, cbs: cbIds });
            if (debug) console.log("[RPC]", path.join("."), "id=", reqId);
            socket.emit(key, [Pkt.CALL, reqId, ref, clean]);
        });
    };

    // ===================================================================
    // Дедуп подписок: ОДНО сетевое соединение на клиента на Listen.
    // Адрес = путь `*.callback` + аргументы без колбэков; новые потребители
    // получают данные локальной ретрансляцией; сетевой стоп — когда ушёл последний.
    // ===================================================================
    const dedupe = opts?.dedupeListen ?? true;
    type tConsumer = { fns: Function[]; resolve: () => void };
    type tSub = { consumers: Set<tConsumer>; stop: () => void };
    const wireSubs = new Map<string, tSub>();
    // адреса Listen-узлов, задекларированные сервером в Pkt.MAP; null = старый сервер (без декларации)
    let declaredListens: Set<string> | null = null;

    function subscribeShared(path: string[], args: any[]) {
        if (disposed) return Promise.reject(new Error("RPC client disposed"));
        const skey = path.join(".") + "::" + JSON.stringify(args.map(a => typeof a == "function" ? "@fn" : a));
        let sub = wireSubs.get(skey);
        if (!sub) {
            const created: tSub = { consumers: new Set(), stop: () => {} };
            wireSubs.set(skey, created);
            let fnPos = 0;
            const realArgs = args.map(a => {
                if (typeof a != "function") return a;
                const i = fnPos++;
                // единый сетевой колбэк — ретранслирует событие всем локальным потребителям
                return (...ev: any[]) => { created.consumers.forEach(c => c.fns[i]?.(...ev)); };
            });
            const finish = () => {
                if (wireSubs.get(skey) == created) wireSubs.delete(skey);
                created.consumers.forEach(c => c.resolve());
                created.consumers.clear();
            };
            created.stop = () => {
                // последний локальный потребитель ушёл — настоящий стоп серверной подписки
                sendCallWire([...path.slice(0, -1), "removeCallback"], [], false);
                finish();
            };
            sendCallWire(path, realArgs, true).then(finish, finish); // сервер сам закрыл стрим / разрыв
            sub = created;
        }
        const consumer: tConsumer = { fns: args.filter(a => typeof a == "function") as Function[], resolve: () => {} };
        sub.consumers.add(consumer);
        const p: any = new Promise<void>(res => { consumer.resolve = res; });
        // идиома Listen.addListen: подписка отдаёт отписку; тип callback не меняем — довешиваем на промис
        p.unsubscribe = () => {
            if (!sub!.consumers.delete(consumer)) return;
            consumer.resolve();
            if (sub!.consumers.size == 0) sub!.stop();
        };
        return p;
    }

    const sendCall = (path: string[], args: any[], wait: boolean): any => {
        if (dedupe && wait && path.length > 1 && path[path.length - 1] == "callback" && args.some(a => typeof a == "function")) {
            // точно: сервер задекларировал адрес как Listen (Pkt.MAP[3]);
            // fallback для старого сервера — эвристика по форме маршрута `*.callback(fn)`
            const isListen = declaredListens ? declaredListens.has(path.slice(0, -1).join(".")) : true;
            if (isListen) return subscribeShared(path, args);
        }
        return sendCallWire(path, args, wait);
    };

    const buildProxy = (path: string[], wait: boolean): any =>
        new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p == "then" || p == "catch" || p == Symbol.toPrimitive) return undefined;
                return buildProxy([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args);
                return sendCall(fp, fa, wait);
            },
        });

    const buildStrict = (path: string[], wait: boolean): any => {
        let tgt: any = strictData;
        for (const seg of path) {
            tgt = tgt?.[seg];
            if (tgt == null || tgt == "null") return undefined;
            if (tgt == "dynamic") return buildProxy([...path], wait);
        }
        if (tgt == "dynamic") return buildProxy(path, wait);

        return new Proxy(tgt == "func" ? function () {} : {}, {
            has: (_, p) => tgt?.[String(p)] !== "null",
            ownKeys: () => tgt && typeof tgt == "object" ? Object.keys(tgt) : [],
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
            getPrototypeOf: () => !tgt || tgt == "null" ? Object.prototype : tgt == "func" ? Function.prototype : null,
            get(_, p: string | symbol) {
                if (p == "then" || p == "catch" || p == Symbol.toPrimitive) return undefined;
                if (p == "call" && tgt == "func") return (_: any, ...args: any[]) => sendCall(path, args, wait);
                if (tgt === "func") return undefined;
                const child = tgt?.[String(p)];
                return child == "null" || child == undefined ? undefined : buildStrict([...path, String(p)], wait);
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args);
                return sendCall(fp, fa, wait);
            },
        });
    };

    const releaseCbs = (fn: Function) => {
        callbacks.forEach((cb, id) => { if (cb == fn) { callbacks.delete(id); retire(id); } });
    };

    function abortAll(reason: string) {
        const err = { error: { name: "RPC_ABORT", message: reason } };
        pending.forEach((p, id) => { retire(id); p.fail(err); });
        pending.clear();
        callbacks.forEach((_, id) => retire(id));
        callbacks.clear();
    }

    // отцепить клиента: отклонить висящие, игнорировать дальнейшие пакеты, отбивать новые вызовы
    function dispose(reason = "RPC client disposed") {
        if (disposed) return;
        abortAll(reason);
        disposed = true;
    }

    const api: ClientApiHandle = {
        log: s => { debug = s; },
        pending: () => pending.size,
        callbacks: () => callbacks.size,
        clearPromises: (rej = true) => {
            pending.forEach((p, id) => { retire(id); rej ? p.fail("promiseDeleteAll") : p.ok(undefined); });
            pending.clear();
        },
        clearCallbacks: () => { callbacks.forEach((_, id) => retire(id)); callbacks.clear(); },
        remove: releaseCbs,
        end: releaseCbs,
        subscriptions: () => Array.from(wireSubs, ([k, s]) => ({ key: k, consumers: s.consumers.size })),
    };

    const func = buildProxy([], true) as ClientAPIAll<T>;
    const pipe = buildPipeProxy([], [], true) as PipeAPI<T>;
    const pipeStrict = buildPipeProxy([], [], true) as PipeAPI<T>; // пока ≡ pipe — строгая валидация не реализована (PLAN: API honesty)

    let _ready: null | Promise<void> = null;
    let ready = () => _ready ? _ready : _ready = init()
    const init = async (obj?: object) => {
        if (obj) { strictData = obj; }
        else
        {
            socket.emit(key, Pkt.STRICT);
            await new Promise(r => { strictWaiters.push(r); });
        }
    }

    return {
        func,           // <- Тип ClientAPI (нет цепочек)
        pipe,           // <- Тип PipeAPI (есть цепочки)
        pipeStrict,     // <- Тип PipeAPI (есть цепочки)
        space: buildProxy([], false) as ClientAPIAll<T>,
        all: func as ClientAPIAll<T>,
        strict: buildStrict([], true) as ClientAPIStrict<T>, // <- Тип ClientAPI (нет цепочек)
        api,
        abortAll,
        dispose,
        schema: () => strictData,
        readyStrict: ready,
        initStrict: init,
    };
}

export type RpcClientReturn<T extends object> = {
    func: ClientAPIAll<T>;
    pipe: PipeAPI<T>;
    /** Пока идентичен {@link pipe}: строгая валидация по схеме ещё не реализована. */
    pipeStrict: PipeAPI<T>;
    space: ClientAPIAll<T>;
    all: ClientAPIAll<T>;
    strict: ClientAPIStrict<T>;
    api: ClientApiHandle;
    abortAll: (reason: string) => void;
    /** Отцепить клиента: висящие отклоняются, дальнейшие пакеты игнорируются, новые вызовы отбиваются. */
    dispose: (reason?: string) => void;
    schema: () => any;
    readyStrict: () => Promise<void>;
    initStrict: (obj?: object) => Promise<void>;
};

export function createRpcClient<T extends object>({ socket, socketKey: key, limit, limits, dedupeListen }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
    /** Opt-in лимиты на ВХОДЯЩИЕ данные (ответы/колбэки сервера); без опции — как раньше, без ограничений. */
    limits?: RpcLimits;
    /** Дедуп подписок (по умолчанию ВКЛЮЧЁН): одно сетевое соединение на Listen-адрес,
     *  новые потребители ретранслируются локально, сетевой стоп — после ухода последнего.
     *  Подписка (`*.callback(cb)`) возвращает промис с методом `.unsubscribe()`. */
    dedupeListen?: boolean;
}): RpcClientReturn<T> {
    return createClient<T>(socket, key, { limit, limits, dedupeListen });
}

export type { ClientApiHandle };
