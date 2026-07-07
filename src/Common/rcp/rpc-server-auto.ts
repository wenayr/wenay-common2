import { isListenCallback, createListen, isListenOn, getListenByOn } from "../events/Listen";
import { IS_REPLAY_LISTEN } from "../events/replay-listen";
import { listenSocket, } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from "./rpc-server";
import {DeepSocketListen} from "./listen-deep";
import {SocketTmpl, IS_RPC_LISTEN, RPC_STOP} from "./rpc-protocol";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;

/** Серверные пороги ворот лага для 'frame'-подписчиков (Feature B). Единицы pending()
 *  и порогов — одни и те же (байты/пакеты/кадры — что даёт транспорт). */
export type RpcReplayOpts = {
    /** Заполненность исходящего буфера ЭТОГО соединения. Default — socket.io writeBuffer. */
    pending?: () => number
    /** Вход в пропуск: pending() > highWater → конверты frameLine перестают отправляться. */
    highWater?: number
    /** Выход (default 0): pending() <= lowWater → frame(lastSent) и дальше live. */
    lowWater?: number
    /** Период опроса pending() в режиме пропуска, мс (default 25). */
    pollMs?: number
}

export function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, auth, maxPerListen, throttle, opt, replay = "auto", replayOpts }: {
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
    /** Автодетекция replay-линий в фасаде: 'auto' (default) — по бренду; 'force' — плюс
     *  структурная (линии из чужой копии модуля без бренда); false — выключено, replay-линия
     *  ведёт себя как обычный Listen (поведение прежнее). */
    replay?: false | "auto" | "force";
    /** Ворота лага для 'frame'-подписчиков replay-линий. Без highWater ворот нет:
     *  frameLine = alias line (политика выбирается, но сервер не пропускает). */
    replayOpts?: RpcReplayOpts;
}) {
    // Один listenSocket-wrapper на Listen ЗАТИРАЛ предыдущего подписчика при повторной
    // подписке (его callback заменяет last/active). Мультиплексор: каждый подписчик
    // получает собственный listenSocket; записи чистятся по завершении подписки.
    // Кэш по ИДЕНТИЧНОСТИ Listen-узла. Важно для re-auth: фасады разных principal должны
    // переиспользовать ОДИН и тот же Listen-объект (один listen-хендл), иначе при смене principal
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
            subs.forEach(w => w.off());
            subs.clear();
        }
        registry.clear();
    }

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>, nodeOpt?: { throttle?: number }): ReturnType<typeof listenSocket> {
        // replay-линии троттлить нельзя: уроненный конверт = молчаливая дыра в seq,
        // поэтому их узлы создаются с явным {throttle: undefined}
        const nodeThrottle = nodeOpt ? nodeOpt.throttle : throttle;
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
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                subs.set(z, w);
                const done = w.on(z);
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
                subs.get(z)?.off();
                const w = listenSocket(parent, { closeOn: disconnectListen, throttle: nodeThrottle });
                let fired = false;
                const oneShot = (...a: any[]) => {
                    if (fired) return;
                    fired = true;
                    try {
                        z(...a);        // первое событие → CB
                        z(RPC_STOP);    // конец стрима → CB_END
                    }
                    finally {
                        w.off();
                    }
                };
                subs.set(z, w);
                const done = w.on(oneShot);
                done.then(() => { if (subs.get(z) == w) subs.delete(z); if (subs.size == 0) registry.delete(parent); });
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.off());
                subs.clear();
                registry.delete(parent); // узел снесён — убираем из реестра
                return true;
            }
            // close — закрыть весь Listen-источник (полный teardown; влияет на ВСЕХ потребителей узла).
            result = { on: subscribe, off: unsubscribeAll, callback: subscribe, removeCallback: unsubscribeAll, once: subscribeOnce, close: () => (parent as any).close?.() };
            (result as any)[IS_RPC_LISTEN] = true; // сервер задекларирует адрес узла в Pkt.MAP
            cache.set(parent, result);
        }
        return result;
    }

    // ===================================================================
    // replay-transparent exposure (Feature A): replay-линия в фасаде → ОБА
    // поверхности под ТЕМ ЖЕ ключом. Легаси-путь (plain listen) байт-в-байт,
    // плюс провод replay: line / frameLine / since / keyframe / frame.
    // Транспорт видит только seq — семантика событий остаётся в лямбдах линии.
    // ===================================================================
    function isReplayNode(obj: any): boolean {
        if (replay == false || obj == null || typeof obj != "object") return false;
        if (Object.prototype.hasOwnProperty.call(obj, IS_REPLAY_LISTEN)) return true;
        // 'force': структурная детекция — для линий из чужой копии модуля без бренда
        return replay == "force"
            && isListenCallback(obj)
            && typeof (obj as any).getSince == "function"
            && typeof (obj as any).keyframe == "function"
            && !!(obj as any).line && typeof (obj as any).line == "object";
    }

    // кадр линии с fallback для старых копий replay-listen без метода frame
    function lineFrame(parent: any, seq: number, hint?: unknown) {
        if (typeof parent.frame == "function") return parent.frame(seq, hint);
        const tail = parent.getSince(seq);
        if (tail) return tail;
        const kf = parent.keyframe();
        if (kf) return [kf];
        throw new Error(`replay frame(${seq}): journal evicted and no keyframe (sacred line)`);
    }

    // --- ворота лага (Feature B): content-blind, на подписчика — одно число (lastSent) ---
    const gateClosers = new Set<() => void>();
    function closeAllGates() { for (const c of [...gateClosers]) c(); }
    let gatesHooked = false;
    function hookGateTeardown() {
        if (gatesHooked || !disconnectListen) return;
        gatesHooked = true;
        disconnectListen.on(closeAllGates);
    }

    function gatedLineNode(parent: any) {
        const { pending: pendingOpt, highWater = Infinity, lowWater = 0, pollMs = 25 } = replayOpts ?? {};
        const pending = pendingOpt ?? (() => (socket as any)?.conn?.writeBuffer?.length ?? 0);
        // персональная линия конвертов этого соединения за воротами
        const out = createListen<any[]>(() => {});
        out.run();
        let lastSent: number = typeof parent.head == "function" ? parent.head() : 0;
        let gated = false;
        let closed = false;
        let timer: any = null;
        function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }
        function startPoll() {
            if (timer || closed) return;
            timer = setInterval(recoverIfDrained, pollMs);
            timer.unref?.();
        }
        function close() {
            if (closed) return;
            closed = true;
            stopPoll();
            offLine();
            gateClosers.delete(close);
        }
        // громкий отказ ЭТОМУ подписчику (священная линия + вытеснение): конец стрима
        // (RPC_STOP → CB_END у клиента), никакой молчаливой потери
        function fail(e: any) {
            if (debug) console.error("[rpc replay gate] frame recovery failed:", e);
            const emitStop = !closed;
            close();
            if (emitStop) out.emit(RPC_STOP);
            (out as any).close?.();
        }
        function recoverIfDrained() {
            if (!gated || closed) return;
            if (pending() > lowWater) return;
            gated = false;
            stopPoll();
            let envs: any[];
            try { envs = lineFrame(parent, lastSent); }
            catch (e) { fail(e); return; }
            for (const ev of envs) {
                if (ev.seq > lastSent) lastSent = ev.seq;
                out.emit(ev);
            }
        }
        const offLine = parent.line.on(function gateForward(ev: any) {
            if (closed) return;
            if (!gated && pending() > highWater) { gated = true; startPoll(); }
            // осушилось прямо сейчас → кадр включит ЭТОТ конверт (журнал пишется до fan-out);
            // всё ещё заперто → конверт дропается, frame(lastSent) его перекроет
            if (gated) { recoverIfDrained(); return; }
            lastSent = ev.seq;
            out.emit(ev);
        });
        gateClosers.add(close);
        hookGateTeardown();
        return getListenSocket(out, disconnectListen, { throttle: undefined });
    }

    // merged-узел под тем же ключом; кэш по identity линии (как cache обычных Listen)
    const replayCache = new WeakMap<object, any>();
    function getReplayExpose(parent: any) {
        let node = replayCache.get(parent);
        if (node) return node;
        const legacy = getListenSocket(parent, disconnectListen); // легаси-поверхность как была (включая throttle)
        const lineNode = getListenSocket(parent.line, disconnectListen, { throttle: undefined });
        const frameLineNode = replayOpts?.highWater != null ? gatedLineNode(parent) : lineNode;
        node = {
            ...legacy,
            line: lineNode,
            frameLine: frameLineNode,
            since: (seq: number) => parent.getSince(seq) ?? null,
            keyframe: () => parent.keyframe() ?? null,
            // бросок (священная линия + вытеснение) уедет клиенту rejected promise — громко
            frame: (seq: number, hint?: unknown) => lineFrame(parent, seq, hint),
        };
        node[IS_RPC_LISTEN] = true; // сервер задекларирует адрес узла в Pkt.MAP (легаси-подписка)
        replayCache.set(parent, node);
        return node;
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
            onDispose: () => { closeAllGates(); unsubscribeAllActive(); hooks?.onDispose?.(); },
            resolveTransform: (obj: any) => {
                // ВАЖНО: replay-детекция ДО isListenCallback — replay-api структурно проходит
                // проверку plain-Listen, и без бренда его replay-поверхность была бы потеряна.
                if (isReplayNode(obj)) return getReplayExpose(obj);
                if (isListenCallback(obj)) return getListenSocket(obj, disconnectListen);
                // bare `on`-функция: по реестру (WeakMap) находим её api и оборачиваем — позволяет
                // прокинуть через веб ТОЛЬКО ссылку on, а клиент получит подписку {on, once, close}.
                if (isListenOn(obj)) {
                    const byOn = getListenByOn(obj);
                    return isReplayNode(byOn) ? getReplayExpose(byOn) : getListenSocket(byOn, disconnectListen);
                }
                return obj;
            },
        } as any,
    });

    return { api }; // аддитивно: раньше void. Старые вызовы (harness x3, test.ts) игнорируют возврат.
}
