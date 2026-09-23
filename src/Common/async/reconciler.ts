import {listen, LISTEN_DISPATCH_ERROR} from '../events/Listen'
import {createAsyncQueue} from './waitRun'
import {createResourceScope, type ResourceScopeOptions} from './resource-scope'

export function createReconciler<T>(deps: ResourceScopeOptions & {
    read: () => T
    run: (snapshot: T, context: {signal: AbortSignal, retry: (key: string, delayMs: number) => void}) => void | Promise<void>
    subscribe?: (request: () => void) => () => void
}) {
    const scope = createResourceScope(deps)
    const queue = createAsyncQueue(1)
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    let pending = false
    let scheduled = false
    const [emitError, errors] = listen<[unknown]>({[LISTEN_DISPATCH_ERROR]: function observerFailed(error) {
        // Keep observer failures visible without recursively dispatching to that observer.
        lastError = error
    }})
    let lastError: unknown
    scope.resource.own(scope.events.errors(report))
    scope.resource.own(queue.onIdle)

    function report(error: unknown) {
        lastError = error
        emitError(error)
    }

    function cancelRetry(key: string) {
        const timer = timers.get(key)
        if (timer == undefined) return
        clearTimeout(timer)
        timers.delete(key)
    }

    function clearRetries() {
        for (const key of timers.keys()) cancelRetry(key)
    }

    function retry(key: string, delayMs: number) {
        if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 2_147_483_647) {
            throw new RangeError('Retry delay must be positive and within the timer range')
        }
        if (scope.signal.aborted || timers.has(key)) return
        timers.set(key, setTimeout(function wake() {
            timers.delete(key)
            request()
        }, delayMs))
    }

    async function drain() {
        // Coalesce synchronous notifications before reading the first snapshot too.
        await Promise.resolve()
        try {
            while (pending && !scope.signal.aborted) {
                pending = false
                clearRetries()
                try { await deps.run(deps.read(), {signal: scope.signal, retry}) }
                catch (error) {
                    pending = false
                    if (!scope.signal.aborted) report(error)
                    break
                }
                // A failed pass can defer its accumulated notifications to a keyed retry.
                if (timers.size) { pending = false; break }
            }
        } finally {
            scheduled = false
            if (pending && !scope.signal.aborted) request()
        }
    }

    function request() {
        if (scope.signal.aborted) return
        pending = true
        if (scheduled) return
        scheduled = true
        queue.add(drain).catch(report)
    }

    function stopped() {
        pending = false
        clearRetries()
    }
    scope.signal.addEventListener('abort', stopped, {once: true})
    scope.resource.own(function removeAbortListener() { scope.signal.removeEventListener('abort', stopped) })
    try {
        if (!scope.signal.aborted && deps.subscribe) scope.resource.own(deps.subscribe(request))
    } catch (error) {
        scope.close()
        throw error
    }

    return {
        control: {request, retry, cancelRetry, idle: queue.onIdle},
        events: {errors: errors.on},
        view: {error: () => lastError},
        signal: scope.signal,
        close: scope.close,
        settled: scope.settled,
    }
}

export type Reconciler<T> = ReturnType<typeof createReconciler<T>>
