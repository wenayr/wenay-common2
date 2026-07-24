// listen-socket.ts

import { createListen, type Listener } from "../events/Listen";
import { RPC_STOP } from "./rpc-protocol";
import { endCallback, makeOff, type Off } from "./rpc-off";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;

// ===================================================================
// Subscription handle type — exactly the runtime form of makeOff (Off from rpc-off)
// ===================================================================
// on(fn) at CLIENT layer returns CALLABLE handle:
//   off = sub; off()      // unsubscribe
//   await sub             // waits for stream completion (thenable)
//   sub.off()             // explicit name for the same stop
//   sub.unsubscribe()     // back-compat name (rpc-client dedup)
//   sub.removeCallback()  // back-compat name (listen-socket)
// This is exactly Off<void, { off; unsubscribe; removeCallback }> from rpc-off — so
// runtime makeOff(...) and THIS type are aligned (same contract).
// Here only TYPE: at listen-socket layer on returns at runtime
// makeOff(wait, off) (see below), and callability is materialized by it.
export type SubscriptionHandle = Off<void, { off: () => void; unsubscribe: () => void; removeCallback: () => void }>
export type RpcListenSubscribeOpts = {
    current?: true
    knowledge?: unknown
}

function wireSubscribeOpts(opts: RpcListenSubscribeOpts | undefined) {
    if (!opts) return undefined
    const result: RpcListenSubscribeOpts = {}
    if (opts.current == true) result.current = true
    if (opts.knowledge != undefined) result.knowledge = opts.knowledge
    return Object.keys(result).length ? result : undefined
}
// ===================================================================
// Utility: throttle with trailing-latest (leading + trailing-latest)
// ===================================================================
// Layer-neutral: knows only about emission arguments, nothing about sockets/Listen.
// Semantics: first call passes IMMEDIATELY (leading); then no more than once per ms, but in
// the window remembers LAST set of arguments and delivers at window boundary
// (trailing-latest) — consumer doesn't stick to stale value. cancel() cancels
// pending trailing timer (unsubscribe/STOP). NOT reusing enhancedWaitRun.
// throttleAsync: it's leading-ONLY, drops trailing (doesn't store lastValue) and tied
// to async chain — not the form for synchronous fan-out.
function createThrottleLatest<A extends any[]>(ms: number, sink: (...a: A) => void) {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: A | null = null
    let killed = false // terminal flag: after cancel() channel is dead forever (listenSocket
                       // builds fresh channel for each on(), so no reuse)
    function flush() {
        timer = null
        if (pending) { const a = pending; pending = null; emit(...a) }
    }
    function emit(...a: A) {
        sink(...a)
        // Don't re-arm if sink synchronously removed subscription (status()==false → removeCallback →
        // cancel) — otherwise setTimeout would leak, outliving teardown by a full interval.
        if (!killed) timer = setTimeout(flush, ms) // cooling window; trailing goes to flush
    }
    function push(...a: A) {
        if (killed) return
        if (timer) { pending = a; return } // in window — store only LAST set
        emit(...a)                         // leading: first/after idle — immediately
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
        /** Opt-in: emit no more than once per `throttle` ms (leading + trailing-latest).
         *  undefined/0 = no throttling (behavior and bytes unchanged, byte-for-byte).
         *  Server side: cancels excess emissions BEFORE sending to wire — saves
         *  traffic for back-to-back. On STOP/unsubscribe pending trailing is cancelled. */
        readonly throttle?: number;
    },
) {
    const { stop, status, paramsModify, throttle } = d ?? {};
    const closeOn = d?.closeOn;
    const subscribe = (
        cb: Listener<any>,
        opts?: {cbClose?: () => void, current?: true, knowledge?: unknown},
    ) => e.on(cb as any, opts as any);
    const subscribeClose = closeOn && ((cb: () => void) => closeOn.on(cb));

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;
    let activeOff: (() => void) | null = null;
    let closeSignalOff: (() => void) | null = null;
    let resolveWait: (() => void) | null = null;
    // active throttle channel of current subscription (null without option) — so off()/STOP
    // could cancel() pending trailing timer and not send emission after off().
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

    /** @deprecated Use off(). */
    const removeCallback = off

    // NOT async: otherwise async wrapper would swallow callable makeOff handle and return
    // bare Promise<void> — off() would stop working. No await in body, de-async is safe.
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
            // unsubscribe LAZY by design: no status change event, so false
            // is detected on nearest emission — listener remains pending until then
            handler = (...a: any[]) => {
                if (status()) wrapped(...a);
                else off();
            };
        }

        // throttle (opt-in): wrap EXACTLY inner, not active — RPC_STOP in active
        // is short-circuited ABOVE and bypasses throttle (teardown remains synchronous).
        // trailing-latest guarantees delivery of latest value at window boundary.
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
        // off = sub; off(): handle == off(), meanwhile await handle resolves
        // at stream completion (wait) exactly like former Promise<void>. Separate
        // removeCallback from { callback, removeCallback } still available as legacy.
        // Aliases .unsubscribe/.removeCallback attached to handle itself — so RUNTIME matches
        // SubscriptionHandle type promised by client wrappers (else sub.removeCallback()
        // type-check passes but fails at runtime). Cast preserves public signature of callback
        // (Promise<void>) byte-for-byte: base listenSocket waits rpc-server-auto (done.then);
        // callability type-visible only on wrappers (First/All/Smart) and Deep.
        return makeOff(wait, off, { off, unsubscribe: off, removeCallback }) as unknown as Promise<void>;
    }

    // callback — legacy alias: new calls should go through on(cb), same off()/await handle.
    // once — single subscription: first event + stream end (RPC_STOP→CB_END), then off.
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
    // close — close entire Listen source (full teardown, affects ALL node consumers).
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
