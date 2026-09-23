import type {AiRun, AiRunApproval, AiRunInput, AiRunRequest, AiRunStore} from './ai-run-host'
import {cloneStoreProjectionValue} from '../Observe/store-projection'
import {commandReceiptKey} from '../command/command-receipts'
import {compareDeepValues} from '../core/deep-equal'

/** Server-only checkpoint. Inputs and supplied answers must never be exposed as a client projection. */
export type AiRunCheckpoint = {
    version: 1
    revision: number
    store: AiRunStore
    requests: Record<string, AiRunRequest>
    inputValues: Record<string, unknown>
}

export type AiRunPersistencePort = {
    /** Atomic, synchronous durable acknowledgement. Throw on failure; an async function is not this port. */
    commit(checkpoint: AiRunCheckpoint): undefined
}

export type AiRunRecoveryRecord = {
    run: AiRun
    request: AiRunRequest
    approvals: AiRunApproval[]
    inputs: (AiRunInput & {value?: unknown})[]
}

export function restoreAiRunCheckpoint(initial: AiRunCheckpoint | undefined) {
    const copy: AiRunCheckpoint = initial ? cloneStoreProjectionValue(initial) : {
        version: 1, revision: 0, store: {runs: {}, approvals: {}, inputs: {}}, requests: {}, inputValues: {},
    }
    if (copy.version != 1 || !Number.isSafeInteger(copy.revision) || copy.revision < 0
        || !copy.store?.runs || !copy.store.approvals || !copy.store.inputs || !copy.requests || !copy.inputValues) {
        throw new Error('AI checkpoint: invalid version or shape')
    }
    const keys = new Set<string>()
    for (const [id, run] of Object.entries(copy.store.runs)) {
        const request = copy.requests[id]
        const key = commandReceiptKey(run.owner, run.requestId)
        if (run.id != id || !run.owner || !run.requestId || keys.has(key) || !request || request.requestId != run.requestId
            || request.kind != run.kind || !Array.isArray(run.resourceIds) || !Array.isArray(run.artifacts)
            || !compareDeepValues(request.resourceIds ?? [], run.resourceIds)
            || !['queued', 'running', 'waiting_input', 'waiting_approval', 'completed', 'failed', 'cancelled'].includes(run.state)) {
            throw new Error('AI checkpoint: inconsistent run or receipt')
        }
        keys.add(key)
    }
    for (const id of Object.keys(copy.requests)) if (!copy.store.runs[id]) throw new Error('AI checkpoint: orphan request')
    for (const [id, approval] of Object.entries(copy.store.approvals)) {
        if (id != approval.id || !copy.store.runs[approval.runId]
            || !['pending', 'approved', 'rejected', 'cancelled'].includes(approval.state)) throw new Error('AI checkpoint: invalid approval')
    }
    for (const [id, input] of Object.entries(copy.store.inputs)) {
        if (id != input.id || !copy.store.runs[input.runId]
            || !['waiting', 'provided', 'cancelled'].includes(input.state)
            || (input.state == 'provided' && !Object.hasOwn(copy.inputValues, id))) throw new Error('AI checkpoint: invalid input')
    }
    for (const id of Object.keys(copy.inputValues)) if (copy.store.inputs[id]?.state != 'provided') throw new Error('AI checkpoint: orphan input value')
    return copy
}
