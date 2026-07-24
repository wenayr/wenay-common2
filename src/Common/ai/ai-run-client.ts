// =====================================================================
// AI run client — local state mirror + semantic event line over RPC
// =====================================================================

import {createStore, StoreDrain} from '../Observe/store'
import {StoreReplayRemote, syncStoreReplay} from '../Observe/store-replay'
import {listen as createListenPair} from '../events/Listen'
import {ReplayRemote, replaySubscribe} from '../events/replay-wire'
import {
    AiCapability,
    AiRun,
    AiRunApproval,
    AiRunEvent,
    AiRunInput,
    AiRunRequest,
    AiRunStore,
} from './ai-run-host'

export type AiRunRemote = {
    capabilities: () => Promise<AiCapability[]> | AiCapability[]
    state: StoreReplayRemote
    events: ReplayRemote<[AiRunEvent]>
    createRun: (request: AiRunRequest) => Promise<AiRun> | AiRun
    cancelRun: (runId: string, reason?: string) => Promise<AiRun> | AiRun
    resolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<AiRunApproval> | AiRunApproval
    provideInput: (inputId: string, value: unknown) => Promise<AiRunInput> | AiRunInput
}

export type AiRunClientDeps = {
    /** Deep proxy of `host.connection(account).fragment` on the existing RPC connection. */
    remote: AiRunRemote
    initial?: AiRunStore
    drain?: StoreDrain
    /** Prefer compact Store coordinates; false preserves legacy stateSeq values. */
    batch?: boolean
}

export function createAiRunClient(deps: AiRunClientDeps) {
    const {remote, initial = {runs: {}, approvals: {}, inputs: {}}, drain, batch = true} = deps
    const store = createStore<AiRunStore>(initial, drain !== undefined ? {drain} : {})
    const [emitEvent, events] = createListenPair<[AiRunEvent]>()
    const stateSync = syncStoreReplay(store, remote.state, {batch})
    const eventSync = replaySubscribe(remote.events, function forwardEvent(event) { emitEvent(event) })

    async function capabilities() {
        return remote.capabilities()
    }

    async function createRun(request: AiRunRequest) {
        return remote.createRun(request)
    }

    async function cancelRun(runId: string, reason?: string) {
        return remote.cancelRun(runId, reason)
    }

    async function resolveApproval(approvalId: string, decision: 'approved' | 'rejected') {
        return remote.resolveApproval(approvalId, decision)
    }

    async function provideInput(inputId: string, value: unknown) {
        return remote.provideInput(inputId, value)
    }

    return {
        /** Account-filtered durable runs, approvals and input request metadata. */
        store,
        /** Attach before `ready` when the initial `sync` event matters to the UI. */
        events,
        /** State and event replay have both completed their initial catch-up. */
        ready: Promise.all([stateSync.ready, eventSync.ready]).then(function readyAfterReplay() {}),
        stateSeq: stateSync.seq,
        stateMode: () => stateSync.mode,
        eventSeq: eventSync.seq,
        capabilities,
        createRun,
        cancelRun,
        resolveApproval,
        provideInput,
        close() {
            stateSync()
            eventSync()
            events.close()
        },
    }
}

export type AiRunClient = ReturnType<typeof createAiRunClient>
