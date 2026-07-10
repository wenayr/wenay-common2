"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTaskQueue = exports.enhancedWaitRun = void 0;
exports.createThrottle = createThrottle;
exports.createAsyncQueue = createAsyncQueue;
exports.enhancedQueueRun = enhancedQueueRun;
exports.waitRun = waitRun;
exports.queueRun = queueRun;
exports.createReadyGate = createReadyGate;
const common_1 = require("../core/common");
function createThrottle() {
    let last = 0, busy = false, pending;
    let chain = Promise.resolve();
    const throttle = (ms, func) => {
        if (busy || last + ms >= Date.now())
            return;
        busy = true;
        chain = chain.catch(() => { }).then(async () => {
            try {
                return await func();
            }
            finally {
                busy = false;
                last = Date.now();
            }
        }).catch(() => { });
    };
    const debounce = (ms, func) => {
        if (!func)
            throw new Error("debounceAsync: func is undefined");
        pending = func;
        if (busy)
            return chain;
        busy = true;
        return chain = chain.finally(async () => {
            try {
                await (0, common_1.sleepAsync)(ms);
                await pending?.();
            }
            finally {
                busy = false;
                chain = Promise.resolve();
            }
        });
    };
    return {
        throttle,
        debounce,
        throttleAsync: throttle,
        debounceAsync: debounce,
    };
}
exports.enhancedWaitRun = createThrottle;
function createAsyncQueue(concurrency = 1) {
    if (concurrency < 1)
        throw new Error("createAsyncQueue: concurrency must be >= 1");
    const queue = [];
    let active = 0, resolveIdle = null, idle = null;
    const drain = () => {
        if (active === 0 && !queue.length && resolveIdle) {
            resolveIdle();
            resolveIdle = idle = null;
        }
        while (active < concurrency && queue.length) {
            const t = queue.shift();
            active++;
            t().finally(() => { active--; drain(); });
        }
    };
    const enqueue = (task) => new Promise((res, rej) => { queue.push(async () => { try {
        res(await task());
    }
    catch (e) {
        rej(e);
    } }); drain(); });
    const onIdle = () => idle ??= new Promise(r => (active === 0 && !queue.length) ? r() : (resolveIdle = r));
    const getQueueSize = () => queue.length;
    return {
        add: enqueue,
        onIdle,
        get size() { return queue.length; },
        enqueue,
        getQueueSize,
    };
}
function enhancedQueueRun(maxParallelTasks = 5) {
    const q = createAsyncQueue(maxParallelTasks);
    return {
        get queueSize() { return q.getQueueSize(); },
        enqueue: (task) => { q.enqueue(task).catch(() => { }); },
        enqueueAndRun: (task) => q.enqueue(task),
        runAll: () => q.onIdle(),
    };
}
function waitRun() {
    const w = (0, exports.enhancedWaitRun)();
    return { refreshAsync: w.throttleAsync, refreshAsync2: w.debounceAsync };
}
function queueRun(n = 5) {
    const q = enhancedQueueRun(n);
    return {
        get size() { return q.queueSize; },
        set next(task) { q.enqueue(task); },
        set nextRun(task) { q.enqueueAndRun(task); },
        run: () => q.runAll(),
    };
}
function createReadyGate() {
    let isReadyFlag = false;
    const tasks = [];
    const setReady = async () => {
        isReadyFlag = true;
        const run = tasks.splice(0);
        let err;
        for (const fn of run) {
            try {
                await fn();
            }
            catch (e) {
                err ??= e;
            }
        }
        if (err !== undefined)
            throw err;
    };
    return {
        add: (fn) => isReadyFlag ? void fn() : tasks.push(fn),
        ready: setReady,
        isReady: () => isReadyFlag,
        tasks: () => [...tasks],
        setReady,
    };
}
exports.createTaskQueue = createReadyGate;
