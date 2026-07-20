// listen-socket.ts

import { createListen, type Listener } from "../events/Listen";
import { RPC_STOP } from "./rpc-protocol";
import { endCallback, makeOff, type Off } from "./rpc-off";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;

// ===================================================================
// Тип хендла подписки — ровно рантайм-форма makeOff (Off из rpc-off)
// ===================================================================
// on(fn) на КЛИЕНТСКОМ слое отдаёт ВЫЗЫВАЕМЫЙ хендл:
//   off = sub; off()      // отписка
//   await sub             // ждёт завершения стрима (thenable)
//   sub.off()             // явное имя для того же stop
//   sub.unsubscribe()     // back-compat-имя (rpc-client дедуп)
//   sub.removeCallback()  // back-compat-имя (listen-socket)
// Это в точности Off<void, { off; unsubscribe; removeCallback }> из rpc-off — поэтому
// рантайм makeOff(...) и ЭТОТ тип согласованы (один и тот же контракт).
// Здесь только ТИП: на listen-socket-слое on в рантайме отдаёт
// makeOff(wait, off) (см. ниже), а вызываемость материализует он же.
export type SubscriptionHandle = Off<void, { off: () => void; unsubscribe: () => void; removeCallback: () => void }>
export type RpcListenSubscribeOpts = {current?: boolean}

function wireSubscribeOpts(opts: RpcListenSubscribeOpts | undefined) {
    return opts?.current == true ? {current: true as const} : undefined
}
// ===================================================================
// Утилита: throttle с trailing-latest (leading + trailing-latest)
// ===================================================================
// Слой-нейтральна: знает только про аргументы эмиссии, ничего про сокеты/Listen.
// Семантика: первый вызов проходит СРАЗУ (leading); далее не чаще раза в ms, но в
// окне запоминается ПОСЛЕДНИЙ набор аргументов и доставляется на границе окна
// (trailing-latest) — потребитель не залипает на устаревшем значении. cancel() гасит
// подвешенный trailing-таймер (отписка/STOP). НЕ переиспользуем enhancedWaitRun.
// throttleAsync: он leading-ТОЛЬКО, роняет trailing (lastValue не хранит) и завязан
// на async-цепочку — не та форма для синхронного fan-out.
function createThrottleLatest<A extends any[]>(ms: number, sink: (...a: A) => void) {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: A | null = null
    let killed = false // терминальный флаг: после cancel() канал мёртв навсегда (listenSocket
                       // строит свежий канал на каждый on(), так что переиспользования нет)
    function flush() {
        timer = null
        if (pending) { const a = pending; pending = null; emit(...a) }
    }
    function emit(...a: A) {
        sink(...a)
        // НЕ пере-арми, если sink синхронно снёс подписку (status()==false → removeCallback →
        // cancel) — иначе утёк бы setTimeout, переживающий teardown на целый интервал.
        if (!killed) timer = setTimeout(flush, ms) // окно охлаждения; trailing уйдёт во flush
    }
    function push(...a: A) {
        if (killed) return
        if (timer) { pending = a; return } // в окне — копим только ПОСЛЕДНИЙ набор
        emit(...a)                         // leading: первый/после простоя — сразу
    }
    function cancel() {
        killed = true
        if (timer) { clearTimeout(timer); timer = null }
        pending = null
    }
    return { push, cancel }
}

