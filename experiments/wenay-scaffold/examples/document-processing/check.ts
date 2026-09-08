import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClient} from '../../../../src/Common/rcp/rpc-client'
import {startDocumentHost} from './host'
import {connectDocuments} from './client'
import type {DocumentFacade} from './service'

async function until(label: string, predicate: () => boolean) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        assert(Date.now() < deadline, 'timeout: ' + label)
        await new Promise(function wait(resolve) { setTimeout(resolve, 10) })
    }
}
async function checkRunnerFailure() {
    const host = await startDocumentHost({runner: {run(context) {
        if ((context.input as {fail?: boolean}).fail) throw new Error('processor temporarily unavailable')
        return {result: {recovered: true}}
    }}})
    let closeClient = function notConnected() {}
    try {
        const client = await connectDocuments({url: host.url, token: () => host.source.token('alice')})
        closeClient = client.close
        const upload = await client.control.startUpload({name: 'failure.txt', size: 1, mime: 'text/plain'})
        await client.resource.put(upload.file.id, new Uint8Array([65]))
        await client.control.confirmUpload(upload.file.id)
        const failed = await client.control.startJob(upload.file.id, {fail: true})
        await until('runner failure visible', () => client.store.state.jobs[failed.id]?.state == 'failed')
        assert.match(client.store.state.jobs[failed.id].error ?? '', /temporarily unavailable/)
        const download = await fetch(host.url + '/reports/' + failed.id, {headers: {authorization: 'Bearer ' + host.source.token('alice')}})
        assert(download.status >= 400, 'a failed job has no downloadable ready report')
        const next = await client.control.startJob(upload.file.id, {})
        await until('new job succeeds after runner failure', () => client.store.state.jobs[next.id]?.state == 'ready')
        assert.deepEqual(JSON.parse(JSON.stringify(client.store.state.jobs[next.id].result)), {recovered: true})
        console.log('PASS document processor: failed job, report download refused, fresh job succeeds')
    } finally {
        closeClient()
        await host.close()
    }
}
async function checkHostLifecycle() {
    let started = 0
    let cancelled = () => false
    const host = await startDocumentHost({runner: {
        run(context) {
            started++
            cancelled = context.cancelled
            return new Promise<never>(function pending() {})
        },
    }})
    const port = Number(new URL(host.url).port)
    let client: Awaited<ReturnType<typeof connectDocuments>> | undefined
    try {
        await assert.rejects(startDocumentHost({port}), {code: 'EADDRINUSE'})
        assert.equal((await fetch(host.url)).status, 200, 'failed sibling startup leaves the owner running')
        client = await connectDocuments({url: host.url, token: () => host.source.token('alice')})
        const upload = await client.control.startUpload({name: 'close.txt', size: 1, mime: 'text/plain'})
        await client.resource.put(upload.file.id, new Uint8Array([65]))
        await client.control.confirmUpload(upload.file.id)
        await client.control.startJob(upload.file.id, {})
        await until('runner started before shutdown', () => started == 1)
        const closing = host.close()
        assert.equal(host.close(), closing, 'consumer close shares completion')
        await closing
        assert.equal(cancelled(), true, 'owned work observes host shutdown')
        const replacement = await startDocumentHost({port})
        try {
            assert.equal((await fetch(replacement.url)).status, 200)
        } finally { await replacement.close() }
        console.log('PASS document host: occupied port preserves owner, shared close signals cancellation and permits port reuse')
    } finally {
        client?.close()
        await host.close()
    }
}
async function main() {
    const host = await startDocumentHost({stepMs: 150})
    const clients: Awaited<ReturnType<typeof connectDocuments>>[] = []
    try {
        const alice = await connectDocuments({url: host.url, token: () => host.source.token('alice')})
        clients.push(alice)
        const bob = await connectDocuments({url: host.url, token: () => host.source.token('bob')})
        clients.push(bob)
        const sibling = await connectDocuments({url: host.url, token: () => host.source.token('alice')})
        clients.push(sibling)
        const store = alice.store
        const bytes = new TextEncoder().encode('First document\nThree useful words')
        const upload = await alice.control.startUpload({name: 'private.txt', size: bytes.length, mime: 'text/plain'})
        await assert.rejects(alice.control.startJob(upload.file.id, {}), /uploaded|ready|upload/i)
        await assert.rejects(bob.resource.put(upload.file.id, bytes))
        await assert.rejects(bob.control.confirmUpload(upload.file.id))
        await alice.resource.put(upload.file.id, bytes)
        await alice.control.confirmUpload(upload.file.id)
        await assert.rejects(alice.resource.put(upload.file.id, bytes), /confirmed|immutable|sealed/i)
        await assert.rejects(bob.control.startJob(upload.file.id, {}))
        const job = await alice.control.startJob(upload.file.id, {})
        await until('same-account sibling follows', () => sibling.store.state.jobs[job.id] != undefined)
        sibling.close()
        await assert.rejects(sibling.resource.put(upload.file.id, bytes), /closed/)
        assert.throws(() => sibling.control.online(), /closed/)
        await until('progress over RPC', () => alice.store.state.jobs[job.id]?.progress > 0)
        await assert.rejects(bob.control.cancelJob(job.id))
        alice.control.offline()
        await new Promise(function wait(resolve) { setTimeout(resolve, 400) })
        alice.control.online()
        await until('same Store reconnect result', () => alice.store.state.jobs[job.id]?.state == 'ready')
        assert.equal(alice.store, store)
        assert.deepEqual(Object.keys(bob.store.state.files), [])
        assert.deepEqual(Object.keys(bob.store.state.jobs), [])
        const result = alice.store.state.jobs[job.id].result as {words: number, lines: number, excerpt: string}
        assert.equal(result.words, 5)
        assert.equal(result.lines, 2)
        assert.equal(result.excerpt, new TextDecoder().decode(bytes))
        const download = await alice.resource.download(upload.file.id) as {path: string}
        const original = await fetch(host.url + download.path, {headers: {authorization: 'Bearer ' + host.source.token('alice')}})
        assert.equal(await original.text(), result.excerpt)
        for (const path of [download.path, '/reports/' + job.id]) {
            const denied = await fetch(host.url + path, {headers: {authorization: 'Bearer ' + host.source.token('bob')}})
            assert(denied.status >= 400)
        }
        const report = await fetch(host.url + '/reports/' + job.id, {headers: {authorization: 'Bearer ' + host.source.token('alice')}})
        assert.equal(report.status, 200)
        assert.equal((await report.json()).words, 5)
        const cancelled = await alice.control.startJob(upload.file.id, {})
        await alice.control.cancelJob(cancelled.id)
        await until('cancelled', () => alice.store.state.jobs[cancelled.id]?.state == 'cancelled')
        await new Promise(function wait(resolve) { setTimeout(resolve, 350) })
        assert.equal(alice.store.state.jobs[cancelled.id].result, undefined)
        const invalid = await alice.control.startUpload({name: 'invalid.txt', size: 1, mime: 'text/plain'})
        await alice.resource.put(invalid.file.id, new Uint8Array([255]))
        await assert.rejects(alice.control.confirmUpload(invalid.file.id), /UTF|encoding|encoded/i)
        await until('failed upload state', () => alice.store.state.files[invalid.file.id]?.state == 'failed')
        await assert.rejects(alice.control.startJob(invalid.file.id, {}))
        const recovered = await alice.control.startJob(upload.file.id, {})
        await until('fresh job after upload failure', () => alice.store.state.jobs[recovered.id]?.state == 'ready')
        const socket = io(host.url, {transports: ['websocket'], forceNew: true})
        const anon = createRpcClient<DocumentFacade>({socket, socketKey: 'documents'})
        try {
            await anon.readyStrict()
            assert.deepEqual(Object.keys(anon.strict), [])
            await assert.rejects(anon.func.startUpload({name: 'x', size: 0}), /Unauthorized/)
        } finally {
            anon.close()
            socket.disconnect()
        }
        const html = await fetch(host.url).then(response => response.text())
        assert(html.includes('Use sample text') && html.includes('no AI model'))
        new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])
        console.log('PASS document-processing: real RPC upload/confirm/progress/cancel/failure, owner-checked bytes/report HTTP, immutable confirmed data, same Store reconnect, no AI')
    } finally {
        for (const client of clients) client.close()
        await host.close()
    }
    await checkRunnerFailure()
    await checkHostLifecycle()
}
main().catch(function failed(error) {
    console.error(error)
    process.exitCode = 1
})
