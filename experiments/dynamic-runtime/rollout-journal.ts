import {clone} from '../../src/Common/core/common'
import {listen as createListenPair} from '../../src/Common/events/Listen'
import {openHistory, ReplayStorage} from '../../src/Common/events/replay-history'
import {tModuleArtifactRef} from './artifact-registry'

export type RolloutCoordinate = {
    authorityId: string
    authorityEpoch: number
    generation: number
}

export type ModuleRolloutCommand = RolloutCoordinate & {
    commandId: string
    rolloutId: string
    slotId: string
    artifactRef: tModuleArtifactRef
}

export type RolloutNodeBinding = {
    nodeId: string
    artifactRef: tModuleArtifactRef
    moduleId: string
    version: string
    bindingGeneration: number
}

export type tRolloutReceiptState = 'accepted' | 'completed' | 'failed'

export type RolloutReceipt = {
    commandId: string
    fingerprint: string
    state: tRolloutReceiptState
    command: ModuleRolloutCommand
    acceptedAt: number
    completedAt?: number
    result?: {
        active: Record<string, RolloutNodeBinding>
        rolledBack: boolean
    }
    error?: string
}

export type RolloutAuditFact = {
    sequence: number
    at: number
    commandId: string
    action: string
    nodeId?: string
    artifactRef?: tModuleArtifactRef
    error?: string
}

export type ModuleRolloutJournalState = {
    protocol: 1
    authority: {authorityId: string, authorityEpoch: number} | null
    generation: number
    desired: ModuleRolloutCommand | null
    active: Record<string, RolloutNodeBinding>
    lastKnownGood: Record<string, RolloutNodeBinding>
    quarantined: Record<string, {artifactRef: tModuleArtifactRef, reason: string, at: number}>
    receipts: Record<string, RolloutReceipt>
    audit: RolloutAuditFact[]
    nextAuditSequence: number
}

export type tModuleRolloutJournalEvent =
    | {type: 'accepted', receipt: RolloutReceipt}
    | {type: 'fact', fact: RolloutAuditFact}
    | {type: 'completed', receipt: RolloutReceipt}
    | {type: 'failed', receipt: RolloutReceipt}

export type ModuleRolloutJournalDeps = {
    storage: ReplayStorage<[ModuleRolloutJournalState]>
    now?: () => number
    auditLimit?: number
}

function initialState(): ModuleRolloutJournalState {
    return {
        protocol: 1,
        authority: null,
        generation: 0,
        desired: null,
        active: {},
        lastKnownGood: {},
        quarantined: {},
        receipts: {},
        audit: [],
        nextAuditSequence: 0,
    }
}

function stableJson(value: unknown): string {
    if (value == null || typeof value == 'boolean' || typeof value == 'number' || typeof value == 'string') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
    const object = value as Record<string, unknown>
    return '{' + Object.keys(object).sort().map(function encodeField(key) {
        return JSON.stringify(key) + ':' + stableJson(object[key])
    }).join(',') + '}'
}

function commandFingerprint(command: ModuleRolloutCommand) {
    return stableJson(command)
}

function validateCoordinate(command: ModuleRolloutCommand) {
    if (typeof command.commandId != 'string' || !command.commandId.trim()) {
        throw new Error('module rollout journal: commandId is required')
    }
    if (typeof command.rolloutId != 'string' || !command.rolloutId.trim()) {
        throw new Error('module rollout journal: rolloutId is required')
    }
    if (typeof command.slotId != 'string' || !command.slotId.trim()) {
        throw new Error('module rollout journal: slotId is required')
    }
    if (typeof command.authorityId != 'string' || !command.authorityId.trim()) {
        throw new Error('module rollout journal: authorityId is required')
    }
    if (typeof command.artifactRef != 'string' || !/^sha256:[a-f0-9]{64}$/.test(command.artifactRef)) {
        throw new Error('module rollout journal: artifactRef must be a sha256 coordinate')
    }
    if (!Number.isSafeInteger(command.authorityEpoch) || command.authorityEpoch < 1) {
        throw new Error('module rollout journal: authorityEpoch must be a positive safe integer')
    }
    if (!Number.isSafeInteger(command.generation) || command.generation < 1) {
        throw new Error('module rollout journal: generation must be a positive safe integer')
    }
}

function copyReceipt(receipt: RolloutReceipt) {
    return clone(receipt)
}

function dataRecord(value: unknown, label: string) {
    if (typeof value != 'object' || value == null || Array.isArray(value)) {
        throw new Error('module rollout journal: restored ' + label + ' must be an object')
    }
    return value as Record<string, unknown>
}

