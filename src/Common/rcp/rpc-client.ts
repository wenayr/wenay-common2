import { Pkt, type SocketTmpl } from "./rpc-protocol";
import { rpcPathKey } from "./rpc-path";
import {createIdPool, type idPool} from "../id-pool";
import {pack, resolveCA, unpackResult} from "./rpc-walk";
import {resolveLimits, type RpcLimits} from "./rpc-limits";
import {MyError} from "../../toError/myThrow";
import {makeOff} from "./rpc-off";
import { optToCaps, type tCaps, type RpcOpt } from "./rpc-caps";
import {
    createTransportLifecycle,
    RPC_MEMBER_LOOKUP,
    RPC_TRANSPORT_CONTROL,
    RPC_TRANSPORT_LIFECYCLE,
} from '../events/transport-lifecycle'
// только типы (без рантайм-цикла): replay-члены API проецируются в клиентскую
// replay-поверхность (line/since/keyframe/frame) — replaySubscribe(client.func.key) без кастов
import type { IsReplayMember, InferArgs, ReplaySocketListen } from "./listen-deep";

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
    // data распаковываем симметрично errToObj (rich-типы: BigInt/Date/Map/Set). Для plain-JSON
    // unpackResult — identity, поэтому со старым сервером (сырой data) тоже корректно.
    const o2 = o.data !== undefined ? { ...o, data: unpackResult(o.data) } : o;
    const err = MyError.fromWire(o2);
    if (o.cause !== undefined) (err as any).cause = reviveErr(o.cause);
    return err;
};

function listenKeyArg(a: any): any {
    if (typeof a == "function") return "@fn";
    if (typeof a == "bigint") return {$_b: a.toString()};
    if (a instanceof Date) return {$_d: a.valueOf()};
    if (a instanceof Map) return {$_m: [...a.entries()].map(([k, v]) => [listenKeyArg(k), listenKeyArg(v)])};
    if (a instanceof Set) return {$_s: [...a.values()].map(listenKeyArg)};
    if (Array.isArray(a)) return a.map(listenKeyArg);
    if (a && typeof a == "object") {
        const out: any = {};
        for (const k of Object.keys(a).sort()) out[k] = listenKeyArg(a[k]);
        return out;
    }
    return a;
}

type tProxyEntry = {ref: WeakRef<object>; token: object}

function createPathProxyCache() {
    const values = new Map<string, tProxyEntry>()
    const registry = new FinalizationRegistry<{key: string; token: object}>(function releaseProxy(entry) {
        if (values.get(entry.key)?.token == entry.token) values.delete(entry.key)
    })

    function get(path: string[]) {
        const key = rpcPathKey(path)
        const proxy = values.get(key)?.ref.deref()
        if (!proxy) values.delete(key)
        return proxy
    }

    function set(path: string[], proxy: object) {
        const key = rpcPathKey(path)
        const token = {}
        values.set(key, {ref: new WeakRef(proxy), token})
        registry.register(proxy, {key, token})
        return proxy
    }

    return {get, set}
}
// Вспомогательные типы
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

export type DeepDataOnly<T> = T extends Function
    ? never
    : T extends readonly any[]
        // mapped tuple: кортежи сохраняются ([string, number] не деградирует в (string|number)[] —
        // важно для replay-конвертов {seq, ts, event: Z}); обычные массивы мапятся как раньше
        ? { [I in keyof T]: DeepDataOnly<T[I]> }
        : T extends object
            ? { [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]> }
            : T;

