export type ModuleStageRequest = {
    slotId: string
    moduleId: string
    version: string
    artifactRef: string
    commandId: string
    correlationId: string
}

export type ModuleActivateRequest = {
    slotId: string
    moduleId: string
    candidateId: string
    commandId: string
    correlationId: string
}

export type ModuleRollbackRequest = {
    slotId: string
    moduleId: string
    targetVersion?: string
    commandId: string
    correlationId: string
}

export type ModuleControlPort = {
    control: {
        stage: (request: ModuleStageRequest) => unknown | Promise<unknown>
        activate: (request: ModuleActivateRequest) => unknown | Promise<unknown>
        rollback: (request: ModuleRollbackRequest) => unknown | Promise<unknown>
    }
    view: {
        explain: (slotId: string, moduleId: string) => unknown | Promise<unknown>
    }
    health: {
        snapshot: (slotId?: string, moduleId?: string) => unknown | Promise<unknown>
    }
    resource: {
        guide: () => string | Promise<string>
        implementationPrompt: () => string | Promise<string>
    }
}

type Candidate = {
    candidateId: string
    slotId: string
    moduleId: string
    version: string
    artifactRef: string
    state: 'verified' | 'active' | 'retired'
}

type Active = {
    candidateId: string
    slotId: string
    moduleId: string
    version: string
    generation: number
}

type AuditFact = {
    kind: 'staged' | 'activated' | 'rolled-back'
    moduleId: string
    slotId: string
    version: string
    candidateId: string
    commandId: string
    correlationId: string
    generation: number
}

export type InMemoryModuleControlDeps = {
    guide: string
    implementationPrompt: string
    initial: {
        slotId: string
        moduleId: string
        version: string
        artifactRef: string
    }
}

// ===================================================================
// deterministic domain facade used only by the transport experiment
// ===================================================================

