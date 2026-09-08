import {io} from 'socket.io-client'
import {Resource} from '../../../../src'
import {createRpcClientHub} from '../../../../src/Common/rcp/rpc-clientHub'
import type {DocumentFacade} from './service'

export async function connectDocuments(deps: {url: string, token: () => string}) {
    let closed = false
    const uploads = new Set<AbortController>()
    function requireOpen() { if (closed) throw new Error('document client closed') }
    const hub = createRpcClientHub(() => io(deps.url, {transports: ['websocket'], forceNew: true}),
        rpc => ({documents: rpc<DocumentFacade>('documents')}), {token: deps.token})
    try {
        const remote = await hub.promise
        await remote.documents.readyStrict()
        const client = Resource.createFileJobClient({remote: remote.documents.func})
        try { await client.ready } catch (error) {
            client.close()
            throw error
        }
        async function put(fileId: string, bytes: Uint8Array) {
            requireOpen()
            const controller = new AbortController()
            uploads.add(controller)
            try {
                const response = await fetch(deps.url + '/bytes/' + encodeURIComponent(fileId), {
                    method: 'PUT', headers: {authorization: 'Bearer ' + deps.token(), 'content-type': 'application/octet-stream'},
                    body: Buffer.from(bytes), signal: controller.signal,
                })
                if (!response.ok) throw new Error(await response.text())
            } finally { uploads.delete(controller) }
        }
        return {store: client.store,
            control: {startUpload: client.startUpload, confirmUpload: client.confirmUpload, startJob: client.startJob, cancelJob: client.cancelJob,
                offline() {
                    requireOpen()
                    hub.socket.disconnect()
                },
                online() {
                    requireOpen()
                    hub.socket.connect()
                }},
            resource: {put, download: client.download},
            close() {
                if (closed) return
                closed = true
                for (const upload of uploads) upload.abort()
                client.close()
                hub.close()
            },
        }
    } catch (error) {
        hub.close()
        throw error
    }
}
export type DocumentClient = Awaited<ReturnType<typeof connectDocuments>>