export function listenSocket<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    d?: {
        readonly status?: () => boolean;
        readonly closeOn?: ListenCallbackResult<any>;
        readonly stop?: (x: Listener<Z>) => any;
        readonly paramsModify?: (...e: Z) => any[];
        /** Opt-in: эмитить не чаще раза в `throttle` мс (leading + trailing-latest).
         *  undefined/0 = без троттлинга (поведение и байты прежние, байт-в-байт).
         *  Серверная сторона: гасит лишние эмиссии ДО отправки в провод — экономия
         *  трафика для back-to-back. На STOP/отписке подвешенный trailing снимается. */
        readonly throttle?: number;
    },
) {
    const { stop, status, paramsModify, throttle } = d ?? {};
    const closeOn = d?.closeOn;
    const subscribe = (cb: Listener<any>, opts?: {cbClose?: () => void, current?: true}) => e.on(cb as any, opts as any);
    const subscribeClose = closeOn && ((cb: () => void) => closeOn.on(cb));

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;
    let activeOff: (() => void) | null = null;
    let closeSignalOff: (() => void) | null = null;
    let resolveWait: (() => void) | null = null;
    // активный throttle-канал текущей подписки (null без опции) — чтобы off()/STOP
    // могли cancel() подвешенный trailing-таймер и не прислать эмиссию после off().
    let throttleCh: ReturnType<typeof createThrottleLatest<any>> | null = null;

    function finish() {
        if (resolveWait) { resolveWait(); resolveWait = null; }
    }

    function off() {
        if (throttleCh) { throttleCh.cancel(); throttleCh = null; }
        if (last) { stop?.(last); last = null; }
        if (activeOff) { activeOff(); activeOff = null; active = null; }
        if (closeSignalOff) { closeSignalOff(); closeSignalOff = null; }
        finish();
        return true;
    }

    /** @deprecated Используйте off(). */
    const removeCallback = off

    // НЕ async: иначе async-обёртка проглотила бы вызываемый makeOff-хендл и вернула
    // бы голый Promise<void> — off() перестал бы работать. В теле нет await, де-async безопасен.
    function on(z: Listener<Z>, opts?: RpcListenSubscribeOpts) {
        if (typeof z !== "function") {
            throw new TypeError("listenSocket.on expects a function");
        }
        if (last) stop?.(last);
        if (activeOff) { activeOff(); activeOff = null; active = null; }
        if (closeSignalOff) { closeSignalOff(); closeSignalOff = null; }
        if (resolveWait) { resolveWait(); resolveWait = null; }

        last = z;

        let handler: Listener<any> = z;
        if (paramsModify) {
            const orig = handler;
            handler = (...a: any[]) => orig(...paramsModify(...(a as Z)));
        }
        if (status) {
            const wrapped = handler;
            // отписка ЛЕНИВАЯ by design: события смены статуса нет, поэтому false
            // обнаруживается на ближайшей эмиссии — до неё слушатель остаётся подвешен
            handler = (...a: any[]) => {
                if (status()) wrapped(...a);
                else off();
            };
        }

        // throttle (opt-in): оборачиваем ИМЕННО inner, а не active — RPC_STOP в active
        // короткозамкнут ВЫШЕ и идёт мимо троттла (teardown остаётся синхронным).
        // trailing-latest гарантирует доставку последнего значения на границе окна.
        let inner = handler;
        if (throttle) {
            if (throttleCh) throttleCh.cancel();
            const ch = createThrottleLatest<any[]>(throttle, (...a) => handler(...a));
            throttleCh = ch;
            inner = (...a: any[]) => ch.push(...a);
        }
        active = (...a: any[]) => {
            if (a[0] === RPC_STOP) {
                if (throttleCh) { throttleCh.cancel(); throttleCh = null; }
                z(...a as Z);
                if (last) { stop?.(last); }
                last = null;
                if (activeOff) { activeOff(); activeOff = null; active = null; }
                if (closeSignalOff) { closeSignalOff(); closeSignalOff = null; }
                finish();
                return;
            }
            inner(...a);
        };

        const forwarded = wireSubscribeOpts(opts)
        const wait = new Promise<void>((resolve) => {
            resolveWait = () => { resolve() };
        });
        const createdOff = subscribe(active, forwarded ? {cbClose: off, ...forwarded} : {cbClose: off});
        // A current provider may emit synchronously inside subscribe(). In particular,
        // once({current:true}) tears itself down before subscribe() returns.
        if (last == z) {
            activeOff = createdOff
            closeSignalOff = subscribeClose?.(off) ?? null
        } else {
            createdOff()
            active = null
        }
        // off = sub; off(): handle == off(), при этом await handle резолвится
        // на завершении стрима (wait) ровно как прежний Promise<void>. Отдельный
        // removeCallback из { callback, removeCallback } по-прежнему доступен как legacy.
        // Алиасы .unsubscribe/.removeCallback вешаем на сам handle — чтобы РАНТАЙМ совпал
        // с типом SubscriptionHandle, который обещают клиентские обёртки (иначе sub.removeCallback()
        // тип-чек проходит, но падает в рантайме). Каст хранит публичную сигнатуру callback
        // (Promise<void>) байт-в-байт: базовый listenSocket ждёт rpc-server-auto (done.then);
        // вызываемость тип-видна только на обёртках (First/All/Smart) и Deep.
        return makeOff(wait, off, { off, unsubscribe: off, removeCallback }) as unknown as Promise<void>;
    }

    // callback — legacy-алиас: новые вызовы должны идти через on(cb), тот же off()/await-хендл.
    // once — однократная подписка: первое событие + конец стрима (RPC_STOP→CB_END), затем off.
    function once(z: Listener<Z>, opts?: RpcListenSubscribeOpts) {
        if (typeof z !== "function") {
            throw new TypeError("listenSocket.once expects a function");
        }
        let fired = false;
        const oneShot = ((...a: any[]) => {
            if (a[0] === RPC_STOP) { off(); return; }
            if (fired) return; fired = true;
            try { (z as Function)(...a); }
            finally { endCallback(z as Function); off(); }
        }) as Listener<Z>;
        return on(oneShot, opts);
    }
    // close — закрыть весь Listen-источник (полный teardown, влияет на ВСЕХ потребителей узла).
    function closeStream() { (e as any).close?.(); }
    function callback(z: Listener<Z>, opts?: RpcListenSubscribeOpts) {
        if (typeof z !== "function") throw new TypeError("listenSocket.callback expects a function");
        return on(z, opts);
    }
    return { on, off, callback, removeCallback, once, close: closeStream };
}

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
        callback: r.callback as unknown as (z: SingleArgCallback, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        on: r.on as unknown as (z: SingleArgCallback, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        once: r.once as unknown as (z: SingleArgCallback, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}

export function listenSocketAll<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as unknown as (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        on: r.on as unknown as (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        once: r.once as unknown as (z: (...args: Z) => void, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}

type SmartCallback<Z extends any[]> = Z extends [infer Single]
    ? (a: Single) => void
    : (...args: Z) => void;

export function listenSocketSmart<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as unknown as (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        on: r.on as unknown as (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        once: r.once as unknown as (z: SmartCallback<Z>, opts?: RpcListenSubscribeOpts) => SubscriptionHandle,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}