export function createInMemoryModuleControl(deps: InMemoryModuleControlDeps) {
    const candidates = new Map<string, Candidate>()
    const receipts = new Map<string, {fingerprint: string, promise: Promise<unknown>}>()
    const audit: AuditFact[] = []

    const initialCandidate: Candidate = {
        candidateId: `${deps.initial.slotId}:${deps.initial.moduleId}@${deps.initial.version}:${deps.initial.artifactRef}`,
        slotId: deps.initial.slotId,
        moduleId: deps.initial.moduleId,
        version: deps.initial.version,
        artifactRef: deps.initial.artifactRef,
        state: 'active',
    }
    candidates.set(initialCandidate.candidateId, initialCandidate)

    let active: Active = {
        candidateId: initialCandidate.candidateId,
        slotId: initialCandidate.slotId,
        moduleId: initialCandidate.moduleId,
        version: initialCandidate.version,
        generation: 1,
    }

    async function runCommand<T>(
        commandId: string,
        fingerprint: string,
        execute: () => T | Promise<T>,
    ): Promise<T> {
        const existing = receipts.get(commandId)
        if (existing) {
            if (existing.fingerprint != fingerprint) throw new Error('commandId was reused with different intent')
            return await existing.promise as T
        }
        const promise = Promise.resolve().then(execute)
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
        return await runCommand(request.commandId, fingerprint, function stageOnce() {
            const candidateId = `${request.slotId}:${request.moduleId}@${request.version}:${request.artifactRef}`
            const existing = candidates.get(candidateId)
            if (existing) {
                return {
                    ok: true,
                    candidate: {...existing},
                    reused: true,
                }
            }

            const candidate: Candidate = {
                candidateId,
                slotId: request.slotId,
                moduleId: request.moduleId,
                version: request.version,
                artifactRef: request.artifactRef,
                state: 'verified',
            }
            candidates.set(candidateId, candidate)
            audit.push({
                kind: 'staged',
                moduleId: candidate.moduleId,
                slotId: candidate.slotId,
                version: candidate.version,
                candidateId,
                commandId: request.commandId,
                correlationId: request.correlationId,
                generation: active.generation,
            })
            return {
                ok: true,
                candidate: {...candidate},
                reused: false,
            }
        })
    }

    async function activate(request: ModuleActivateRequest) {
        const fingerprint = JSON.stringify(['activate', request.slotId, request.moduleId, request.candidateId])
        return await runCommand(request.commandId, fingerprint, function activateOnce() {
            const candidate = candidates.get(request.candidateId)
            if (!candidate || candidate.moduleId != request.moduleId || candidate.slotId != request.slotId) {
                throw new Error(`Unknown candidate: ${request.candidateId}`)
            }

            const previous = {...active}
            const previousCandidate = candidates.get(previous.candidateId)
            if (previousCandidate) previousCandidate.state = 'retired'
            candidate.state = 'active'
            active = {
                candidateId: candidate.candidateId,
                slotId: candidate.slotId,
                moduleId: candidate.moduleId,
                version: candidate.version,
                generation: previous.generation + 1,
            }
            audit.push({
                kind: 'activated',
                moduleId: candidate.moduleId,
                slotId: candidate.slotId,
                version: candidate.version,
                candidateId: candidate.candidateId,
                commandId: request.commandId,
                correlationId: request.correlationId,
                generation: active.generation,
            })
            return {
                ok: true,
                previous,
                active: {...active},
            }
        })
    }

    async function rollback(request: ModuleRollbackRequest) {
        const fingerprint = JSON.stringify([
            'rollback',
            request.slotId,
            request.moduleId,
            request.targetVersion ?? null,
        ])
        return await runCommand(request.commandId, fingerprint, function rollbackOnce() {
            const targets = [...candidates.values()]
                .filter(function sameModule(candidate) {
                    return candidate.moduleId == request.moduleId
                        && candidate.slotId == request.slotId
                        && (request.targetVersion == null || candidate.version == request.targetVersion)
                        && candidate.candidateId != active.candidateId
                })
            const target = targets.at(-1)
            if (!target) throw new Error(`No rollback target for module: ${request.moduleId}`)

            const previous = {...active}
            const previousCandidate = candidates.get(previous.candidateId)
            if (previousCandidate) previousCandidate.state = 'retired'
            target.state = 'active'
            active = {
                candidateId: target.candidateId,
                slotId: target.slotId,
                moduleId: target.moduleId,
                version: target.version,
                generation: previous.generation + 1,
            }
            audit.push({
                kind: 'rolled-back',
                moduleId: target.moduleId,
                slotId: target.slotId,
                version: target.version,
                candidateId: target.candidateId,
                commandId: request.commandId,
                correlationId: request.correlationId,
                generation: active.generation,
            })
            return {
                ok: true,
                previous,
                active: {...active},
            }
        })
    }

    function explain(slotId: string, moduleId: string) {
        const moduleCandidates = [...candidates.values()]
            .filter(candidate => candidate.moduleId == moduleId && candidate.slotId == slotId)
            .map(candidate => ({...candidate}))
        return {
            slotId,
            moduleId,
            active: active.moduleId == moduleId && active.slotId == slotId ? {...active} : null,
            candidates: moduleCandidates,
            audit: audit.filter(fact => fact.moduleId == moduleId).map(fact => ({...fact})),
        }
    }

    function healthSnapshot(slotId?: string, moduleId?: string) {
        const selected = (slotId == null || active.slotId == slotId)
            && (moduleId == null || active.moduleId == moduleId)
            ? {...active}
            : null
        return {
            ok: selected != null,
            active: selected,
            checkedAt: 0,
        }
    }

    return {
        control: {
            stage,
            activate,
            rollback,
        },
        view: {
            explain,
        },
        health: {
            snapshot: healthSnapshot,
        },
        resource: {
            guide: () => deps.guide,
            implementationPrompt: () => deps.implementationPrompt,
        },
    } satisfies ModuleControlPort
}

export type InMemoryModuleControl = ReturnType<typeof createInMemoryModuleControl>
