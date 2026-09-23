import {createAiRunHost, type AiRun, type AiRunCheckpoint, type AiRunPersistencePort, type AiRunRunner} from '../src/Common/ai/ai-index'
import {createServiceLeaderHost, type ServiceHostOptions} from '../src/service/host'

function check(initial: AiRunCheckpoint | undefined) {
    const persistence: AiRunPersistencePort = {commit(checkpoint) { const version: 1 = checkpoint.version; void version }}
    const runner: AiRunRunner = {run() {}, recover({checkpoint, waitForInput}) {
        const requestId: string = checkpoint.request.requestId
        void requestId
        void waitForInput({id: 'old-input', label: 'Answer'})
        return {result: 'reconciled'}
    }}
    const host = createAiRunHost({initial, persistence, runner})
    const run: AiRun = host.connection('owner').fragment.createRun({requestId: 'one', kind: 'fixture', input: {}})
    const saved: AiRunCheckpoint = host.persistence.snapshot()
    const recovery: Promise<AiRun> = host.recovery.resume(run.id)
    // @ts-expect-error the existing synchronous command contract is retained
    const promise: Promise<AiRun> = run
    // @ts-expect-error async commit cannot acknowledge a synchronous command boundary
    const asyncPort: AiRunPersistencePort = {async commit(_checkpoint) {}}
    const options: ServiceHostOptions = {host: '127.0.0.1', publicUrl: 'https://service.example'}
    const hosted = createServiceLeaderHost({definition: {name: 'address', storeId: 'address', originId: 'authority', initial: {}, commands: {}}, ...options})
    void hosted.then(host => { const publicUrl: string = host.publicUrl; void publicUrl })
    void saved; void recovery; void promise; void asyncPort
}
void check
