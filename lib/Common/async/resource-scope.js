"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResourceCloseTimeoutError = void 0;
exports.createResourceScope = createResourceScope;
const Listen_1 = require("../events/Listen");
class ResourceCloseTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super('Resource cleanup is still running after ' + timeoutMs + 'ms');
        this.timeoutMs = timeoutMs;
        this.name = 'ResourceCloseTimeoutError';
    }
}
exports.ResourceCloseTimeoutError = ResourceCloseTimeoutError;
function createResourceScope(deps = {}) {
    if (deps.closeTimeoutMs != undefined && (!Number.isFinite(deps.closeTimeoutMs) || deps.closeTimeoutMs < 0 || deps.closeTimeoutMs > 2_147_483_647)) {
        throw new RangeError('closeTimeoutMs must be non-negative and within the timer range');
    }
    const controller = new AbortController();
    const entries = new Set();
    const failures = [];
    const [emitError, errors] = (0, Listen_1.listen)({ [Listen_1.LISTEN_DISPATCH_ERROR]: function observerFailed(error) {
            failures.push(error);
        } });
    let closing;
    let resolveSettled;
    let rejectSettled;
    const completion = new Promise(function createCompletion(resolve, reject) {
        resolveSettled = resolve;
        rejectSettled = reject;
    });
    completion.catch(function observed() { });
    function report(error) {
        failures.push(error);
        emitError(error);
    }
    function own(dispose) {
        let released;
        function release() {
            if (released)
                return released;
            released = Promise.resolve().then(dispose).catch(function disposeFailed(error) {
                report(error);
                throw error;
            }).finally(function removeEntry() { entries.delete(release); });
            released.catch(function observed() { });
            return released;
        }
        entries.add(release);
        if (controller.signal.aborted)
            release();
        return release;
    }
    async function acquire(resource) {
        controller.signal.throwIfAborted();
        const value = Promise.resolve().then(function open() {
            controller.signal.throwIfAborted();
            return resource.open(controller.signal);
        });
        const release = own(async function disposeAcquired() {
            let acquired;
            try {
                acquired = await value;
            }
            catch {
                return;
            }
            await resource.close(acquired);
        });
        let acquired;
        try {
            acquired = await value;
        }
        catch (error) {
            await release();
            throw error;
        }
        if (controller.signal.aborted) {
            await release().catch(function preserveAbort() { });
            controller.signal.throwIfAborted();
        }
        return acquired;
    }
    function parallel(disposers) {
        const group = [...disposers];
        return own(async function disposeParallel() {
            const results = await Promise.allSettled(group.map(function dispose(disposer) {
                return Promise.resolve().then(disposer);
            }));
            const rejected = results.filter(result => result.status == 'rejected');
            if (rejected.length)
                throw new AggregateError(rejected.map(result => result.reason), 'Parallel resource cleanup failed');
        });
    }
    async function finish() {
        while (entries.size) {
            const batch = [...entries].reverse();
            for (const release of batch)
                await release().catch(function continueCleanup() { });
        }
        if (failures.length)
            throw new AggregateError(failures, 'Resource cleanup failed');
    }
    function close() {
        if (closing)
            return closing;
        if (deps.closeTimeoutMs == undefined)
            closing = completion;
        else {
            const timeoutMs = deps.closeTimeoutMs;
            closing = new Promise(function boundedClose(resolve, reject) {
                const timer = setTimeout(function timedOut() { reject(new ResourceCloseTimeoutError(timeoutMs)); }, timeoutMs);
                completion.then(function finished() { clearTimeout(timer); resolve(); }, function failed(error) {
                    clearTimeout(timer);
                    reject(error);
                });
            });
            closing.catch(function observed() { });
        }
        deps.signal?.removeEventListener('abort', aborted);
        controller.abort(deps.signal?.reason);
        finish().then(resolveSettled, rejectSettled);
        return closing;
    }
    async function start(work) {
        try {
            controller.signal.throwIfAborted();
            const result = await work(controller.signal);
            controller.signal.throwIfAborted();
            return result;
        }
        catch (error) {
            await close().catch(function preserveStartupCause() { });
            throw error;
        }
    }
    function aborted() { close(); }
    deps.signal?.addEventListener('abort', aborted, { once: true });
    if (deps.signal?.aborted)
        close();
    return {
        resource: { own, acquire, parallel },
        signal: controller.signal,
        start,
        close,
        settled: () => completion,
        events: { errors: errors.on },
    };
}
