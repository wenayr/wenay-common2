import {join} from 'node:path'
import {createProcessResource} from '../../../../src/server/process-resource'
import {type tRelease} from './worker'

// === Product HTTP protocol over the shared child-process resource ===
export function createAppProcess(deps: {tenant: string, release: tRelease}) {
    let pending = 0
    let closing = false
    const child = createProcessResource({
        command: process.execPath, args: ['--import', 'tsx', join(__dirname, 'worker.ts'), deps.release, deps.tenant],
        ipc: true, startTimeoutMs: 5000, stopTimeoutMs: 2500, tailChars: 2000,
        ready(fact) {
            if (fact.type != 'message') return
            const message = fact.value as {type?: string, port?: number}
            if (message?.type == 'ready' && Number.isInteger(message.port)) return 'http://127.0.0.1:' + message.port
        },
        shutdown(process) {
            if (process.connected) process.send({type: 'shutdown'}, function sent(error) { if (error) process.kill('SIGKILL') })
            else process.kill('SIGKILL')
        },
    })
    child.events.message.on(function requests(value) {
        const message = value as {type?: string, pending?: number}
        if (message?.type == 'requests') pending = message.pending ?? 0
    })
    const ready = child.ready.then(function prepared() {})
    async function request(path: string) {
        const url = await child.ready
        if (child.view.stopped() || closing) throw new Error('application process is closed')
        const result = await fetch(url + path, {signal: AbortSignal.timeout(5000)})
        return {status: result.status, headers: Object.fromEntries(result.headers), body: await result.text()}
    }
    function close() { closing = true; return child.close() }
    return {
        ready, done: child.done, api: {request}, onFail: child.events.failure, close,
        view: {status: () => ({tenant: deps.tenant, release: deps.release, pid: child.view.pid(), pending, exited: child.view.stopped()})},
    }
}
export type AppProcess = ReturnType<typeof createAppProcess>
