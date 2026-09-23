export type tServiceDisposer = () => void | Promise<void>
export type ServiceHostOptions = {
    /** Bind interface; defaults to SERVICE_HOST, then the HTTP server default. */
    host?: string
    /** Trusted advertised HTTP(S) origin; defaults to SERVICE_PUBLIC_URL, then the listener URL. */
    publicUrl?: string
    origins?: readonly string[]
    closeTimeoutMs?: number
    startTimeoutMs?: number
    signal?: AbortSignal
}

// Private ownership scope: callers supply mount cancellation, resources supply actual teardown.
export function createHostLifecycle(deps: ServiceHostOptions) {
    const closeTimeoutMs = deps.closeTimeoutMs ?? 2000
    const startTimeoutMs = deps.startTimeoutMs ?? 10_000
    for (const budget of [closeTimeoutMs, startTimeoutMs]) {
        if (!Number.isFinite(budget) || budget < 0) throw new Error('invalid service host timeout')
    }
    const controller = new AbortController()
    const disposers: tServiceDisposer[] = []
    let closing: Promise<void> | undefined
    function own(dispose: tServiceDisposer) {
        if (controller.signal.aborted) void Promise.resolve().then(dispose).catch(function lateCleanupFailed() {})
        else disposers.push(dispose)
    }
    function close() {
        if (closing) return closing
        let resolve!: () => void
        let reject!: (error: unknown) => void
        closing = new Promise<void>(function completion(ok, fail) { resolve = ok; reject = fail })
        controller.abort(new Error('service host closed'))
        deps.signal?.removeEventListener('abort', aborted)
        void finish().then(resolve, reject)
        return closing
    }
    async function finish() {
        const tasks = disposers.splice(0).reverse().map(dispose => Promise.resolve().then(dispose))
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const results = await Promise.race([
                Promise.allSettled(tasks),
                new Promise<never>(function timeout(_resolve, reject) {
                    timer = setTimeout(function expired() { reject(new Error('service host cleanup timed out')) }, closeTimeoutMs)
                }),
            ])
            const errors = results.filter(result => result.status == 'rejected').map(result => result.reason)
            if (errors.length) throw new AggregateError(errors, 'service host cleanup failed')
        } finally { clearTimeout(timer) }
    }
    function aborted() { void close().catch(function abortCleanupFailed() {}) }
    deps.signal?.addEventListener('abort', aborted, {once: true})
    if (deps.signal?.aborted) aborted()

    async function start<T>(work: () => Promise<T>) {
        let timer: ReturnType<typeof setTimeout> | undefined
        let off = () => {}
        try {
            if (controller.signal.aborted) throw controller.signal.reason
            return await Promise.race([
                Promise.resolve().then(work),
                new Promise<never>(function cancelled(_resolve, reject) {
                    function abort() { reject(controller.signal.reason) }
                    controller.signal.addEventListener('abort', abort, {once: true})
                    off = () => controller.signal.removeEventListener('abort', abort)
                    timer = setTimeout(function expired() { reject(new Error('service host startup timed out')) }, startTimeoutMs)
                }),
            ])
        } catch (error) {
            await close().catch(function preserveStartupError() {})
            throw error
        } finally { clearTimeout(timer); off() }
    }
    return {own, start, close, signal: controller.signal as AbortSignal}
}

/** Optional process adapter. Never calls process.exit; removes its handlers on explicit close. */
export function installServiceSignals(deps: {close: tServiceDisposer}) {
    let closing: Promise<void> | undefined
    function remove() {
        process.off('SIGTERM', signalled)
        process.off('SIGINT', signalled)
        process.off('message', message)
    }
    function close() {
        if (closing) return closing
        remove()
        closing = Promise.resolve().then(deps.close).finally(function releaseIpc() {
            if (process.connected) process.disconnect?.()
        })
        return closing
    }
    function signalled() {
        void close().catch(function failed(error) { console.error(error); process.exitCode = 1 })
    }
    function message(value: unknown) {
        if (value == 'shutdown' || (typeof value == 'object' && value != null && 'type' in value && value.type == 'shutdown')) signalled()
    }
    process.once('SIGTERM', signalled)
    process.once('SIGINT', signalled)
    process.on('message', message)
    return {close, remove}
}
