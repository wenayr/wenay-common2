import {listen, LISTEN_DISPATCH_ERROR} from '../events/Listen'

export type tResourceDisposer = () => void | Promise<void>

export type ResourceScopeOptions = {
    signal?: AbortSignal
    closeTimeoutMs?: number
}

/** A close deadline limits waiting, not the lifetime of an uncancellable operation. */
export class ResourceCloseTimeoutError extends Error {
    constructor(readonly timeoutMs: number) {
        super('Resource cleanup is still running after ' + timeoutMs + 'ms')
        this.name = 'ResourceCloseTimeoutError'
    }
}

export function createResourceScope(deps: ResourceScopeOptions = {}) {
    if (deps.closeTimeoutMs != undefined && (!Number.isFinite(deps.closeTimeoutMs) || deps.closeTimeoutMs < 0 || deps.closeTimeoutMs > 2_147_483_647)) {
        throw new RangeError('closeTimeoutMs must be non-negative and within the timer range')
    }
    const controller = new AbortController()
    const entries = new Set<() => Promise<void>>()
    const failures: unknown[] = []
    const [emitError, errors] = listen<[unknown]>({[LISTEN_DISPATCH_ERROR]: function observerFailed(error) {
        failures.push(error)
    }})
    let closing: Promise<void> | undefined
    let resolveSettled: () => void
    let rejectSettled: (error: unknown) => void
    const completion = new Promise<void>(function createCompletion(resolve, reject) {
        resolveSettled = resolve
        rejectSettled = reject
    })
    // Rejections remain available through close/settled and the outward error stream.
    completion.catch(function observed() {})

    function report(error: unknown) {
        failures.push(error)
        emitError(error)
    }

    // === Resource admission ===
    function own(dispose: tResourceDisposer) {
        let released: Promise<void> | undefined
        function release() {
            if (released) return released
            released = Promise.resolve().then(dispose).catch(function disposeFailed(error) {
                report(error)
                throw error
            }).finally(function removeEntry() { entries.delete(release) })
            released.catch(function observed() {})
            return released
        }
        entries.add(release)
        if (controller.signal.aborted) release()
        return release
    }

    async function acquire<T>(resource: {
        open: (signal: AbortSignal) => T | Promise<T>
        close: (value: T) => void | Promise<void>
    }) {
        controller.signal.throwIfAborted()
        // Reserve the disposal position before starting IO, including late completions.
        const value = Promise.resolve().then(function open() {
            controller.signal.throwIfAborted()
            return resource.open(controller.signal)
        })
        const release = own(async function disposeAcquired() {
            let acquired: T
            try { acquired = await value }
            catch { return }
            await resource.close(acquired)
        })
        let acquired: T
        try { acquired = await value }
        catch (error) {
            await release()
            throw error
        }
        if (controller.signal.aborted) {
            await release().catch(function preserveAbort() {})
            controller.signal.throwIfAborted()
        }
        return acquired
    }

    function parallel(disposers: readonly tResourceDisposer[]) {
        const group = [...disposers]
        return own(async function disposeParallel() {
            const results = await Promise.allSettled(group.map(function dispose(disposer) {
                return Promise.resolve().then(disposer)
            }))
            const rejected = results.filter(result => result.status == 'rejected')
            if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'Parallel resource cleanup failed')
        })
    }

    // === Lifetime ===
    async function finish() {
        while (entries.size) {
            const batch = [...entries].reverse()
            for (const release of batch) await release().catch(function continueCleanup() {})
        }
        if (failures.length) throw new AggregateError(failures, 'Resource cleanup failed')
    }

    function close() {
        if (closing) return closing
        // Publish the promise before abort handlers can re-enter close().
        if (deps.closeTimeoutMs == undefined) closing = completion
        else {
            const timeoutMs = deps.closeTimeoutMs
            closing = new Promise<void>(function boundedClose(resolve, reject) {
                const timer = setTimeout(function timedOut() { reject(new ResourceCloseTimeoutError(timeoutMs)) }, timeoutMs)
                completion.then(function finished() { clearTimeout(timer); resolve() }, function failed(error) {
                    clearTimeout(timer)
                    reject(error)
                })
            })
            closing.catch(function observed() {})
        }
        deps.signal?.removeEventListener('abort', aborted)
        controller.abort(deps.signal?.reason)
        finish().then(resolveSettled!, rejectSettled!)
        return closing
    }

    async function start<T>(work: (signal: AbortSignal) => T | Promise<T>) {
        try {
            controller.signal.throwIfAborted()
            const result = await work(controller.signal)
            controller.signal.throwIfAborted()
            return result
        } catch (error) {
            await close().catch(function preserveStartupCause() {})
            throw error
        }
    }

    function aborted() { close() }
    deps.signal?.addEventListener('abort', aborted, {once: true})
    if (deps.signal?.aborted) close()

    return {
        resource: {own, acquire, parallel},
        signal: controller.signal as AbortSignal,
        start,
        close,
        settled: () => completion,
        events: {errors: errors.on},
    }
}

export type ResourceScope = ReturnType<typeof createResourceScope>
