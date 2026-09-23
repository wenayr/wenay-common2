"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReconciler = createReconciler;
const Listen_1 = require("../events/Listen");
const waitRun_1 = require("./waitRun");
const resource_scope_1 = require("./resource-scope");
function createReconciler(deps) {
    const scope = (0, resource_scope_1.createResourceScope)(deps);
    const queue = (0, waitRun_1.createAsyncQueue)(1);
    const timers = new Map();
    let pending = false;
    let scheduled = false;
    const [emitError, errors] = (0, Listen_1.listen)({ [Listen_1.LISTEN_DISPATCH_ERROR]: function observerFailed(error) {
            lastError = error;
        } });
    let lastError;
    scope.resource.own(scope.events.errors(report));
    scope.resource.own(queue.onIdle);
    function report(error) {
        lastError = error;
        emitError(error);
    }
    function cancelRetry(key) {
        const timer = timers.get(key);
        if (timer == undefined)
            return;
        clearTimeout(timer);
        timers.delete(key);
    }
    function clearRetries() {
        for (const key of timers.keys())
            cancelRetry(key);
    }
    function retry(key, delayMs) {
        if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 2_147_483_647) {
            throw new RangeError('Retry delay must be positive and within the timer range');
        }
        if (scope.signal.aborted || timers.has(key))
            return;
        timers.set(key, setTimeout(function wake() {
            timers.delete(key);
            request();
        }, delayMs));
    }
    async function drain() {
        await Promise.resolve();
        try {
            while (pending && !scope.signal.aborted) {
                pending = false;
                clearRetries();
                try {
                    await deps.run(deps.read(), { signal: scope.signal, retry });
                }
                catch (error) {
                    pending = false;
                    if (!scope.signal.aborted)
                        report(error);
                    break;
                }
                if (timers.size) {
                    pending = false;
                    break;
                }
            }
        }
        finally {
            scheduled = false;
            if (pending && !scope.signal.aborted)
                request();
        }
    }
    function request() {
        if (scope.signal.aborted)
            return;
        pending = true;
        if (scheduled)
            return;
        scheduled = true;
        queue.add(drain).catch(report);
    }
    function stopped() {
        pending = false;
        clearRetries();
    }
    scope.signal.addEventListener('abort', stopped, { once: true });
    scope.resource.own(function removeAbortListener() { scope.signal.removeEventListener('abort', stopped); });
    try {
        if (!scope.signal.aborted && deps.subscribe)
            scope.resource.own(deps.subscribe(request));
    }
    catch (error) {
        scope.close();
        throw error;
    }
    return {
        control: { request, retry, cancelRetry, idle: queue.onIdle },
        events: { errors: errors.on },
        view: { error: () => lastError },
        signal: scope.signal,
        close: scope.close,
        settled: scope.settled,
    };
}
