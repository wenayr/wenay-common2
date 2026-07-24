"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listenSocket = listenSocket;
exports.listenSocketFirst = listenSocketFirst;
exports.listenSocketAll = listenSocketAll;
exports.listenSocketSmart = listenSocketSmart;
const rpc_protocol_1 = require("./rpc-protocol");
const rpc_off_1 = require("./rpc-off");
function wireSubscribeOpts(opts) {
    if (!opts)
        return undefined;
    const result = {};
    if (opts.current == true)
        result.current = true;
    if (opts.knowledge != undefined)
        result.knowledge = opts.knowledge;
    return Object.keys(result).length ? result : undefined;
}
function createThrottleLatest(ms, sink) {
    let timer = null;
    let pending = null;
    let killed = false;
    function flush() {
        timer = null;
        if (pending) {
            const a = pending;
            pending = null;
            emit(...a);
        }
    }
    function emit(...a) {
        sink(...a);
        if (!killed)
            timer = setTimeout(flush, ms);
    }
    function push(...a) {
        if (killed)
            return;
        if (timer) {
            pending = a;
            return;
        }
        emit(...a);
    }
    function cancel() {
        killed = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
    }
    return { push, cancel };
}
function listenSocket(e, d) {
    const { stop, status, paramsModify, throttle } = d ?? {};
    const closeOn = d?.closeOn;
    const subscribe = (cb, opts) => e.on(cb, opts);
    const subscribeClose = closeOn && ((cb) => closeOn.on(cb));
    let last = null;
    let active = null;
    let activeOff = null;
    let closeSignalOff = null;
    let resolveWait = null;
    let throttleCh = null;
    function finish() {
        if (resolveWait) {
            resolveWait();
            resolveWait = null;
        }
    }
    function off() {
        if (throttleCh) {
            throttleCh.cancel();
            throttleCh = null;
        }
        if (last) {
            stop?.(last);
            last = null;
        }
        if (activeOff) {
            activeOff();
            activeOff = null;
            active = null;
        }
        if (closeSignalOff) {
            closeSignalOff();
            closeSignalOff = null;
        }
        finish();
        return true;
    }
    const removeCallback = off;
    function on(z, opts) {
        if (typeof z !== "function") {
            throw new TypeError("listenSocket.on expects a function");
        }
        if (last)
            stop?.(last);
        if (activeOff) {
            activeOff();
            activeOff = null;
            active = null;
        }
        if (closeSignalOff) {
            closeSignalOff();
            closeSignalOff = null;
        }
        if (resolveWait) {
            resolveWait();
            resolveWait = null;
        }
        last = z;
        let handler = z;
        if (paramsModify) {
            const orig = handler;
            handler = (...a) => orig(...paramsModify(...a));
        }
        if (status) {
            const wrapped = handler;
            handler = (...a) => {
                if (status())
                    wrapped(...a);
                else
                    off();
            };
        }
        let inner = handler;
        if (throttle) {
            if (throttleCh)
                throttleCh.cancel();
            const ch = createThrottleLatest(throttle, (...a) => handler(...a));
            throttleCh = ch;
            inner = (...a) => ch.push(...a);
        }
        active = (...a) => {
            if (a[0] === rpc_protocol_1.RPC_STOP) {
                if (throttleCh) {
                    throttleCh.cancel();
                    throttleCh = null;
                }
                z(...a);
                if (last) {
                    stop?.(last);
                }
                last = null;
                if (activeOff) {
                    activeOff();
                    activeOff = null;
                    active = null;
                }
                if (closeSignalOff) {
                    closeSignalOff();
                    closeSignalOff = null;
                }
                finish();
                return;
            }
            inner(...a);
        };
        const forwarded = wireSubscribeOpts(opts);
        const wait = new Promise((resolve) => {
            resolveWait = () => { resolve(); };
        });
        const createdOff = subscribe(active, forwarded ? { cbClose: off, ...forwarded } : { cbClose: off });
        if (last == z) {
            activeOff = createdOff;
            closeSignalOff = subscribeClose?.(off) ?? null;
        }
        else {
            createdOff();
            active = null;
        }
        return (0, rpc_off_1.makeOff)(wait, off, { off, unsubscribe: off, removeCallback });
    }
    function once(z, opts) {
        if (typeof z !== "function") {
            throw new TypeError("listenSocket.once expects a function");
        }
        let fired = false;
        const oneShot = ((...a) => {
            if (a[0] === rpc_protocol_1.RPC_STOP) {
                off();
                return;
            }
            if (fired)
                return;
            fired = true;
            try {
                z(...a);
            }
            finally {
                (0, rpc_off_1.endCallback)(z);
                off();
            }
        });
        return on(oneShot, opts);
    }
    function closeStream() { e.close?.(); }
    function callback(z, opts) {
        if (typeof z !== "function")
            throw new TypeError("listenSocket.callback expects a function");
        return on(z, opts);
    }
    return { on, off, callback, removeCallback, once, close: closeStream };
}
function listenSocketFirst(e, options) {
    const r = listenSocket(e, {
        ...options,
        paramsModify: ((...args) => [args[0]]),
    });
    return {
        callback: r.callback,
        on: r.on,
        once: r.once,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}
function listenSocketAll(e, options) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback,
        on: r.on,
        once: r.once,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}
function listenSocketSmart(e, options) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback,
        on: r.on,
        once: r.once,
        close: r.close,
        off: r.off,
        removeCallback: r.removeCallback,
    };
}
