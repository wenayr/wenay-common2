import {spawn, type ChildProcess} from 'node:child_process'
import {listen} from '../Common/events/Listen'

export type ProcessResourceDeps<T> = {
    command: string
    args?: readonly string[]
    cwd?: string
    /** Passed verbatim; omit to inherit. No shell interpolation. */
    env?: NodeJS.ProcessEnv
    ipc?: boolean
    /** undefined means not ready yet. Called for IPC and output facts. */
    ready: (fact: {type: 'message', value: unknown} | {type: 'stdout' | 'stderr', value: string, tail: string}) => T | undefined
    startTimeoutMs?: number
    stopTimeoutMs?: number
    tailChars?: number
    signal?: AbortSignal
    /** Defaults to SIGTERM. IPC applications can send their own shutdown message here. */
    shutdown?: (child: ChildProcess) => void | Promise<void>
}

/** Owns one directly spawned child; scheduling, descendants and restart policy belong to the host. */
export function createProcessResource<T>(deps: ProcessResourceDeps<T>) {
    const startMs = deps.startTimeoutMs ?? 10_000
    const stopMs = deps.stopTimeoutMs ?? 2000
    const tailChars = deps.tailChars ?? 12_000
    for (const value of [startMs, stopMs, tailChars]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid process resource limit')
    }
    if (deps.signal?.aborted) throw new Error('process start cancelled')
    const child = spawn(deps.command, [...deps.args ?? []], {
        cwd: deps.cwd, env: deps.env, windowsHide: true, shell: false,
        stdio: deps.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    })
    const [emitFailure, failures] = listen<[unknown]>()
    const [emitMessage, messages] = listen<[unknown]>()
    let output = ''
    let ended = false
    let prepared = false
    let stopping: Promise<void> | undefined
    let failure: unknown
    let resolveReady!: (value: T) => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<T>(function completion(resolve, reject) { resolveReady = resolve; rejectReady = reject })
    void ready.catch(function observed() {})
    let resolveDone!: () => void
    const done = new Promise<void>(function completion(resolve) { resolveDone = resolve })
    const deadline = setTimeout(function startupExpired() {
        fail(new Error('process startup timed out: ' + output))
        void close()
    }, startMs)
    function fail(error: unknown) {
        if (failure) return
        failure = error
        rejectReady(error)
        emitFailure(error)
    }
    function recognize(fact: Parameters<typeof deps.ready>[0]) {
        if (prepared || stopping || ended) return
        try {
            const value = deps.ready(fact)
            if (value != undefined) { prepared = true; clearTimeout(deadline); resolveReady(value) }
        } catch (error) { fail(error); void close() }
    }
    function capture(type: 'stdout' | 'stderr', chunk: Buffer) {
        const value = chunk.toString()
        output = tailChars ? (output + value).slice(-tailChars) : ''
        recognize({type, value, tail: output})
    }
    child.stdout?.on('data', function stdout(chunk: Buffer) { capture('stdout', chunk) })
    child.stderr?.on('data', function stderr(chunk: Buffer) { capture('stderr', chunk) })
    child.on('message', function message(value) { emitMessage(value); recognize({type: 'message', value}) })
    child.once('error', function error(error) { fail(error) })
    // close follows stdio shutdown; exit alone can leave pipe resources alive.
    child.once('close', function closed(code, signal) {
        ended = true
        clearTimeout(deadline)
        deps.signal?.removeEventListener('abort', cancelled)
        if (!stopping) fail(new Error(`process exited (${code ?? signal}): ${output}`))
        rejectReady(new Error('process closed before readiness'))
        resolveDone()
        failures.close()
        messages.close()
    })
    function close() {
        if (stopping) return stopping
        clearTimeout(deadline)
        rejectReady(new Error('process closed before readiness'))
        stopping = Promise.resolve().then(stop)
        return stopping
    }
    async function stop() {
        if (ended) return
        const force = setTimeout(function kill() { if (!ended) child.kill('SIGKILL') }, stopMs)
        try {
            // A hung custom shutdown cannot postpone force-kill or completion.
            void Promise.resolve().then(function requestStop() {
                if (deps.shutdown) return deps.shutdown(child)
                child.kill('SIGTERM')
            }).catch(function forceAfterFailure() { if (!ended) child.kill('SIGKILL') })
            await done
        } finally { clearTimeout(force) }
    }
    function cancelled() { void close() }
    deps.signal?.addEventListener('abort', cancelled, {once: true})
    if (deps.signal?.aborted) cancelled()
    return {
        ready, done, close,
        events: {failure: {on: failures.on}, message: {on: messages.on}},
        view: {pid: () => child.pid, stopped: () => ended, output: () => output, failure: () => failure},
    }
}
export type ProcessResource<T> = ReturnType<typeof createProcessResource<T>>
