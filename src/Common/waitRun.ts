import { sleepAsync } from "./common";

/** Управляет запуском асинхронных функций с throttle/debounce. */
export function enhancedWaitRun() {
    let last = 0, busy = false, pending: (() => any) | undefined;
    let chain: Promise<void> = Promise.resolve();

    return {
        throttleAsync: (ms: number, func: () => any) => {
            if (busy || last + ms >= Date.now()) return;
            busy = true;
            chain = chain.then(() => {
                try { return func(); }
                finally { busy = false; last = Date.now(); }
            });
        },

        debounceAsync: (ms: number, func: () => any) => {
            if (!func) throw new Error("debounceAsync: func is undefined");
            pending = func;
            if (busy) return chain;
            busy = true;
            return chain = chain.finally(async () => {
                try { await sleepAsync(ms); await pending?.(); }
                finally { busy = false; chain = Promise.resolve(); }
            });
        },
    };
}

/** Асинхронная очередь задач с ограничением параллелизма. */
export function createAsyncQueue(concurrency = 1) {
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

    return { enqueue, onIdle, getQueueSize };
}

/** Контролирует выполнение задач в очереди с заданным параллелизмом. */
export function enhancedQueueRun(maxParallelTasks = 5) {
    const q = createAsyncQueue(maxParallelTasks);
    return {
        get queueSize() { return q.getQueueSize(); },
        enqueue: (task: () => Promise<any>) => { q.enqueue(task); },
        enqueueAndRun: (task: () => Promise<any>) => { q.enqueue(task); },
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

export function createTaskQueue() {
    let ready = false;
    const tasks: Array<() => any> = [];
    return {
        add: (fn: () => any) => ready ? void fn() : tasks.push(fn),
        setReady: async () => { ready = true; for (const fn of tasks) await fn(); tasks.length = 0; },
        isReady: () => ready,
        tasks: () => [...tasks],
    };
}