function validateRestoredState(value: unknown): ModuleRolloutJournalState {
    const restored = dataRecord(value, 'state')
    if (restored['protocol'] != 1) throw new Error('module rollout journal: restored protocol is unsupported')
    if (!Number.isSafeInteger(restored['generation']) || (restored['generation'] as number) < 0) {
        throw new Error('module rollout journal: restored generation is invalid')
    }
    if (!Number.isSafeInteger(restored['nextAuditSequence'])
        || (restored['nextAuditSequence'] as number) < 0) {
        throw new Error('module rollout journal: restored audit sequence is invalid')
    }
    if (!Array.isArray(restored['audit'])) {
        throw new Error('module rollout journal: restored audit must be an array')
    }
    dataRecord(restored['active'], 'active bindings')
    dataRecord(restored['lastKnownGood'], 'last-known-good bindings')
    dataRecord(restored['quarantined'], 'quarantine')
    const receipts = dataRecord(restored['receipts'], 'receipts')
    for (const [commandId, value] of Object.entries(receipts)) {
        const receipt = dataRecord(value, 'receipt')
        if (receipt['commandId'] != commandId || typeof receipt['fingerprint'] != 'string') {
            throw new Error('module rollout journal: restored receipt identity is invalid')
        }
        if (receipt['state'] != 'accepted' && receipt['state'] != 'completed' && receipt['state'] != 'failed') {
            throw new Error('module rollout journal: restored receipt state is invalid')
        }
        validateCoordinate(receipt['command'] as ModuleRolloutCommand)
    }
    const desired = restored['desired']
    if (desired != null) validateCoordinate(desired as ModuleRolloutCommand)
    const authority = restored['authority']
    if (authority != null) {
        const coordinate = dataRecord(authority, 'authority')
        if (typeof coordinate['authorityId'] != 'string'
            || !Number.isSafeInteger(coordinate['authorityEpoch'])
            || (coordinate['authorityEpoch'] as number) < 1) {
            throw new Error('module rollout journal: restored authority is invalid')
        }
    }
    return clone(restored as unknown as ModuleRolloutJournalState)
}

