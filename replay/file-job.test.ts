// File/job resource oracle: storage bytes stay behind a port, while an
// account-filtered Store/replay mirror carries only lifecycle metadata.
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createFileJobClient, createFileJobHost} from '../src/Common/resource/resource-index'
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
    console.log('\n[file-job] storage intents + AI lifecycle over an existing RPC connection')

    const uploaded = new Set<string>()
    const releases = new Map<string, () => void>()
    const started = new Set<string>()
    const host = createFileJobHost({
        storage: {
            beginUpload: ({file}) => ({url: 'memory://upload/' + file.id, method: 'PUT'}),
            confirmUpload: ({file}) => {
                if (!uploaded.has(file.id)) throw new Error('storage did not receive bytes')
            },
            download: ({file}) => ({url: 'memory://download/' + file.id}),
        },
        runner: {
            async run({file, job, report, cancelled}) {
                started.add(job.id)
                const interimResult = {stage: {name: 'reading'}}
                report({
                    progress: 0.25,
                    message: 'AI reading ' + file.name,
                    ...(file.name == 'scan.png' ? {result: interimResult} : {}),
                })
                interimResult.stage.name = 'mutated after report'
                await new Promise<void>(resolve => releases.set(job.id, resolve))
                if (cancelled()) return
                report({progress: 0.75, message: 'AI composing result'})
                const result = {summary: 'processed ' + file.name, nested: {owned: true}}
                setTimeout(function mutateReturnedResult() { result.nested.owned = false }, 0)
                return {result}
            },
        },
        id: (() => { let n = 0; return () => 'id-' + (++n) })(),
        drain: 'micro',
    })

    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', function onConnection(socket) {
        const account = String(socket.handshake.auth?.account)
        const files = host.connection(account)
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', function onDisconnect() { disconnect(); files.close() })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {legacy: () => 'still here', files: files.fragment},
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
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
        const files = createFileJobClient({remote: clients.app.func.files, drain: 'micro'})
        await files.ready
        return {func: clients.app.func, files, close: () => hub.socket?.disconnect?.()}
    }

    const a = await connect('a')
    const b = await connect('b')
    ok(await a.func.legacy() == 'still here', 'resource fragment leaves existing RPC keys untouched')

    const startedUpload = await a.files.startUpload({name: 'scan.png', size: 12, mime: 'image/png'})
    const fileId = startedUpload.file.id
    ok((startedUpload.upload as any).url == 'memory://upload/' + fileId, 'storage port returns an opaque upload instruction')
    await waitFor('uploading file reaches owner mirror', () => a.files.store.state.files[fileId]?.state == 'uploading')
    ok(Object.keys(b.files.store.state.files).length == 0, 'other account does not see owner metadata')

    let forbidden = false
    try { await b.files.confirmUpload(fileId) } catch { forbidden = true }
    ok(forbidden, 'other account cannot confirm an unseen resource')

    uploaded.add(fileId)
    await a.files.confirmUpload(fileId)
    await waitFor('uploaded resource', () => a.files.store.state.files[fileId]?.state == 'uploaded')
    ok((await a.files.download(fileId) as any).url == 'memory://download/' + fileId, 'download instruction stays behind the storage port')

    const firstJob = await a.files.startJob(fileId, {prompt: 'summarize'})
    await waitFor('runner starts', () => started.has(firstJob.id))
    await waitFor('progress projection', () => a.files.store.state.jobs[firstJob.id]?.progress == 0.25)
    ok(a.files.store.state.jobs[firstJob.id]?.message == 'AI reading scan.png', 'progress reaches the owner through Store/replay')
    ok((host.store.state.jobs[firstJob.id]?.result as any)?.stage?.name == 'reading',
        'provider mutation after report cannot silently change the authority Store')
    ok(Object.keys(b.files.store.state.jobs).length == 0, 'other account does not see AI job state')
    releases.get(firstJob.id)!()
    await waitFor('job result', () => a.files.store.state.jobs[firstJob.id]?.state == 'ready')
    await delay(10)
    ok((a.files.store.state.jobs[firstJob.id]?.result as any)?.summary == 'processed scan.png', 'structured AI result reaches the mirror')
    ok((host.store.state.jobs[firstJob.id]?.result as any)?.nested?.owned == true,
        'provider mutation after return cannot silently change the final authority result')

    const secondUpload = await a.files.startUpload({name: 'cancel.pdf', size: 8})
    uploaded.add(secondUpload.file.id)
    await a.files.confirmUpload(secondUpload.file.id)
    const cancelledJob = await a.files.startJob(secondUpload.file.id, {prompt: 'cancel me'})
    await waitFor('second runner starts', () => started.has(cancelledJob.id))
    await a.files.cancelJob(cancelledJob.id)
    releases.get(cancelledJob.id)!()
    await waitFor('cancelled state', () => a.files.store.state.jobs[cancelledJob.id]?.state == 'cancelled')
    ok(a.files.store.state.jobs[cancelledJob.id]?.result === undefined, 'cancelled runner cannot publish a late result')

    a.files.close()
    b.files.close()
    a.close()
    b.close()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
