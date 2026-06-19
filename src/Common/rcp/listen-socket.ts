// listen-socket.ts

import { funcListenCallback, funcListenCallbackBase, type Listener } from "../events/Listen";
import { RPC_STOP } from "./rpc-protocol";
import { makeOff, type Off } from "./rpc-off";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

// ===================================================================
// Тип хендла подписки — ровно рантайм-форма makeOff (Off из rpc-off)
// ===================================================================
// callback(fn) на КЛИЕНТСКОМ слое отдаёт ВЫЗЫВАЕМЫЙ хендл:
//   off = sub; off()      // отписка
//   await sub             // ждёт завершения стрима (thenable)
//   sub.unsubscribe()     // back-compat-имя (rpc-client дедуп)
//   sub.removeCallback()  // back-compat-имя (listen-socket)
// Это в точности Off<void, { unsubscribe; removeCallback }> из rpc-off — поэтому
// рантайм makeOff(...) и ЭТОТ тип согласованы (один и тот же контракт).
// Здесь только ТИП: на listen-socket-слое callback в рантайме отдаёт
// makeOff(wait, removeCallback) (см. ниже), а вызываемость материализует он же.
export type tSubHandle = Off<void, { unsubscribe: () => void; removeCallback: () => void }>

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
                       // строит свежий канал на каждый callback(), так что переиспользования нет)
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
        readonly addListenClose?: ListenCallbackResult<any>;
        readonly stop?: (x: Listener<Z>) => any;
        readonly paramsModify?: (...e: Z) => any[];
        /** Opt-in: эмитить не чаще раза в `throttle` мс (leading + trailing-latest).
         *  undefined/0 = без троттлинга (поведение и байты прежние, байт-в-байт).
         *  Серверная сторона: гасит лишние эмиссии ДО отправки в провод — экономия
         *  трафика для back-to-back. На STOP/отписке подвешенный trailing снимается. */
        readonly throttle?: number;
    },
) {
    const { stop, addListenClose, status, paramsModify, throttle } = d ?? {};
    const { addListen, removeListen, eventClose, removeEventClose } = e;

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;
    let resolveWait: (() => void) | null = null;
    // активный throttle-канал текущей подписки (null без опции) — чтобы removeCallback/STOP
    // могли cancel() подвешенный trailing-таймер и не прислать эмиссию после off().
    let throttleCh: ReturnType<typeof createThrottleLatest<any>> | null = null;

    function finish() {
        if (resolveWait) { resolveWait(); resolveWait = null; }
    }

    function removeCallback() {
        if (throttleCh) { throttleCh.cancel(); throttleCh = null; }
        if (last) { stop?.(last); last = null; }
        if (active) { removeListen(active); active = null; }
        addListenClose?.removeListen(removeCallback);
        finish();
        return true;
    }

    // НЕ async: иначе async-обёртка проглотила бы вызываемый makeOff-хендл и вернула
    // бы голый Promise<void> — off() перестал бы работать. В теле нет await, де-async безопасен.
    function callback(z: Listener<Z>) {
        if (last) stop?.(last);
        if (active) removeListen(active);
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
                else removeCallback();
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
                if (active) { removeListen(active); active = null; }
                addListenClose?.removeListen(removeCallback);
                finish();
                return;
            }
            inner(...a);
        };

        addListen(active, {cbClose: removeCallback});
        addListenClose?.addListen(removeCallback);

        const wait = new Promise<void>((resolve) => {
            resolveWait = () => { resolve() };
        });
        // off = sub; off(): handle == removeCallback(), при этом await handle резолвится
        // на завершении стрима (wait) ровно как прежний Promise<void>. Отдельный
        // removeCallback из { callback, removeCallback } по-прежнему доступен.
        // Алиасы .unsubscribe/.removeCallback вешаем на сам handle — чтобы РАНТАЙМ совпал
        // с типом tSubHandle, который обещают клиентские обёртки (иначе sub.removeCallback()
        // тип-чек проходит, но падает в рантайме). Каст хранит публичную сигнатуру callback
        // (Promise<void>) байт-в-байт: базовый listenSocket ждёт rpc-server-auto (done.then);
        // вызываемость тип-видна только на обёртках (First/All/Smart) и Deep.
        return makeOff(wait, removeCallback, { unsubscribe: removeCallback, removeCallback }) as unknown as Promise<void>;
    }

    return { callback, removeCallback };
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
        callback: r.callback as unknown as (z: SingleArgCallback) => tSubHandle,
        removeCallback: r.removeCallback,
    };
}

export function listenSocketAll<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as unknown as (z: (...args: Z) => void) => tSubHandle,
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
        callback: r.callback as unknown as (z: SmartCallback<Z>) => tSubHandle,
        removeCallback: r.removeCallback,
    };
}