import {isNoStrict} from "./rpc-dynamic";
import { isSafeKey, resolveLimits, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import {unpack, errToObj, packResult} from "./rpc-walk";
import { isPlainObject, createCbShapeServer } from "./rpc-shape";
import { Pkt, IS_RPC_LISTEN, type SocketTmpl } from "./rpc-protocol";
import { Caps, hasCap, optToCaps, type tCaps, type RpcOpt } from "./rpc-caps";
import { MyError } from "../../toError/myThrow";

type Func = (...args: any[]) => any;

type PromiseServerHooks<T> = {
    onRequest?: (ctx: { key: string[]; request: any[]; fnName: string; fn: Func }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: { reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit"; key?: any; request?: any; error?: any }) => void | Promise<void>;
    resolveTransform?: (value: any) => any;
};

// In-band авторизация (P3 «подтверждение»): клиент шлёт Pkt.HELLO с токеном, сервер его
// проверяет и (опц.) подменяет обслуживаемый объект на фасад этого principal, затем шлёт
// Pkt.MAP с authAck. Без auth поведение прежнее. Источник токена и admission — вне ядра.
type RpcServerAuth = {
    /** token → { object?: фасад principal, ack?: что отдать клиенту в authAck }. throw/ack.ok===false = отказ. */
    resolveAuth: (token: any) => { object?: any; ack?: any } | Promise<{ object?: any; ack?: any }>;
    /** true → до успешного HELLO CALL/PIPE отклоняются ("Unauthorized").
     *  ОБЯЗАТЕЛЕН для контроля доступа: без gate начальный `object` вызывается ДО HELLO,
     *  а его схема раскрывается в ответ на STRICT — поэтому начальный `object` держи ПУСТЫМ,
     *  а защищённую поверхность отдавай фасадом из resolveAuth(principal). */
    gate?: boolean;
};

// Повторный createRpcServer на том же сокете+ключе раньше ДОБАВЛЯЛ второй socket.on
// (каждый запрос исполнялся дважды). SocketTmpl не умеет off → последний выигрывает,
// предыдущий обработчик становится инертным.
const SERVERS = new WeakMap<object, Map<string, () => void>>();

function createServer<T extends object>(
    socket: SocketTmpl,
    key: string,
    target: T,
    hooks?: PromiseServerHooks<T>,
    limits?: RpcLimits,
    auth?: RpcServerAuth,
    opt?: RpcOpt,
) {
    const lim = resolveLimits(limits);
    const IS_RPC_PIPE = Symbol.for("isRpcPipe");

    function transformTree(obj: any): any {
        let current = obj;
        if (hooks?.resolveTransform && !isNoStrict(current)) {
            current = hooks.resolveTransform(current);
        }
        if (current == null || typeof current != "object" || isNoStrict(current)) return current;
        const out: any = {};
        if ((current as any)[IS_RPC_LISTEN]) out[IS_RPC_LISTEN] = true; // пометка — Symbol, Object.keys её не копирует
        for (const k of Object.keys(current)) {
            if (!isSafeKey(k)) continue;
            const v = current[k];
            if (isNoStrict(v)) { out[k] = v; continue; }
            // функции тоже прогоняем через resolveTransform: bare `on`-функция (в реестре по WeakMap)
            // превращается в Listen-обёртку; обычная функция возвращается как есть → поведение прежнее.
            out[k] = typeof v == "function" ? (hooks?.resolveTransform ? hooks.resolveTransform(v) : v)
                : v != null && typeof v == "object" ? transformTree(v) : v;
        }
        return out;
    }

    function serialize(obj: any): any {
        const out: any = {};
        for (const k of Object.keys(obj)) {
            if (!isSafeKey(k)) continue;
            const v = obj[k];
            switch (true) {
                case v == null:              out[k] = "null";    break;
                case isNoStrict(v):          out[k] = "dynamic"; break;
                case typeof v == "function": out[k] = "func";    break;
                case typeof v == "object":   out[k] = serialize(v); break;
                default:                     out[k] = "unknown"; break;
            }
        }
        return out;
    }

    // Таблицы диспетчеризации перестраиваются при смене principal (re-auth) → держим в let.
    let methods: Function[] = [];
    let contexts: any[] = [];
    let routeMap: Record<string, number> = {};
    let listenPaths: string[] = []; // адреса Listen-узлов — декларируются клиенту в Pkt.MAP (4-й элемент)
    let strictSchema: any = {};
    let currentTarget: any = target; // активный объект (фасад текущего principal)

    function buildDispatch(t: any) {
        const m: Function[] = [], cx: any[] = [], rm: Record<string, number> = {}, lp: string[] = [];
        const resolved = transformTree(t);
        (function index(obj: any, prefix: string) {
            for (const k of Object.keys(obj)) {
                if (!isSafeKey(k)) continue;
                const v = obj[k];
                const path = prefix ? prefix + "." + k : k;
                if (typeof v == "function") { rm[path] = m.length; m.push(v); cx.push(obj); }
                else if (v && typeof v == "object" && !isNoStrict(v)) {
                    if ((v as any)[IS_RPC_LISTEN]) lp.push(path);
                    index(v, path);
                }
            }
        })(resolved, "");
        methods = m; contexts = cx; routeMap = rm; listenPaths = lp; strictSchema = serialize(resolved); currentTarget = t;
    }
    buildDispatch(target);

    const send = (d: any) => socket.emit(key, d);

    // Адаптивное уплотнение тиков подписки. Договорное: эффективно, ТОЛЬКО если оба пира
    // объявили Caps.COMPACT (serverCaps из opt, peerCaps из клиентского Pkt.CAPS).
    // sendCb: частый объект одной формы → Pkt.SHAPE(один раз) + Pkt.CBV(значения); иначе обычный Pkt.CB.
    const serverCaps = optToCaps(opt);
    let peerCaps: tCaps = 0;
    const compactOn = () => hasCap(serverCaps & peerCaps, Caps.COMPACT);
    const cbShapes = createCbShapeServer();
    const sendCb = (cbId: number, cbArgs: any[]) => {
        if (compactOn() && cbArgs.length == 1 && isPlainObject(cbArgs[0])) {
            const obj = cbArgs[0];
            const r = cbShapes.offer(cbId, obj);
            if (r.mode == "register") { send([Pkt.SHAPE, cbId, r.shapeId, r.keys]); send([Pkt.CBV, cbId, r.shapeId, r.keys.map(k => packResult(obj[k]))]); return; }
            if (r.mode == "compact") { send([Pkt.CBV, cbId, r.shapeId, r.keys.map(k => packResult(obj[k]))]); return; }
        }
        send([Pkt.CB, cbId, cbArgs.map(packResult)]);
    };
    const sendCbEnd = (cbId: number) => { cbShapes.drop(cbId); send([Pkt.CB_END, cbId]); };

    // gate=true → до успешного HELLO вызовы отклоняются; без auth — открыто, как раньше.
    let authed = !auth?.gate;
    let authAck: any = undefined;
    // 5-й элемент MAP появляется ТОЛЬКО когда есть authAck — иначе провод байт-в-байт как раньше.
    const sendMap = () => send(authAck !== undefined
        ? [Pkt.MAP, routeMap, strictSchema, listenPaths, authAck]
        : [Pkt.MAP, routeMap, strictSchema, listenPaths]);
    sendMap();
    // Объявляем СВОИ договорные фичи один раз (половина «ask» рукопожатия): новый клиент
    // запомнит (peerServerCaps), старый — незнакомый Pkt.CAPS просто игнорирует.
    if (serverCaps) send([Pkt.CAPS, serverCaps]);

    let detached = false;
    let byKey = SERVERS.get(socket);
    if (!byKey) { byKey = new Map(); SERVERS.set(socket, byKey); }
    const detachPrev = byKey.get(key);
    if (detachPrev) {
        detachPrev();
        console.warn(`[RPC] createRpcServer: повторная инициализация на socket+key "${key}" — предыдущий сервер отцеплен`);
    }
    byKey.set(key, () => { detached = true; });

    socket.on(key, async (msg: any) => {
        if (detached) return;
        if (msg == Pkt.STRICT) { sendMap(); return; }
        // CAPS: клиент объявил свой битсет фич. Легаси-клиент шлёт [CAPS,1]=COMPACT. Старый
        // сервер игнорировал значение; теперь читаем его и пересекаем с serverCaps (compactOn()).
        if (Array.isArray(msg) && msg[0] === Pkt.CAPS) { peerCaps = typeof msg[1] === "number" ? msg[1] : Caps.COMPACT; return; }
        // HELLO: in-band авторизация. Без стратегии auth — игнор (старый клиент против сервера без auth).
        if (Array.isArray(msg) && msg[0] === Pkt.HELLO) {
            // Сервер без auth: ответ на HELLO всё равно 5-элементный (authAck=null) — чтобы клиент
            // отличил «ответ на HELLO» от 4-элементного STRICT и не висел/не путал их.
            if (!auth?.resolveAuth) { send([Pkt.MAP, routeMap, strictSchema, listenPaths, null]); return; }
            try {
                const r: any = await auth.resolveAuth(msg[1]);
                if (r && r.object !== undefined) buildDispatch(r.object); // фасад нового principal
                authAck = r && r.ack !== undefined ? r.ack : { ok: true };
                authed = authAck?.ok !== false;
                sendMap(); // principal-specific routeMap + authAck
            } catch (e: any) {
                // Отказ reauth НЕ роняет уже живую сессию: principal/authed/routeMap не трогаем,
                // лишь сообщаем клиенту ok:false локальным ack (его reauth() так и резолвится).
                send([Pkt.MAP, routeMap, strictSchema, listenPaths, { ok: false, reason: e?.message ?? String(e) }]);
            }
            return;
        }
        if (!Array.isArray(msg) || (msg[0] !== Pkt.CALL && msg[0] !== Pkt.PIPE)) return;

        const isPipe = msg[0] === Pkt.PIPE;
        const [, reqId, ref, rawArgsOrSteps, w] = msg;
        const wait = w !== false;

        if (typeof reqId !== "number" || !Number.isFinite(reqId)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "reqId is not a valid number" });
            return;
        }
        if (!authed) { // gate: вызовы до успешного HELLO
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new MyError("Unauthorized", "E_UNAUTHORIZED"))]);
            return;
        }
        if (typeof ref !== "number" && !Array.isArray(ref)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "ref must be number or string[]" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid ref type"))]);
            return;
        }
        if (!Array.isArray(rawArgsOrSteps)) {
            hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "args/steps must be an array" });
            if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Invalid args: expected array"))]);
            return;
        }

        try {
            let fn: Function | undefined, ctx: any;

            if (typeof ref == "number") {
                fn = methods[ref]; ctx = contexts[ref];
            } else {
                if (!ref.every((s: any) => typeof s == "string" && isSafeKey(s))) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps });
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Forbidden path segment"))]);
                    return;
                }
                if (ref.length > lim.maxPathLen) {
                    hooks?.onInvalid?.({ reason: "invalid_payload", key: ref, request: rawArgsOrSteps, error: "path too long" });
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new PayloadLimitError("path too long"))]);
                    return;
                }
                const idx = routeMap[ref.join(".")];
                if (idx !== undefined) {
                    fn = methods[idx]; ctx = contexts[idx];
                } else {
                    let curr: any = currentTarget;
                    for (let i = 0; i < ref.length - 1; i++) {
                        const seg = ref[i];
                        if (curr == null || typeof curr !== "object" || !(seg in curr)) { curr = undefined; break; }
                        curr = curr[seg];
                        if (hooks?.resolveTransform && !isNoStrict(curr)) curr = hooks.resolveTransform(curr);
                    }
                    const last = ref[ref.length - 1];
                    if (curr != null && typeof curr == "object") {
                        ctx = curr;
                        fn = last in curr ? curr[last] : undefined;
                    }
                }
            }
            if (typeof fn !== "function") {
                hooks?.onInvalid?.({ reason: "not_function", key: ref, request: rawArgsOrSteps });
                if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Not a function: " + ref))]);
                return;
            }

            if (hooks?.onRequest) {
                const keyArr = typeof ref == "number"
                    ? Object.keys(routeMap).find(k => routeMap[k] == ref)?.split(".") ?? []
                    : ref;
                const allowed = await hooks.onRequest({ key: keyArr, request: rawArgsOrSteps, fnName: keyArr[keyArr.length - 1] ?? "", fn: fn as Func });
                if (allowed == false) {
                    if (wait) send([Pkt.RESP, reqId, null, errToObj(new Error("Rejected by hook"))]);
                    return;
                }
            }

            if (isPipe) {
                // --- ЛОГИКА PIPE (КОНВЕЙЕР) ---
                const steps = rawArgsOrSteps as any[];
                let current: any = fn.bind(ctx);

                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];

                    if (current && typeof current === "object" && current[IS_RPC_PIPE]) {
                        const remainingSteps = steps.slice(i);
                        current = current.__executeRemainingPipe(remainingSteps);
                        break; 
                    }

                    if (current && typeof current.then === "function") {
                        current = await current;
                    }

                    if (step.type === 'get') {
                        if (current == null) throw new Error(`Cannot read property '${step.prop}' of ${current}`);
                        current = current[step.prop];
                    } else if (step.type === 'call') {
                        if (typeof current !== "function") throw new Error("Attempted to call a non-function in pipe");
                        // как в CALL: иначе Date/Map/BigInt в аргументах колбэка гибнут на JSON-транспорте
                        const stepArgs = unpack(step.args, sendCb, sendCbEnd, lim);
                        current = current(...stepArgs);
                    }
                }
                
                if (current && typeof current.then === "function") {
                    current = await current;
                }
                if (wait) send([Pkt.RESP, reqId, packResult(current)]);

            } else {
                // --- СТАНДАРТНАЯ ЛОГИКА CALL ---
                const args = unpack(rawArgsOrSteps, sendCb, sendCbEnd, lim);
                const res = await fn.apply(ctx, args);
                if (wait) send([Pkt.RESP, reqId, packResult(res)]);
            }

        } catch (e) {
            if (wait) send([Pkt.RESP, reqId, null, errToObj(e)]);
        }
    });
}

export function createRpcServer<T extends object>({ socket, object: target, socketKey: key, debug = false, hooks, limits, auth, opt }: {
    socket: SocketTmpl; object: T; socketKey: string; debug?: boolean; hooks?: PromiseServerHooks<T>; limits?: RpcLimits; auth?: RpcServerAuth; opt?: RpcOpt;
}) {
    if (debug) {
        const origOn = socket.on.bind(socket);
        socket.on = (e: string, cb: (d: any) => void) =>
            origOn(e, (d: any) => { console.log("[RPC IN]", typeof d == "object" ? JSON.stringify(d) : d); cb(d); });
    }
    createServer(socket, key, target, hooks, limits, auth, opt);
}

export type { PromiseServerHooks, RpcLimits, RpcServerAuth };
export type { RpcOpt } from "./rpc-caps";
