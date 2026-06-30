import { sleepAsync } from "../core/common";

/**
 * Управляет запуском асинхронных функций с throttle/debounce.
 *
 * Поведение отличается от lodash: вызовы chain'ятся (никаких перекрывающихся
 * запусков); throttle = leading-edge fire-and-forget, debounce = trailing.
 */
export function createThrottle() {
    let last = 0, busy = false, pending: (() => any) | undefined;
    let chain: Promise<void> = Promise.resolve();

    const throttle = (ms: number, func: () => any) => {
        if (busy || last + ms >= Date.now()) return;
        busy = true;
        chain = chain.catch(() => {}).then(async () => {
            try { return await func(); }
            finally { busy = false; last = Date.now(); }
        }).catch(() => {});
    };

    const debounce = (ms: number, func: () => any) => {
        if (!func) throw new Error("debounceAsync: func is undefined");
        pending = func;
        if (busy) return chain;
        busy = true;
        return chain = chain.finally(async () => {
            try { await sleepAsync(ms); await pending?.(); }
            finally { busy = false; chain = Promise.resolve(); }
        });
    };

    return {
        throttle,
        debounce,
        /** @deprecated use `throttle` */
        throttleAsync: throttle,
        /** @deprecated use `debounce` */
        debounceAsync: debounce,
    };
}

/** @deprecated use `createThrottle` */
export const enhancedWaitRun = createThrottle;

/** Асинхронная очередь задач с ограничением параллелизма. */
export function createAsyncQueue(concurrency = 1) {
    if (concurrency < 1) throw new Error("createAsyncQueue: concurrency must be >= 1");
    type Task<T = any> = () => Promise<T>;
    const queue: Task[] = [];
    let active = 0, resolveIdle: (() => void) | null = null, idle: Promise<void> | null = null;

    const drain = (): void => {
        if (active === 0 && !queue.length && resolveIdle) { resolveIdle(); resolveIdle = idle = null; }
        while (active < concurrency && queue.length) {
            const t = queue.shift()!;
            active++;
            t().finally(() => { active--; drain(); });
        }
    };

    const enqueue = <T>(task: Task<T>): Promise<T> =>
        new Promise<T>((res, rej) => { queue.push(async () => { try { res(await task()); } catch (e) { rej(e); } }); drain(); });

    const onIdle = (): Promise<void> =>
        idle ??= new Promise(r => (active === 0 && !queue.length) ? r() : (resolveIdle = r));

    const getQueueSize = () => queue.length;

    return {
        add: enqueue,
        onIdle,
        get size() { return queue.length; },
        /** @deprecated use `add` */
        enqueue,
        /** @deprecated use `size` */
        getQueueSize,
    };
}

/** Контролирует выполнение задач в очереди с заданным параллелизмом. */
export function enhancedQueueRun(maxParallelTasks = 5) {
    const q = createAsyncQueue(maxParallelTasks);
    return {
        get queueSize() { return q.getQueueSize(); },
        enqueue: (task: () => Promise<any>) => { q.enqueue(task).catch(() => {}); },
        // в отличие от enqueue (fire-and-forget) возвращает промис задачи — можно дождаться её выполнения
        enqueueAndRun: (task: () => Promise<any>) => q.enqueue(task),
        runAll: () => q.onIdle(),
    };
}

export function waitRun() {
    const w = enhancedWaitRun();
    return { refreshAsync: w.throttleAsync, refreshAsync2: w.debounceAsync };
}

export function queueRun(n = 5) {
    const q = enhancedQueueRun(n);
    return {
        get size() { return q.queueSize; },
        set next(task: () => Promise<any>) { q.enqueue(task); },
        set nextRun(task: () => Promise<any>) { q.enqueueAndRun(task); },
        run: () => q.runAll(),
    };
}

/** Буфер задач, который копит fn'ы и спускает их по порядку при `ready()`. */
export function createReadyGate() {
    let isReadyFlag = false;
    const tasks: Array<() => any> = [];
    const setReady = async () => {
        isReadyFlag = true;
        const run = tasks.splice(0);
        let err: any;
        for (const fn of run) {
            try { await fn(); }
            catch (e) { err ??= e; }
        }
        if (err !== undefined) throw err;
    };
    return {
        add: (fn: () => any) => isReadyFlag ? void fn() : tasks.push(fn),
        ready: setReady,
        isReady: () => isReadyFlag,
        tasks: () => [...tasks],
        /** @deprecated use `ready` */
        setReady,
    };
}

/** @deprecated use `createReadyGate` */
export const createTaskQueue = createReadyGate;