export function createModuleRolloutJournal(deps: ModuleRolloutJournalDeps) {
    const now = deps.now ?? Date.now
    const auditLimit = Math.max(1, deps.auditLimit ?? 2_000)
    const restored = openHistory(deps.storage).at({})
    if (!restored && deps.storage.getEvents(0, Infinity).length) {
        throw new Error('module rollout journal: archive has events without a baseline keyframe')
    }
    let sequence = restored?.[restored.length - 1]?.seq ?? 0
    let state = restored
        ? validateRestoredState(restored[restored.length - 1]!.event[0])
        : initialState()
    if (!restored) {
        deps.storage.putKeyframe({
            seq: 0,
            ts: now(),
            event: [clone(state)],
        })
    }
    const [emitEvent, events] = createListenPair<[tModuleRolloutJournalEvent]>()
    let keyframeDue = false
    let lastKeyframeError: string | null = null

    function commit(next: ModuleRolloutJournalState) {
        const nextSequence = sequence + 1
        const event = {
            seq: nextSequence,
            ts: now(),
            event: [clone(next)] as [ModuleRolloutJournalState],
        }
        deps.storage.putEvent(event)
        sequence = nextSequence
        state = next
        if (sequence % 32 == 0) keyframeDue = true
        if (!keyframeDue) return
        try {
            deps.storage.putKeyframe(event)
            keyframeDue = false
            lastKeyframeError = null
        } catch (error) {
            lastKeyframeError = typeof (error as any)?.message == 'string'
                ? (error as any).message
                : String(error)
        }
    }

    function appendFact(
        state: ModuleRolloutJournalState,
        input: Omit<RolloutAuditFact, 'sequence' | 'at'>,
    ) {
        const fact: RolloutAuditFact = {
            sequence: ++state.nextAuditSequence,
            at: now(),
            ...input,
        }
        state.audit.push(fact)
        if (state.audit.length > auditLimit) state.audit.splice(0, state.audit.length - auditLimit)
        return fact
    }

    function requireReceipt(state: ModuleRolloutJournalState, commandId: string) {
        const receipt = state.receipts[commandId]
        if (!receipt) throw new Error('module rollout journal: command is unknown: ' + commandId)
        return receipt
    }

    function accept(command: ModuleRolloutCommand) {
        validateCoordinate(command)
        const fingerprint = commandFingerprint(command)
        const current = clone(state) as ModuleRolloutJournalState
        const existing = current.receipts[command.commandId]
        if (existing) {
            if (existing.fingerprint != fingerprint) {
                throw new Error('module rollout journal: commandId was reused for a different intent')
            }
            return {replay: true, receipt: copyReceipt(existing)}
        }
        const pending = Object.values(current.receipts).find(receipt => receipt.state == 'accepted')
        if (pending) {
            throw new Error('module rollout journal: rollout is already in progress: ' + pending.commandId)
        }
        const authority = current.authority
        if (authority && command.authorityEpoch < authority.authorityEpoch) {
            throw new Error('module rollout journal: stale authority epoch')
        }
        if (authority
            && command.authorityEpoch == authority.authorityEpoch
            && command.authorityId != authority.authorityId) {
            throw new Error('module rollout journal: authority conflicts at the current epoch')
        }
        if (command.generation <= current.generation) {
            throw new Error('module rollout journal: stale rollout generation')
        }
        const next = clone(current)
        next.authority = {
            authorityId: command.authorityId,
            authorityEpoch: command.authorityEpoch,
        }
        next.generation = command.generation
        next.desired = clone(command)
        const receipt: RolloutReceipt = {
            commandId: command.commandId,
            fingerprint,
            state: 'accepted',
            command: clone(command),
            acceptedAt: now(),
        }
        next.receipts[command.commandId] = receipt
        const audit = appendFact(next, {
            commandId: command.commandId,
            action: 'rollout accepted',
            artifactRef: command.artifactRef,
        })
        commit(next)
        emitEvent({type: 'fact', fact: clone(audit)})
        const copy = copyReceipt(receipt)
        emitEvent({type: 'accepted', receipt: copy})
        return {replay: false, receipt: copy}
    }

    function fact(commandId: string, input: Omit<RolloutAuditFact, 'sequence' | 'at' | 'commandId'>) {
        const next = clone(state)
        requireReceipt(next, commandId)
        const audit = appendFact(next, {commandId, ...input})
        commit(next)
        emitEvent({type: 'fact', fact: clone(audit)})
        return clone(audit)
    }

    function complete(commandId: string, active: Record<string, RolloutNodeBinding>) {
        const next = clone(state)
        const receipt = requireReceipt(next, commandId)
        if (receipt.state != 'accepted') return copyReceipt(receipt)
        next.active = clone(active)
        next.lastKnownGood = clone(active)
        receipt.state = 'completed'
        receipt.completedAt = now()
        receipt.result = {active: clone(active), rolledBack: false}
        const audit = appendFact(next, {
            commandId,
            action: 'rollout completed',
            artifactRef: receipt.command.artifactRef,
        })
        commit(next)
        emitEvent({type: 'fact', fact: clone(audit)})
        const copy = copyReceipt(receipt)
        emitEvent({type: 'completed', receipt: copy})
        return copy
    }

    function fail(
        commandId: string,
        error: unknown,
        active: Record<string, RolloutNodeBinding>,
        opts: {quarantine?: boolean, rolledBack?: boolean} = {},
    ) {
        const next = clone(state)
        const receipt = requireReceipt(next, commandId)
        if (receipt.state != 'accepted') return copyReceipt(receipt)
        const message = typeof (error as any)?.message == 'string' ? (error as any).message : String(error)
        next.active = clone(active)
        receipt.state = 'failed'
        receipt.completedAt = now()
        receipt.error = message
        receipt.result = {active: clone(active), rolledBack: opts.rolledBack ?? true}
        if (opts.quarantine ?? true) {
            next.quarantined[receipt.command.artifactRef] = {
                artifactRef: receipt.command.artifactRef,
                reason: message,
                at: now(),
            }
        }
        const audit = appendFact(next, {
            commandId,
            action: receipt.result.rolledBack ? 'rollout failed and rolled back' : 'rollout failed',
            artifactRef: receipt.command.artifactRef,
            error: message,
        })
        commit(next)
        emitEvent({type: 'fact', fact: clone(audit)})
        const copy = copyReceipt(receipt)
        emitEvent({type: 'failed', receipt: copy})
        return copy
    }

    return {
        control: {
            accept,
            fact,
            complete,
            fail,
        },
        events: {
            on: events.on,
        },
        view: {
            snapshot: () => clone(state),
            receipt(commandId: string) {
                const receipt = state.receipts[commandId]
                return receipt == undefined ? null : copyReceipt(receipt)
            },
            pending() {
                return Object.values(state.receipts)
                    .filter(receipt => receipt.state == 'accepted')
                    .map(copyReceipt)
            },
            restored: () => ({seq: restored?.[restored.length - 1]?.seq ?? 0, fromArchive: !!restored}),
        },
        health: {
            snapshot: () => ({
                persistence: lastKeyframeError == null ? 'healthy' as const : 'degraded' as const,
                keyframeDue,
                lastKeyframeError,
                sequence,
            }),
        },
        close() {
            events.close()
        },
    }
}

export type ModuleRolloutJournal = ReturnType<typeof createModuleRolloutJournal>
