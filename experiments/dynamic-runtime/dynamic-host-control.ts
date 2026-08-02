import {DynamicModuleHost} from '../../src/server/dynamic/module-host'
import {tSerializedModuleManifest} from '../../src/Common/dynamic/module-manifest'
import {tModuleArtifactBytes} from '../../src/Common/dynamic/module-verifier'
import {
    ModuleControlPort,
    ModuleActivateRequest,
    ModuleRollbackRequest,
    ModuleStageRequest,
} from './module-control'

export type DynamicHostArtifact = {
    moduleId: string
    version: string
    contentHash: `sha256:${string}`
    slotId: string
    priority: number
    manifest: tSerializedModuleManifest
    bytes: tModuleArtifactBytes
}

export type DynamicHostModuleControlDeps = {
    host: DynamicModuleHost
    artifacts: ReadonlyMap<string, DynamicHostArtifact>
    guide: string
    implementationPrompt: string
}

function requireArtifact(
    artifacts: ReadonlyMap<string, DynamicHostArtifact>,
    request: ModuleStageRequest,
) {
    const artifact = artifacts.get(request.artifactRef)
    if (!artifact || artifact.moduleId != request.moduleId || artifact.version != request.version) {
        throw new Error('Unknown or mismatched immutable artifact reference: ' + request.artifactRef)
    }
    return artifact
}

export function createDynamicHostModuleControl(deps: DynamicHostModuleControlDeps) {
    const receipts = new Map<string, {fingerprint: string, promise: Promise<unknown>}>()
    const stages = new Map<string, Promise<unknown>>()

    async function once<T>(commandId: string, fingerprint: string, run: () => T | Promise<T>): Promise<T> {
        const existing = receipts.get(commandId)
        if (existing) {
            if (existing.fingerprint != fingerprint) throw new Error('commandId was reused with different intent')
            return await existing.promise as T
        }
        const promise = Promise.resolve().then(run)
        receipts.set(commandId, {fingerprint, promise: promise as Promise<unknown>})
        return await promise
    }

    async function stage(request: ModuleStageRequest) {
        const fingerprint = JSON.stringify([
            'stage',
            request.slotId,
            request.moduleId,
            request.version,
            request.artifactRef,
        ])
        return await once(request.commandId, fingerprint, async function stageOnce() {
            const artifact = requireArtifact(deps.artifacts, request)
            if (artifact.slotId != request.slotId) throw new Error('Artifact does not belong to requested slot')
            const candidateId = [
                artifact.slotId,
                artifact.moduleId + '@' + artifact.version,
                artifact.contentHash,
            ].join(':')
            const existing = deps.host.view.candidate(candidateId)
            if (existing) {
                if (existing.slotId != artifact.slotId
                    || existing.moduleId != artifact.moduleId
                    || existing.version != artifact.version
                    || existing.contentHash != artifact.contentHash) {
                    throw new Error('Candidate coordinate conflicts with another immutable artifact')
                }
                if (existing.state == 'ready' || existing.state == 'active' || existing.state == 'retired') {
                    return {ok: true, candidate: existing, reused: true}
                }
                if (existing.state == 'rejected' || existing.state == 'closed') {
                    throw new Error('Existing candidate is not reusable: ' + existing.state)
                }
            }
            const pending = stages.get(candidateId)
            if (pending) return await pending
            const promise = deps.host.control.stage({
                candidateId,
                slotId: artifact.slotId,
                priority: artifact.priority,
                manifest: artifact.manifest,
                bytes: artifact.bytes,
            }).then(candidate => ({ok: true, candidate, reused: false}))
            stages.set(candidateId, promise)
            try {
                return await promise
            } finally {
                if (stages.get(candidateId) == promise) stages.delete(candidateId)
            }
        })
    }

    async function activate(request: ModuleActivateRequest) {
        const fingerprint = JSON.stringify(['activate', request.slotId, request.moduleId, request.candidateId])
        return await once(request.commandId, fingerprint, async function activateOnce() {
            const candidate = deps.host.view.candidate(request.candidateId)
            if (!candidate || candidate.moduleId != request.moduleId || candidate.slotId != request.slotId) {
                throw new Error('Unknown candidate: ' + request.candidateId)
            }
            const previous = deps.host.view.binding(candidate.slotId)
            const active = await deps.host.control.activate(request.candidateId)
            return {ok: true, previous, active}
        })
    }

    async function rollback(request: ModuleRollbackRequest) {
        const fingerprint = JSON.stringify([
            'rollback',
            request.slotId,
            request.moduleId,
            request.targetVersion ?? null,
        ])
        return await once(request.commandId, fingerprint, async function rollbackOnce() {
            const explanation = deps.host.view.explain(request.slotId)
            if (explanation.binding?.descriptor.implementationId != request.moduleId) {
                throw new Error('Active slot does not belong to requested module')
            }
            const target = explanation.previous
            if (!target) throw new Error('No rollback target for module: ' + request.moduleId)
            if (request.targetVersion != null
                && target.descriptor.implementationVersion != request.targetVersion) {
                throw new Error('Requested rollback target is not the previous verified binding')
            }
            const previous = deps.host.view.binding(request.slotId)
            const active = await deps.host.control.rollback(request.slotId)
            return {ok: true, previous, active}
        })
    }

    return {
        control: {
            stage,
            activate,
            rollback,
        },
        view: {
            explain(slotId: string, moduleId: string) {
                const explanation = deps.host.view.explain(slotId)
                const implementationId = explanation.binding?.descriptor.implementationId
                    ?? explanation.previous?.descriptor.implementationId
                if (implementationId != null && implementationId != moduleId) {
                    throw new Error('Slot does not belong to requested module')
                }
                return explanation
            },
        },
        health: {
            snapshot(slotId?: string, moduleId?: string) {
                const snapshot = deps.host.health.snapshot()
                if (slotId == null && moduleId == null) return snapshot
                return Object.fromEntries(Object.entries(snapshot).filter(([candidateId]) => {
                    const candidate = deps.host.view.candidate(candidateId)
                    return candidate != null
                        && (slotId == null || candidate.slotId == slotId)
                        && (moduleId == null || candidate.moduleId == moduleId)
                }))
            },
        },
        resource: {
            guide: () => deps.guide,
            implementationPrompt: () => deps.implementationPrompt,
        },
    } satisfies ModuleControlPort
}

export type DynamicHostModuleControl = ReturnType<typeof createDynamicHostModuleControl>