// --- 1. ТИПИЗАЦИЯ ДЛЯ ОБЫЧНЫХ ВЫЗОВОВ (БЕЗ PIPE) ---
export type ClientAPIAll<T> = {
    [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]:
        // replay-член (детекция как в listen-deep) → клиентская replay-поверхность,
        // структурно совместимая с ReplayRemote: replaySubscribe(client.func.key) без кастов
        IsReplayMember<T[K]> extends true
            ? ReplaySocketListen<InferArgs<T[K]>>
            : T[K] extends (...args: infer A) => infer R
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
    // replay-член — как в ClientAPIAll; уже спроецированный ReplaySocketListen (auto-путь,
    // ClientAPIStrict<DeepSocketListen<T>>) сюда не попадает (у него нет getSince) и мапится ниже
    IsReplayMember<NonFalsy<T[K]>> extends true
        ? ReplaySocketListen<InferArgs<NonFalsy<T[K]>>>
        : NonFalsy<T[K]> extends (...args: infer A) => infer R
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

function createClient<T extends object>(socket: SocketTmpl, key: string, opts?: { limit?: number; limits?: RpcLimits; dedupeListen?: boolean; token?: any; opt?: RpcOpt }) {
    const limit = opts?.limit ?? 10000;
    // opt-in: без опции limits поведение прежнее (ответы сервера не ограничиваются)
    const lim = opts?.limits ? resolveLimits(opts.limits) : undefined;
    const pool = sharedPool(socket, key);
    type tPending = {ok: Function; fail: Function; cbs: number[]; promise?: Promise<any>}
    const pending = new Map<number, tPending>();
    const callbacks = new Map<number, Function>();
    // компактные тики подписки: cbId → (shapeId → порядок ключей), задекларированные сервером в Pkt.SHAPE
    const compactShapes = new Map<number, string[][]>();
    let capsSent = false; // CAPS (свой битсет фич) шлём один раз по приходу первого MAP
    const clientCaps = optToCaps(opts?.opt); // что объявляем серверу (0 = ничего → сервер не уплотняет)
    let peerServerCaps: tCaps = 0; // что объявил сервер (для двусторонних будущих фич)
    // id отменённых запросов/колбэков: НЕ возвращаем в пул сразу — поздний RESP/CB_END
    // сервера по переиспользованному id угнал бы чужой новый запрос
    const zombies = new Set<number>();
    const retire = (id: number) => { zombies.add(id); };
    let disposed = false;
    // A direct createRpcClient owns no socket lifecycle and remains immediately usable.
    // createRpcClientHub explicitly switches this control to managed-offline until handshake.
    const transport = createTransportLifecycle(true)
    // onDisconnect: тонкий регистратор в стиле strictWaiters/authWaiters этого файла.
    // Зовётся ровно ОДИН раз из dispose() (teardown по разрыву/ротации). off()-хендл —
    // через makeOff; промис резолвится на самом дисконнекте.
    let disconnectCbs: ((reason: string) => void)[] = [];
    let disconnectResolve: (reason: string) => void = () => {};
    const disconnectPromise = new Promise<string>(res => { disconnectResolve = res; });
    function onDisconnect(cb: (reason: string) => void) {
        disconnectCbs.push(cb);
        function offDisconnect() { const i = disconnectCbs.indexOf(cb); if (i >= 0) disconnectCbs.splice(i, 1); }
        return makeOff(disconnectPromise, offDisconnect);
    }
    const routeCache: Record<string, number> = {};
    let schemaKnown = false
    let strictData: any = {};
    let strictWaiters: ((v: unknown) => void)[] = [];
    let debug = false;

    // --- in-band auth (Pkt.HELLO/authAck) ---
    let authToken: any = opts?.token ?? null;
    let authStatus: any = undefined; // последний authAck сервера; null = сервер без auth (4-эл. MAP)
    let authWaiters: ((s: any) => void)[] = [];
    let authPending = false; // идёт HELLO/reauth → auth() ждёт свежий ack, а не отдаёт прошлый
    const drainAuth = (s: any) => { authPending = false; const w = authWaiters; authWaiters = []; for (const r of w) r(s); };
    const setAuthStatus = (s: any) => { authStatus = s; drainAuth(s); };

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
            case Pkt.SHAPE: {
                // Поздняя shape от умершей transport-generation не должна создавать хвост состояния.
                if (!callbacks.has(msg[1])) break
                // сервер задекларировал форму компактных тиков для cbId: shapeId → порядок ключей
                let m = compactShapes.get(msg[1]);
                if (!m) { m = []; compactShapes.set(msg[1], m); }
                m[msg[2]] = msg[3];
                break;
            }
            case Pkt.CBV: {
                // компактный тик: восстанавливаем объект по форме + значениям и зовём колбэк как обычный CB
                const cb = callbacks.get(msg[1]);
                if (!cb) break;
                const keys = compactShapes.get(msg[1])?.[msg[2]];
                if (!keys) break;
                const vals = msg[3] || [];
                let obj: any;
                try { obj = {}; keys.forEach((k: string, i: number) => { obj[k] = unpackResult(vals[i], lim); }); }
                catch (e) { if (debug) console.log("[RPC CBV] dropped:", e); break; }
                cb(obj);
                break;
            }
            case Pkt.CB_END: {
                const cbId = msg[1] as number;
                compactShapes.delete(cbId);
                // release только если id наш (трекался) — чужой/поздний CB_END не должен
                // освобождать id, занятый другим запросом
                if (callbacks.delete(cbId)) pool.release(cbId);
                else if (zombies.delete(cbId)) pool.release(cbId);
                break;
            }
            case Pkt.CAPS: {
                // сервер объявил свой битсет договорных фич — запоминаем (двусторонняя половина
                // рукопожатия). Для COMPACT клиент не гейтит: CBV приходит лишь если МЫ объявили COMPACT.
                peerServerCaps = typeof msg[1] === "number" ? msg[1] : 0;
                break;
            }
            case Pkt.MAP: {
                schemaKnown = true
                // Чистим перед слиянием: при смене principal (re-auth) индексы routeMap другие —
                // устаревшая запись увела бы числовой ref на чужой метод.
                if (msg[1]) { for (const k of Object.keys(routeCache)) delete routeCache[k]; Object.assign(routeCache, msg[1]); }
                // A fresh declaration replaces the previous principal/connection schema.
                // Only declared Listen nodes are safe to recreate automatically: legacy
                // callback-shaped calls remain deduped, but are terminal on disconnect.
                if (Array.isArray(msg[3])) {
                    declaredListens = new Set(msg[3])
                    for (const sub of wireSubs.values()) {
                        sub.recoverable = declaredListens.has(rpcPathKey(sub.path.slice(0, -1)))
                    }
                }
                if (msg[2]) {
                    for (const k of Object.keys(strictData)) delete strictData[k];
                    Object.assign(strictData, msg[2]);
                    for (const r of strictWaiters) r(undefined);
                    strictWaiters = [];
                }
                // Ответ на HELLO ВСЕГДА 5-элементный (authAck или null для сервера без auth) — только он
                // трогает auth. 4-элементный MAP (STRICT/начальный пуш) схема-only: не резолвит auth(),
                // поэтому ожидающий auth() не словит преждевременный null от STRICT-компаньона.
                if (msg.length > 4) setAuthStatus(msg[4]);
                // CAPS один раз по приходу MAP: соединение установлено, сервер слушает, тики ещё не шли.
                // Здесь, а НЕ в init(): динамический c.func init() не вызывает (MAP сервер пушит сам).
                // Шлём CAPS только если есть что объявить: clientCaps==0 (opt.compact:false) → молчим,
                // чтобы и СТАРЫЙ сервер (трактует сам факт CAPS как «умею компакт») остался на обычном CB.
                if (!capsSent) { capsSent = true; if (clientCaps) socket.emit(key, [Pkt.CAPS, clientCaps]); }
                break;
            }
        }
    });

    const sendPipe = (path: string[], steps: any[], wait: boolean): any => {
        if (disposed) return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve()
        if (!transport.api.connected()) return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve()
        const cbIds: number[] = [];
        // Упаковываем аргументы во всех шагах вызова (call)
        const cleanSteps = steps.map(step => {
            if (step.type === 'call') {
                return { type: 'call', args: pack(step.args, pool, callbacks, cbIds) };
            }
            return step;
        });
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path;

        if (!wait) {
            socket.emit(key, [Pkt.PIPE, 0, ref, cleanSteps, false]);
            return Promise.resolve();
        }
        // Идиома off() НЕ распространяется на PIPE — осознанная граница слоёв:
        //   1) pipe-прокси ЛЕНИВ: buildPipeProxy отдаёт прокси-цепочку, а sendPipe
        //      вызывается лишь из геттера `.then`/`.catch` (для await) — любой makeOff-хендл
        //      здесь до вызывающего НЕ доходит (его сразу оборачивает `(...a)=>p.then(...a)`).
        //   2) протокол PIPE не даёт адресуемой точки teardown для непрозрачной цепочки:
        //      один RESP, без серверного стопа (контраст с CALL `removeCallback`).
        // Долгоживущие подписки с off() живут на CALL/listen-поверхности (subscribeShared
        // + makeOff). PIPE — для трансформаций; богатые типы/лимиты в нём уже на паритете с CALL.
        let record: tPending | undefined
        const promise = new Promise(function trackPipe(resolve, reject) {
            if (pending.size >= limit) { reject(new Error('RPC limit')); return }
            const reqId = pool.next()
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
            if (debug) console.log('[RPC PIPE]', path.join('.'), 'steps=', steps.length, 'id=', reqId)
            socket.emit(key, [Pkt.PIPE, reqId, ref, cleanSteps])
        })
        if (record) record.promise = promise
        return promise
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

    type tCallAttempt = {promise: Promise<any>; abandon: (reason: string) => void}

    function createCallAttempt(path: string[], args: any[]): tCallAttempt {
        if (disposed) {
            return {promise: Promise.reject(new Error('RPC client disposed')), abandon: function abandonDisposed() {}}
        }
        if (!transport.api.connected()) {
            return {promise: Promise.reject(new Error('RPC transport disconnected')), abandon: function abandonOffline() {}}
        }
        if (pending.size >= limit) {
            return {promise: Promise.reject(new Error('RPC limit')), abandon: function abandonLimited() {}}
        }

        const cbIds: number[] = []
        const clean = pack(args, pool, callbacks, cbIds)
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
        const reqId = pool.next()
        let record!: tPending
        const promise = new Promise(function trackCall(resolve, reject) {
            record = {ok: resolve, fail: reject, cbs: cbIds}
            pending.set(reqId, record)
        })
        record.promise = promise
        if (debug) console.log('[RPC]', path.join('.'), 'id=', reqId)
        socket.emit(key, [Pkt.CALL, reqId, ref, clean])

        function abandon(reason: string) {
            if (pending.get(reqId) != record) return
            pending.delete(reqId)
            for (const cbId of cbIds) {
                callbacks.delete(cbId)
                compactShapes.delete(cbId)
            }
            // Wire protocol has no generation field: an abandoned id is deliberately
            // never reused, so a late packet cannot settle a new request.
            record.fail(new Error(reason))
        }
        return {promise, abandon}
    }

    function sendCallWire(path: string[], args: any[], wait: boolean): any {
        if (disposed) return wait ? Promise.reject(new Error('RPC client disposed')) : Promise.resolve()
        if (!transport.api.connected()) return wait ? Promise.reject(new Error('RPC transport disconnected')) : Promise.resolve()
        if (wait) return createCallAttempt(path, args).promise

        const cbIds: number[] = []
        const clean = pack(args, pool, callbacks, cbIds)
        const ref: number | string[] = routeCache[rpcPathKey(path)] ?? path
        socket.emit(key, [Pkt.CALL, 0, ref, clean, false])
        return Promise.resolve()
    }

    // ===================================================================
    // Logical Listen subscriptions survive a transient transport generation.
    // Only their physical CALL attempt is replaced after reconnect.
    // ===================================================================
    const dedupe = opts?.dedupeListen ?? true
    type tConsumer = {fns: Function[]; resolve: () => void}
    type tWireAttempt = {call: tCallAttempt}
    type tSub = {
        key: string
        path: string[]
        realArgs: any[]
        consumers: Set<tConsumer>
        attempt: tWireAttempt | null
        recoverable: boolean
        ended: boolean
        stop: (socketAlive?: boolean) => void
    }
    const wireSubs = new Map<string, tSub>()
    // адреса Listen-узлов, задекларированные сервером в Pkt.MAP; null = старый сервер (без декларации)
    let declaredListens: Set<string> | null = null

    function finishLogical(sub: tSub) {
        if (sub.ended) return
        sub.ended = true
        sub.attempt = null
        if (wireSubs.get(sub.key) == sub) wireSubs.delete(sub.key)
        for (const consumer of sub.consumers) consumer.resolve()
        sub.consumers.clear()
    }

    function finishAttempt(sub: tSub, attempt: tWireAttempt) {
        if (sub.attempt != attempt) return
        sub.attempt = null
        finishLogical(sub)
    }

    function startAttempt(sub: tSub) {
        if (disposed || sub.ended || sub.attempt || sub.consumers.size == 0 || !transport.api.connected()) return
        const attempt: tWireAttempt = {call: createCallAttempt(sub.path, sub.realArgs)}
        sub.attempt = attempt
        attempt.call.promise.then(
            function physicalListenEnded() { finishAttempt(sub, attempt) },
            function physicalListenFailed() { finishAttempt(sub, attempt) },
        )
    }

    function stopLogical(sub: tSub, socketAlive = transport.api.connected()) {
        if (sub.ended) return
        const attempt = sub.attempt
        sub.attempt = null
        if (wireSubs.get(sub.key) == sub) wireSubs.delete(sub.key)
        sub.ended = true
        if (socketAlive && transport.api.connected()) {
            sendCallWire([...sub.path.slice(0, -1), 'removeCallback'], [], false)
        } else {
            attempt?.call.abandon('RPC Listen stopped while transport is disconnected')
        }
        for (const consumer of sub.consumers) consumer.resolve()
        sub.consumers.clear()
    }

    function subscribeShared(path: string[], args: any[]) {
        if (disposed) return Promise.reject(new Error('RPC client disposed'))
        const listenPathKey = rpcPathKey(path.slice(0, -1))
        const skey = listenPathKey + '::' + JSON.stringify(args.map(listenKeyArg))
        let sub = wireSubs.get(skey)
        if (!sub) {
            let fnPos = 0
            const created = {
                key: skey,
                path: [...path],
                realArgs: [] as any[],
                consumers: new Set<tConsumer>(),
                attempt: null,
                recoverable: declaredListens?.has(listenPathKey) == true,
                ended: false,
                stop: function stopCreated(socketAlive?: boolean) { stopLogical(created, socketAlive) },
            } satisfies tSub
            created.realArgs = args.map(function buildMultiplexer(arg) {
                if (typeof arg != 'function') return arg
                const index = fnPos++
                return function multicastListenEvent(...event: any[]) {
                    let error: any
                    for (const consumer of created.consumers) {
                        try { consumer.fns[index]?.(...event) }
                        catch (caught) { error ??= caught }
                    }
                    if (error != undefined) setTimeout(function rethrowConsumerError() { throw error }, 0)
                }
            })
            wireSubs.set(skey, created)
            sub = created
        }

        const consumer: tConsumer = {
            fns: args.filter(a => typeof a == 'function') as Function[],
            resolve: function resolveLater() {},
        }
        sub.consumers.add(consumer)
        const promise = new Promise<void>(function waitForListenEnd(resolve) { consumer.resolve = resolve })
        startAttempt(sub)

        function unsubscribe() {
            if (!sub!.consumers.delete(consumer)) return
            consumer.resolve()
            if (sub!.consumers.size == 0) sub!.stop()
        }
        return makeOff(promise, unsubscribe, {off: unsubscribe, unsubscribe, removeCallback: unsubscribe})
    }

    // Arbitrary calls are never retried. Only logical Listen entries remain and
    // receive one fresh physical attempt after the next completed handshake.
    function abandonTransportGeneration(reason: string) {
        for (const sub of [...wireSubs.values()]) {
            const attempt = sub.attempt
            sub.attempt = null
            attempt?.call.abandon(reason)
            // An old server gives only a callback-shaped heuristic. Reissuing such
            // a call could repeat a side effect, so only a declared Listen survives.
            if (!sub.recoverable) finishLogical(sub)
        }

        const error = new Error(reason)
        for (const [id, request] of [...pending]) {
            pending.delete(id)
            for (const cbId of request.cbs) {
                callbacks.delete(cbId)
                compactShapes.delete(cbId)
            }
            // A transport teardown creates this rejection inside the library. Mark
            // the original Promise handled so an intentionally ignored call cannot
            // crash Node; await/catch on that same Promise still observes the reject.
            request.promise?.catch(function consumeAbandonedTransportReject() {})
            // No pool.release(): late wire packets carry no generation and must
            // never be able to target a newer call which reused this id.
            request.fail(error)
        }
        callbacks.clear()
        compactShapes.clear()
    }

    function transportDisconnected(reason: string) {
        abandonTransportGeneration('RPC transport disconnected: ' + reason)
        schemaKnown = false
        capsSent = false
        peerServerCaps = 0
        declaredListens = declaredListens ? new Set() : null
        for (const route of Object.keys(routeCache)) delete routeCache[route]
        authStatus = undefined
        authPending = false
        const strict = strictWaiters
        strictWaiters = []
        for (const resolve of strict) resolve(undefined)
        const auths = authWaiters
        authWaiters = []
        for (const resolve of auths) resolve({ok: false, reason})
    }

    function transportConnected() {
        for (const sub of [...wireSubs.values()]) {
            if (sub.recoverable) startAttempt(sub)
            else finishLogical(sub)
        }
    }

    transport.api.onDisconnect(transportDisconnected)
    transport.api.onConnect(transportConnected)

    const sendCall = (path: string[], args: any[], wait: boolean): any => {
        const last = path[path.length - 1];
        // `.on(fn)` и `.callback(fn)` — обе «подписка по факту установки колбэка». Имя НЕ переписываем:
        // `.on` уходит проводом КАК `.on` (сервер имеет оба метода). Дедуп — по АДРЕСУ УЗЛА
        // (см. subscribeShared), поэтому on/callback на один Listen-узел делят одну сетевую подписку.
        if (dedupe && wait && path.length > 1 && (last == "callback" || last == "on") && args.some(a => typeof a == "function")) {
            // New calls made offline are never deferred into the next connection.
            if (!transport.api.connected()) return sendCallWire(path, args, wait)
            // точно: сервер задекларировал адрес как Listen (Pkt.MAP[3]);
            // fallback для старого сервера — эвристика по форме маршрута `*.callback(fn)`/`*.on(fn)`
            const isListen = declaredListens ? declaredListens.has(rpcPathKey(path.slice(0, -1))) : true;
            if (isListen) return subscribeShared(path, args);
        }
        return sendCallWire(path, args, wait);
    };

    function lookupRpcMemberState(path: string[], member: string) {
        if (!schemaKnown) return undefined
        const memberPath = [...path, member]
        const memberKey = rpcPathKey(memberPath)
        if (Object.prototype.hasOwnProperty.call(routeCache, memberKey)) return true
        if (declaredListens?.has(memberKey)) return true
        const target = resolveStrictTarget(memberPath)
        if (target == 'dynamic') return undefined
        return target != undefined && target != null && target != 'null'
    }

    function createRpcMemberLookup(path: string[]) {
        const lookup = function lookupRpcMember(member: string) { return lookupRpcMemberState(path, member) }
        Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
        return lookup
    }

    const proxyCaches = {
        func: createPathProxyCache(),
        space: createPathProxyCache(),
        strict: createPathProxyCache(),
    } as const

    function buildProxy(path: string[], wait: boolean, cache: ReturnType<typeof createPathProxyCache>): any {
        const cached = cache.get(path)
        if (cached) return cached
        const proxy = new Proxy(function () {}, {
            get(_, p: string | symbol) {
                if (p == RPC_MEMBER_LOOKUP) return createRpcMemberLookup(path)
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive) return undefined
                return buildProxy([...path, String(p)], wait, cache)
            },
            apply(_, __, args) {
                const [fp, fa] = resolveCA(path, args)
                return sendCall(fp, fa, wait)
            },
        })
        return cache.set(path, proxy)
    }

    function resolveStrictTarget(path: string[]) {
        let target: any = strictData
        for (const segment of path) {
            if (target == 'dynamic') return target
            target = target?.[segment]
            if (target == null || target == 'null') return undefined
        }
        return target
    }

    function buildStrict(path: string[], wait: boolean): any {
        const initialTarget = resolveStrictTarget(path)
        if (initialTarget == null || initialTarget == 'null') return undefined
        const cached = proxyCaches.strict.get(path)
        if (cached) return cached
        // A Proxy target cannot change callability after creation. Keep every cached strict
        // path callable internally, while apply validates the current schema dynamically.
        const target = () => {}
        const proxy = new Proxy(target, {
            has: (_, p) => {
                const target = resolveStrictTarget(path)
                return target == 'dynamic' || (target?.[String(p)] != 'null' && target?.[String(p)] != undefined)
            },
            ownKeys: () => {
                const target = resolveStrictTarget(path)
                return target && typeof target == 'object' ? Object.keys(target) : []
            },
            getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true}),
            getPrototypeOf: () => {
                const target = resolveStrictTarget(path)
                return target == 'func' || target == 'dynamic' ? Function.prototype : target ? null : Object.prototype
            },
            get(_, p: string | symbol) {
                if (p == RPC_MEMBER_LOOKUP) return createRpcMemberLookup(path)
                if (p == RPC_TRANSPORT_LIFECYCLE) return transport.api
                if (p == 'then' || p == 'catch' || p == Symbol.toPrimitive) return undefined
                const target = resolveStrictTarget(path)
                if (p == 'call' && target == 'func') {
                    return function strictCall(_: any, ...args: any[]) { return sendCall(path, args, wait) }
                }
                if (target == 'func') return undefined
                if (target != 'dynamic') {
                    const child = target?.[String(p)]
                    if (child == 'null' || child == undefined) return undefined
                }
                return buildStrict([...path, String(p)], wait)
            },
            apply(_, __, args) {
                const target = resolveStrictTarget(path)
                if (target != 'func' && target != 'dynamic') {
                    throw new TypeError('RPC strict path is not callable')
                }
                const [fp, fa] = resolveCA(path, args)
                return sendCall(fp, fa, wait)
            },
        })
        return proxyCaches.strict.set(path, proxy)
    }

    const releaseCbs = (fn: Function) => {
        callbacks.forEach((cb, id) => { if (cb == fn) { callbacks.delete(id); retire(id); } });
    };

    function abortAll(reason: string) {
        const err = {error: {name: 'RPC_ABORT', message: reason}}
        pending.forEach(function abortPending(p, id) {
            retire(id)
            for (const cbId of p.cbs) compactShapes.delete(cbId)
            p.fail(err)
        })
        pending.clear()
        callbacks.forEach(function abortCallback(_, id) { retire(id) })
        callbacks.clear()
        compactShapes.clear()
    }

    // Hard teardown finishes logical consumers; transient disconnect never calls this.
    function drainWireSubs(socketAlive: boolean) {
        const subs = [...wireSubs.values()]
        wireSubs.clear()
        for (const sub of subs) sub.stop(socketAlive)
    }

    // отцепить клиента: отклонить висящие, игнорировать дальнейшие пакеты, отбивать новые вызовы.
    // socketAlive (default true) — слать ли wire removeCallback; на заведомо мёртвом сокете
    // передай { socketAlive: false } (потребители всё равно резолвятся).
    function dispose(reason = 'RPC client disposed', opts?: {socketAlive?: boolean}) {
        if (disposed) return
        const socketAlive = opts?.socketAlive ?? true
        // Wire removeCallback must be emitted before disposed blocks outgoing calls.
        drainWireSubs(socketAlive)
        abortAll(reason)
        disposed = true
        transport.control.close(reason)
        authPending = false
        const sw = strictWaiters
        strictWaiters = []
        for (const resolve of sw) resolve(undefined)
        const aw = authWaiters
        authWaiters = []
        for (const resolve of aw) resolve({ok: false, reason})
        const dc = disconnectCbs
        disconnectCbs = []
        for (const cb of dc) try { cb(reason) } catch {}
        disconnectResolve(reason)
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

    const func = buildProxy([], true, proxyCaches.func) as ClientAPIAll<T>;
    const space = buildProxy([], false, proxyCaches.space) as ClientAPIAll<T>
    const strict = buildStrict([], true) as ClientAPIStrict<T>
    const pipe = buildPipeProxy([], [], true) as PipeAPI<T>;
    const pipeStrict = buildPipeProxy([], [], true) as PipeAPI<T>; // пока ≡ pipe — строгая валидация не реализована (PLAN: API honesty)

    let _ready: null | Promise<void> = null;
    let ready = () => _ready ? _ready : _ready = init()
    const init = async (obj?: object) => {
        if (obj) { strictData = obj; schemaKnown = true; return; }
        // с токеном — предъявляем его (HELLO); ответ на HELLO всегда придёт 5-элементным (ack/null).
        if (authToken != null) { authPending = true; socket.emit(key, [Pkt.HELLO, authToken]); }
        // STRICT всегда: запрос схемы и fallback для СТАРОГО сервера, который HELLO не знает (не зависнем).
        socket.emit(key, Pkt.STRICT);
        await new Promise(r => { strictWaiters.push(r); });
    }

    // Мягкий re-auth по ЖИВОМУ сокету: подписки не рвутся (тот же socket, те же cb-id);
    // сервер пере-verify и шлёт новый MAP (routeMap нового principal) + authAck.
    // ВНИМАНИЕ: не запускай конкурентные reauth — вейтеры общие, без корреляции; дожидайся каждый.
    function reauth(token: any) {
        if (disposed) return Promise.resolve({ok: false, reason: 'RPC client disposed'})
        if (!transport.api.connected()) return Promise.resolve({ok: false, reason: 'RPC transport disconnected'})
        authToken = token;
        authPending = true;
        socket.emit(key, [Pkt.HELLO, token]);
        return new Promise<any>(res => authWaiters.push(res));
    }
    // Текущий authAck (null = сервер без auth); во время идущего reauth ждёт свежий, а не отдаёт прошлый.
    // После dispose резолвимся сразу (иначе вейтер никогда не дренится — MAP уже игнорируется).
    const auth = () => disposed
        ? Promise.resolve(authStatus !== undefined ? authStatus : { ok: false, reason: "RPC client disposed" })
        : (authStatus !== undefined && !authPending) ? Promise.resolve(authStatus) : new Promise<any>(res => authWaiters.push(res));

    return {
        func,           // <- Тип ClientAPI (нет цепочек)
        pipe,           // <- Тип PipeAPI (есть цепочки)
        pipeStrict,     // <- Тип PipeAPI (есть цепочки)
        space,
        all: func as ClientAPIAll<T>,
        strict, // <- Тип ClientAPI (нет цепочек)
        api,
        [RPC_TRANSPORT_CONTROL]: transport.control,
        abortAll,
        dispose,
        /** Закрыть клиента (универсальный teardown, парный к onDisconnect): дренирует подписки,
         *  отклоняет висящие, снимает ожидающих. Делегирует в {@link dispose}; продвинутый
         *  `{ socketAlive:false }` — там же. */
        close: dispose,
        schema: () => strictData,
        readyStrict: ready,
        /** Дождаться рукопожатия/схемы (STRICT). Делегирует в {@link readyStrict}. */
        ready,
        initStrict: init,
        /** Инициализировать клиента (HELLO+STRICT) либо засеять схему объектом. Делегирует в {@link initStrict}. */
        init,
        /** Мягкий re-auth по живому сокету (подписки сохраняются). Резолвится новым authAck. */
        reauth,
        /** Текущий authAck сервера; ждёт первого/свежего. Резолвится null против сервера без auth. */
        auth,
        /** Наблюдать teardown клиента (dispose/разрыв/ротация). Callable off-хендл; await — на
         *  дисконнекте. Подписки к этому моменту уже сняты (честный teardown, без авто-resubscribe). */
        onDisconnect,
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
    /** Отцепить клиента: висящие отклоняются, дальнейшие пакеты игнорируются, новые вызовы отбиваются.
     *  Подписки дренируются (честный teardown). На заведомо мёртвом сокете — `{ socketAlive: false }`.
     *  @deprecated используй {@link close} — тот же teardown с той же сигнатурой. */
    dispose: (reason?: string, opts?: { socketAlive?: boolean }) => void;
    /** Закрыть клиента (универсальный teardown, парный к onDisconnect). Делегирует в {@link dispose}. */
    close: (reason?: string, opts?: { socketAlive?: boolean }) => void;
    schema: () => any;
    /** @deprecated используй {@link ready} — суффикс Strict не несёт смысла (нет не-strict варианта). */
    readyStrict: () => Promise<void>;
    /** Дождаться рукопожатия/схемы. Делегирует в {@link readyStrict}. */
    ready: () => Promise<void>;
    /** @deprecated используй {@link init} — суффикс Strict не несёт смысла (нет не-strict варианта). */
    initStrict: (obj?: object) => Promise<void>;
    /** Инициализировать клиента либо засеять схему объектом. Делегирует в {@link initStrict}. */
    init: (obj?: object) => Promise<void>;
    /** Мягкий re-auth по живому сокету: предъявляет новый токен, подписки сохраняются. */
    reauth: (token: any) => Promise<any>;
    /** Текущий authAck сервера (5-й элемент Pkt.MAP); резолвится null против сервера без auth. */
    auth: () => Promise<any>;
    /** Наблюдать teardown клиента (dispose/разрыв/ротация). Callable off-хендл; await — на дисконнекте. */
    onDisconnect: (cb: (reason: string) => void) => ReturnType<typeof makeOff>;
};

export function createRpcClient<T extends object>({ socket, socketKey: key, limit, limits, dedupeListen, token, opt }: {
    socket: SocketTmpl; socketKey: string; limit?: number;
    /** Opt-in лимиты на ВХОДЯЩИЕ данные (ответы/колбэки сервера); без опции — как раньше, без ограничений. */
    limits?: RpcLimits;
    /** Дедуп подписок (по умолчанию ВКЛЮЧЁН): одно сетевое соединение на Listen-адрес,
     *  новые потребители ретранслируются локально, сетевой стоп — после ухода последнего.
     *  Подписка (`*.on(cb)`, legacy `*.callback(cb)`) возвращает callable off-handle с `.off()/.unsubscribe()`. */
    dedupeListen?: boolean;
    /** Токен авторизации: при initStrict() клиент предъявит его через Pkt.HELLO (in-band auth).
     *  In-band auth подразумевает ОДИН логический клиент на socket+key (модель хаба): два
     *  токен-клиента на одном сокете затирали бы routeCache/authAck друг друга при смене principal. */
    token?: any;
    /** Оптимизации провода (договариваются рукопожатием): { compact?: false } отключает
     *  адаптивное уплотнение тиков (Pkt.SHAPE/CBV) для этого соединения. По умолчанию — вкл. */
    opt?: RpcOpt;
}): RpcClientReturn<T> {
    return createClient<T>(socket, key, { limit, limits, dedupeListen, token, opt });
}

export type { ClientApiHandle };
