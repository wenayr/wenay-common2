"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LISTEN_DISPATCH_ERROR = void 0;
exports.getListenByOn = getListenByOn;
exports.isListenOn = isListenOn;
exports.registerListenOn = registerListenOn;
exports.createListenCore = createListenCore;
exports.createListen = createListen;
exports.createFastListen = createFastListen;
exports.listen = listen;
exports.withStoreListen = withStoreListen;
exports.createStoreListen = createStoreListen;
exports.listenStore = listenStore;
exports.toSlimListen = toSlimListen;
exports.slimListen = slimListen;
exports.isListenCallback = isListenCallback;
const listenByOn = new WeakMap();
exports.LISTEN_DISPATCH_ERROR = Symbol.for('wenay-common2.listen.dispatchError');
function getListenByOn(fn) { return typeof fn == 'function' ? listenByOn.get(fn) : undefined; }
function isListenOn(fn) { return typeof fn == 'function' && listenByOn.has(fn); }
function registerListenOn(on, api) { listenByOn.set(on, api); }
function createListenCore(options = {}) {
    const { fast = true, onRemove, event } = options;
    const dispatchError = options[exports.LISTEN_DISPATCH_ERROR];
    const subs = new Map();
    function dispatch(cb, args) {
        if (!dispatchError) {
            cb(...args);
            return;
        }
        try {
            cb(...args);
        }
        catch (error) {
            dispatchError(error);
        }
    }
    function dispatchInitial(...args) {
        for (const cb of subs.values())
            dispatch(cb, args);
    }
    let dispatcher = dispatchInitial;
    let cached = null;
    const getArr = () => cached ?? (cached = Array.from(subs.values()));
    function rebuild() {
        cached = null;
        const size = subs.size;
        if (size == 0) {
            dispatcher = null;
            return;
        }
        if (size == 1) {
            const cb = subs.values().next().value;
            function dispatchOne(...args) { dispatch(cb, args); }
            dispatcher = dispatchError ? dispatchOne : cb;
            return;
        }
        if (size == 2) {
            const [a, b] = getArr();
            function dispatchPairSafely(...args) {
                dispatch(a, args);
                dispatch(b, args);
            }
            function dispatchPair(...args) {
                a(...args);
                b(...args);
            }
            dispatcher = dispatchError ? dispatchPairSafely : dispatchPair;
            return;
        }
        dispatcher = function dispatchMany(...args) {
            const arr = getArr();
            if (dispatchError) {
                for (let i = 0; i < arr.length; i++)
                    dispatch(arr[i], args);
            }
            else {
                for (let i = 0; i < arr.length; i++)
                    arr[i](...args);
            }
        };
    }
    function removeOne(key) {
        if (!subs.has(key))
            return;
        subs.delete(key);
        onRemove?.(key);
        if (fast)
            rebuild();
        event?.('remove', subs.size, api);
    }
    const api = {
        emit: ((...args) => { dispatcher?.(...args); }),
        has: (key) => subs.has(key),
        on: ((cb, { key } = {}) => {
            const k = key ?? Symbol();
            if (subs.has(k)) {
                subs.delete(k);
                onRemove?.(k);
            }
            subs.set(k, cb);
            if (fast)
                rebuild();
            event?.('add', subs.size, api);
            return function off() { removeOne(k); };
        }),
        off: (keyOrCallback) => {
            if (typeof keyOrCallback == 'function') {
                for (const [key, cb] of [...subs])
                    if (cb === keyOrCallback)
                        removeOne(key);
                return;
            }
            if (keyOrCallback != null)
                removeOne(keyOrCallback);
        },
        once: (cb, opts = {}) => {
            let off = () => { };
            off = api.on(((...args) => { off(); cb(...args); }), opts);
            return off;
        },
        close: () => {
            subs.clear();
            if (fast)
                rebuild();
        },
        count: () => subs.size,
        keys: () => [...subs.keys()],
    };
    listenByOn.set(api.on, api);
    return api;
}
function createListen(producer, options = {}) {
    const { fast = true, event, closeOn } = options;
    let teardown = null;
    let closeSignalOff = null;
    let closeHooks = null;
    function forgetKey(key) {
        closeHooks?.delete(key);
    }
    function forwardRemoveEvent(type, count) {
        if (type == 'remove')
            event?.(type, count, api);
    }
    const core = createListenCore({
        fast,
        onRemove: forgetKey,
        [exports.LISTEN_DISPATCH_ERROR]: options[exports.LISTEN_DISPATCH_ERROR],
        event: event ? forwardRemoveEvent : undefined,
    });
    const api = {
        emit: core.emit,
        has: core.has,
        isRunning: () => teardown !== null,
        run: () => {
            if (teardown)
                return;
            teardown = (producer(core.emit) ?? (() => { }));
            if (closeOn && !closeSignalOff)
                closeSignalOff = closeOn.on(() => api.close());
        },
        close: () => {
            const stop = teardown;
            teardown = null;
            stop?.();
            core.close();
            if (closeHooks) {
                const hooks = closeHooks;
                closeHooks = null;
                hooks.forEach(cb => cb());
            }
            closeSignalOff?.();
            closeSignalOff = null;
        },
        onClose: (cb) => {
            closeHooks = closeHooks ?? new Map();
            closeHooks.set(cb, cb);
            return function offClose() { closeHooks?.delete(cb); };
        },
        on: ((cb, { cbClose, key } = {}) => {
            const k = key ?? Symbol();
            const off = core.on(cb, { key: k });
            if (cbClose) {
                closeHooks = closeHooks ?? new Map();
                closeHooks.set(k, cbClose);
            }
            event?.('add', core.count(), api);
            return off;
        }),
        off: core.off,
        once: (cb, opts = {}) => {
            let off = () => { };
            off = api.on(((...args) => { off(); cb(...args); }), opts);
            return off;
        },
        count: core.count,
        keys: core.keys,
    };
    listenByOn.set(api.on, api);
    return api;
}
function createFastListen(producer) {
    return createListen(producer, { fast: true });
}
function listen(options = { fast: true }) {
    let emit;
    const api = createListen((next) => { emit = next; }, { fast: true, ...options });
    api.run();
    emit = api.emit;
    return [emit, api];
}
function withStoreListen(base, currentProvider) {
    function currentValue(current) {
        if (typeof current == 'function')
            return current();
        return current ? currentProvider() : undefined;
    }
    const api = {
        ...base,
        on: ((cb, { cbClose, key, current } = {}) => {
            const off = base.on(cb, { cbClose, key });
            if (current) {
                const value = currentValue(current);
                if (value)
                    cb(...value);
            }
            return off;
        }),
        once: (cb, opts = {}) => {
            if (opts.current) {
                const value = currentValue(opts.current);
                if (value) {
                    cb(...value);
                    return () => { };
                }
            }
            let off = () => { };
            off = base.on(((...args) => { off(); cb(...args); }), { key: opts.key });
            return off;
        },
    };
    listenByOn.set(api.on, api);
    return api;
}
function createStoreListen(producer, options) {
    const { current, ...listenOptions } = options;
    return withStoreListen(createListen(producer, listenOptions), current);
}
function listenStore(options) {
    const { current, ...listenOptions } = options;
    let emit;
    const base = createListen((next) => { emit = next; }, { fast: true, ...listenOptions });
    const api = withStoreListen(base, current);
    base.run();
    emit = base.emit;
    return [emit, api];
}
function toSlimListen(full) {
    return {
        on: (cb, opts) => full.on(cb, opts),
        off: (keyOrCallback) => full.off(keyOrCallback),
        close: () => full.close(),
        count: () => full.count(),
    };
}
function slimListen(options = { fast: true }) {
    const [emit, full] = listen(options);
    return [emit, toSlimListen(full)];
}
const LISTEN_CORE = ['emit', 'on', 'off', 'onClose', 'run', 'isRunning', 'close', 'count'];
function isListenCallback(obj) {
    if (obj == null || typeof obj != 'object')
        return false;
    const keys = new Set(Object.keys(obj));
    for (const key of LISTEN_CORE)
        if (!keys.has(key))
            return false;
    for (const key of LISTEN_CORE)
        if (typeof obj[key] != 'function')
            return false;
    return true;
}
