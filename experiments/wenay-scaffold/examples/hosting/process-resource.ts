import {spawn} from 'node:child_process'
import {join} from 'node:path'
import {type tRelease} from './worker'

// === The process is a resource; Contract owns its activation and lease lifetime ===
export function createAppProcess(deps: {tenant: string, release: tRelease}) {
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'worker.ts'), deps.release, deps.tenant], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    })
    let closing = false
    let exited = false
    let pending = 0
    let stderr = ''
    let url = ''
    let force: ReturnType<typeof setTimeout> | undefined
    const failures = new Set<(reason: unknown) => void>()
    let failed: unknown
    let resolveExit: () => void
    const done = new Promise<void>(function awaitExit(resolve) { resolveExit = resolve })
    child.stderr!.on('data', function errorOutput(chunk) { stderr = (stderr + String(chunk)).slice(-2000) })
    function fail(reason: unknown) {
        failed = reason
        for (const callback of failures) callback(reason)
    }
    const ready = new Promise<void>(function awaitReady(resolve, reject) {
        const timeout = setTimeout(function startupTimeout() { reject(new Error('application startup timed out')); close() }, 5000)
        child.on('message', function applicationMessage(message: unknown) {
            const fact = message as {type?: string, port?: number, pending?: number}
            if (fact.type == 'requests') pending = fact.pending ?? 0
            if (fact.type == 'ready' && Number.isInteger(fact.port)) {
                url = 'http://127.0.0.1:' + fact.port
                clearTimeout(timeout)
                resolve()
            }
        })
        child.once('error', function spawnFailed(error) {
            clearTimeout(timeout)
            exited = true
            resolveExit()
            reject(error)
            fail(error)
        })
        child.once('exit', function processExited(code) {
            clearTimeout(timeout)
            if (force) clearTimeout(force)
            exited = true
            resolveExit()
            const error = new Error(`application exited (${code}): ${stderr}`)
            reject(error)
            if (!closing) fail(error)
        })
    })
    async function request(path: string) {
        await ready
        if (exited || closing) throw new Error('application process is closed')
        const result = await fetch(url + path, {signal: AbortSignal.timeout(5000)})
        return {status: result.status, headers: Object.fromEntries(result.headers), body: await result.text()}
    }
    function close() {
        if (closing || exited) return
        closing = true
        if (child.connected) child.send({type: 'shutdown'}, function shutdownSent(error) {
            if (error && !exited) child.kill('SIGKILL')
        })
        force = setTimeout(function boundedShutdown() { child.kill('SIGKILL') }, 2500)
    }
    const onFail = {on(callback: (reason: unknown) => void) {
        failures.add(callback)
        if (failed) queueMicrotask(function reportFailure() { if (failures.has(callback)) callback(failed) })
        return function off() { failures.delete(callback) }
    }}
    return {
        ready, done, api: {request}, onFail, close,
        view: {status: () => ({tenant: deps.tenant, release: deps.release, pid: child.pid, pending, exited})},
    }
}
export type AppProcess = ReturnType<typeof createAppProcess>
