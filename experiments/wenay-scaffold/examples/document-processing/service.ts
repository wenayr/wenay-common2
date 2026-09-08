import {Resource} from '../../../../src'
import {createDocumentStorage} from './storage'
import {createTextProcessor} from './provider'

export const DEMO_ACCOUNTS = ['alice', 'bob'] as const
export type tAccount = typeof DEMO_ACCOUNTS[number]

export function createDocumentService(deps: {stepMs?: number, runner?: Resource.FileJobRunner} = {}) {
    const storage = createDocumentStorage()
    const processor = createTextProcessor({storage, stepMs: deps.stepMs})
    const host = Resource.createFileJobHost({storage: storage.port, runner: deps.runner ?? processor.runner})
    const connections = new Map<tAccount, ReturnType<typeof host.connection>>()
    for (const account of DEMO_ACCOUNTS) connections.set(account, host.connection(account))
    function principal(account: string) {
        const connection = connections.get(account as tAccount)
        if (!connection) throw new Error('unknown demo account')
        return connection.fragment
    }
    function snapshot(account: tAccount) {
        return {
            files: Object.values(host.store.state.files).filter(file => file.owner == account).map(file => ({...file})),
            jobs: Object.values(host.store.state.jobs).filter(job => job.owner == account).map(job => ({...job})),
        }
    }
    function report(account: tAccount, jobId: string) {
        const job = host.store.state.jobs[jobId]
        if (!job || job.owner != account) throw new Error('report unavailable')
        if (job.state != 'ready') throw new Error('report is not ready')
        return job.result
    }
    function close() {
        host.close()
        processor.close()
        for (const connection of connections.values()) connection.close()
        connections.clear()
        storage.close()
    }
    return {source: {principal}, resource: storage, view: {snapshot, report}, close}
}
export type DocumentService = ReturnType<typeof createDocumentService>
export type DocumentFacade = ReturnType<DocumentService['source']['principal']>
