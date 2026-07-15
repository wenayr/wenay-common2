// AI run oracle: idempotent commands plus account-filtered Store/replay state
// and resumable semantic events over a real Socket.IO/RPC connection.
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createAiRunClient, createAiRunHost, AiRunEvent} from '../src/Common/ai/ai-index'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 150; i++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

async function main() {
    console.log('\n[ai-run] idempotent AI lifecycle, approvals and resume over an existing RPC connection')

    const starts = new Map<string, number>()
    const releases = new Map<string, () => void>()
    const providerCancels = new Set<string>()
    const host = createAiRunHost({
        capabilities: [{kind: 'assistant', label: 'Interactive assistant'}, {kind: 'slow', label: 'Slow task'}],
        runner: {
            async run({run, input, report, emit, artifact, requestApproval, waitForInput, cancelled}) {
                starts.set(run.id, (starts.get(run.id) ?? 0) + 1)
                report({progress: 0.2, message: 'model is preparing'})
                emit({type: 'text.delta', text: 'Hello '})
                if (run.kind == 'slow') {
                    await new Promise<void>(resolve => releases.set(run.id, resolve))
                    emit({type: 'text.delta', text: 'late output'})
                    return {result: {late: true}}
                }
                const decision = await requestApproval({kind: 'tool', label: 'Allow demo tool?'})
                if (decision == 'rejected') return {result: {stopped: 'tool rejected'}}
                const note = await waitForInput({label: 'Add a note', schema: {type: 'string'}})
                if (cancelled()) return
                report({progress: 0.8, message: 'model is completing', usage: {inputTokens: 3, outputTokens: 5, totalTokens: 8}})
                emit({type: 'text.delta', text: String((input as any).prompt) + ': ' + String(note)})
                artifact({kind: 'report', label: 'AI report', descriptor: {safe: true}})
                return {result: {answer: 'done'}, usage: {inputTokens: 3, outputTokens: 5, totalTokens: 8}}
            },
            cancel({run}) { providerCancels.add(run.id) },
        },
        id: (() => { let n = 0; return () => 'ai-' + (++n) })(),
        drain: 'micro',
    })

    const httpServer = createServer()
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', function onConnection(socket) {
        const account = String(socket.handshake.auth?.account)
        const ai = host.connection(account)
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', function onDisconnect() { disconnect(); ai.close() })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {legacy: () => 'still here', ai: ai.fragment},
            disconnectListen,
        })
    })
    await new Promise<void>(function listen(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port

    async function connect(account: string) {
        const hub = createRpcClientHub(
            () => io('http://127.0.0.1:' + port, {transports: ['websocket'], forceNew: true, auth: {account}}),
            rpc => ({app: rpc<any>('app')}),
        )
        const clients = await hub.setToken(null)
        await clients.app.readyStrict()
        const ai = createAiRunClient({remote: clients.app.func.ai, drain: 'micro'})
        const events: AiRunEvent[] = []
        ai.events.on(function rememberEvent(event) { events.push(event) })
        await ai.ready
        return {func: clients.app.func, ai, events, close: () => hub.socket?.disconnect?.()}
    }

    const a = await connect('a')
    const b = await connect('b')
    ok(await a.func.legacy() == 'still here', 'AI fragment leaves existing RPC keys untouched')
    ok((await a.ai.capabilities()).some(capability => capability.kind == 'assistant'), 'capability discovery reaches the RPC client')

    const request = {requestId: 'retry-1', kind: 'assistant', input: {prompt: 'summarize'}, resourceIds: ['resource-7']}
    const run = await a.ai.createRun(request)
    const retry = await a.ai.createRun(request)
    ok(retry.id == run.id, 'same owner requestId returns the original run')
    await waitFor('approval request', () => a.ai.store.state.runs[run.id]?.state == 'waiting_approval')
    ok(starts.get(run.id) == 1, 'idempotent retry starts the runner once')
    ok(a.ai.store.state.runs[run.id]?.resourceIds[0] == 'resource-7', 'only opaque resource ids cross the AI protocol')
    ok(Object.keys(b.ai.store.state.runs).length == 0, 'other account does not see run state')

    const approvalId = Object.keys(a.ai.store.state.approvals)[0]
    let forbidden = false
    try { await b.ai.resolveApproval(approvalId, 'approved') } catch { forbidden = true }
    ok(forbidden, 'other account cannot resolve an approval')

    await a.ai.resolveApproval(approvalId, 'approved')
    await waitFor('input request', () => a.ai.store.state.runs[run.id]?.state == 'waiting_input')
    const inputId = Object.keys(a.ai.store.state.inputs)[0]
    await a.ai.provideInput(inputId, 'verified')
    await waitFor('completed run', () => a.ai.store.state.runs[run.id]?.state == 'completed')
    ok((a.ai.store.state.runs[run.id]?.result as any)?.answer == 'done', 'small structured final result survives in durable state')
    ok(a.ai.store.state.runs[run.id]?.artifacts[0]?.kind == 'report', 'output artifact remains a descriptor, not bytes')
    ok(a.events.some(event => event.type == 'text.delta'), 'semantic text deltas reach the owner event line')
    ok(a.events.some(event => event.type == 'approval.requested'), 'approval event reaches the owner event line')

    const reconnected = await connect('a')
    await waitFor('reconnected state', () => reconnected.ai.store.state.runs[run.id]?.state == 'completed')
    const retriedAfterReconnect = await reconnected.ai.createRun(request)
    ok(retriedAfterReconnect.id == run.id && starts.get(run.id) == 1, 'reconnect plus retry cannot duplicate an AI side effect')
    ok(reconnected.events.some(event => event.type == 'sync' && event.runs.some(saved => saved.id == run.id)), 'new connection receives an event sync keyframe')

    const slow = await a.ai.createRun({requestId: 'cancel-1', kind: 'slow', input: {prompt: 'stop'}})
    await waitFor('slow runner starts', () => starts.has(slow.id))
    await a.ai.cancelRun(slow.id, 'user stopped')
    releases.get(slow.id)!()
    await waitFor('cancelled run', () => a.ai.store.state.runs[slow.id]?.state == 'cancelled')
    await delay(20)
    ok(providerCancels.has(slow.id), 'cancel invokes the optional provider abort port')
    ok(a.ai.store.state.runs[slow.id]?.result == null, 'late runner result is ignored after cancellation')
    ok(!a.events.some(event => event.type == 'text.delta' && event.runId == slow.id && event.text == 'late output'), 'late semantic events are ignored after cancellation')

    a.ai.close()
    b.ai.close()
    reconnected.ai.close()
    a.close()
    b.close()
    reconnected.close()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
