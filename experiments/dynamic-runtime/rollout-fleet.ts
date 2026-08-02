import {ContractBinding, ContractDemand} from '../../src/Common/contract/contract-data'
import {
    DynamicModuleHost,
    DynamicModuleCallOptions,
} from '../../src/server/dynamic/module-host'
import {
    ModuleArtifactProvider,
    tModuleArtifactRef,
} from './artifact-registry'
import {
    ModuleRolloutCommand,
    ModuleRolloutJournal,
    RolloutCoordinate,
    RolloutNodeBinding,
    RolloutReceipt,
} from './rollout-journal'

export type ModuleRuntimeNodeDeps = {
    nodeId: string
    host: DynamicModuleHost
    provider: ModuleArtifactProvider
}

type NodeFence = RolloutCoordinate & {
    commandId: string
    artifactRef: tModuleArtifactRef
}

function bindingSnapshot(nodeId: string, artifactRef: tModuleArtifactRef, binding: ContractBinding): RolloutNodeBinding {
    return {
        nodeId,
        artifactRef,
        moduleId: binding.descriptor.implementationId,
        version: binding.descriptor.implementationVersion,
        bindingGeneration: binding.bindingGeneration,
    }
}

export function createModuleRuntimeNode(deps: ModuleRuntimeNodeDeps) {
    const candidates = new Map<tModuleArtifactRef, string>()
    const artifactRefs = new Map<tModuleArtifactRef, tModuleArtifactRef>()
    let fence: NodeFence | null = null

    function applyFence(command: ModuleRolloutCommand) {
        if (fence && command.authorityEpoch < fence.authorityEpoch) {
            throw new Error(deps.nodeId + ': stale authority epoch')
        }
        if (fence
            && command.authorityEpoch == fence.authorityEpoch
            && command.authorityId != fence.authorityId) {
            throw new Error(deps.nodeId + ': authority conflicts at the current epoch')
        }
        if (fence && command.generation < fence.generation) {
            throw new Error(deps.nodeId + ': stale rollout generation')
        }
        if (fence && command.generation == fence.generation) {
            if (command.commandId != fence.commandId || command.artifactRef != fence.artifactRef) {
                throw new Error(deps.nodeId + ': rollout conflicts at the current generation')
            }
            return
        }
        fence = {
            authorityId: command.authorityId,
            authorityEpoch: command.authorityEpoch,
            generation: command.generation,
            commandId: command.commandId,
            artifactRef: command.artifactRef,
        }
    }

    async function prepare(command: ModuleRolloutCommand) {
        applyFence(command)
        const existing = candidates.get(command.artifactRef)
        if (existing) {
            const candidate = deps.host.view.candidate(existing)
            if (!candidate) throw new Error(deps.nodeId + ': prepared candidate disappeared')
            if (candidate.state != 'ready' && candidate.state != 'active') {
                throw new Error(deps.nodeId + ': prepared candidate is not reusable: ' + candidate.state)
            }
            return candidate
        }
        const artifact = await deps.provider.resource.fetch(command.artifactRef)
        applyFence(command)
        artifactRefs.set(artifact.descriptor.contentHash, command.artifactRef)
        const candidateId = [
            deps.nodeId,
            command.slotId,
            command.generation,
            command.artifactRef.slice('sha256:'.length, 'sha256:'.length + 12),
        ].join('-')
        const candidate = await deps.host.control.stage({
            candidateId,
            slotId: command.slotId,
            priority: command.generation,
            manifest: artifact.manifest,
            bytes: artifact.bytes,
        })
        candidates.set(command.artifactRef, candidateId)
        return candidate
    }

    async function activate(command: ModuleRolloutCommand) {
        applyFence(command)
        const current = active(command.slotId)
        if (current?.artifactRef == command.artifactRef) return current
        const candidateId = candidates.get(command.artifactRef)
        if (!candidateId) throw new Error(deps.nodeId + ': artifact was not prepared')
        const binding = await deps.host.control.activate(candidateId)
        return bindingSnapshot(deps.nodeId, command.artifactRef, binding)
    }

    async function rollback(command: ModuleRolloutCommand) {
        applyFence(command)
        const current = active(command.slotId)
        if (current && current.artifactRef != command.artifactRef) return current
        const binding = await deps.host.control.rollback(command.slotId)
        const contentHash = binding.descriptor.integrity as tModuleArtifactRef
        const artifactRef = artifactRefs.get(contentHash) ?? contentHash
        return bindingSnapshot(deps.nodeId, artifactRef, binding)
    }

    function active(slotId: string) {
        const binding = deps.host.view.binding(slotId)
        if (!binding) return null
        const contentHash = binding.descriptor.integrity as tModuleArtifactRef
        return bindingSnapshot(
            deps.nodeId,
            artifactRefs.get(contentHash) ?? contentHash,
            binding,
        )
    }

    return {
        nodeId: deps.nodeId,
        control: {
            require(demand: ContractDemand) {
                return deps.host.control.require(demand)
            },
            prepare,
            activate,
            rollback,
        },
        resource: {
            handle(slotId: string) {
                return deps.host.resource.handle(slotId)
            },
        },
        view: {
            active,
            fence: () => fence == null ? null : {...fence},
            candidate(artifactRef: tModuleArtifactRef) {
                const candidateId = candidates.get(artifactRef)
                return candidateId == undefined ? null : deps.host.view.candidate(candidateId)
            },
        },
        health: {
            snapshot: deps.host.health.snapshot,
        },
        close: deps.host.close,
    }
}

export type ModuleRuntimeNode = ReturnType<typeof createModuleRuntimeNode>

export type ModuleRolloutProbeInput = {
    node: ModuleRuntimeNode
    command: ModuleRolloutCommand
    binding: RolloutNodeBinding
    sample: number
}

export type ModuleRolloutProbeResult = {
    ok: boolean
    error?: string
}

export type ModuleFleetRolloutPolicy = {
    canaryCount?: number
    batchSize?: number
    probeSamples?: number
    maxFailedProbes?: number
    probe: (input: ModuleRolloutProbeInput) =>
        ModuleRolloutProbeResult | Promise<ModuleRolloutProbeResult>
}

export type ModuleFleetRolloutDeps = {
    nodes: readonly ModuleRuntimeNode[]
    journal: ModuleRolloutJournal
    policy: ModuleFleetRolloutPolicy
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

function chunks<T>(values: readonly T[], size: number) {
    const output: T[][] = []
    for (let index = 0; index < values.length; index += size) {
        output.push(values.slice(index, index + size))
    }
    return output
}

export function createModuleFleetRollout(deps: ModuleFleetRolloutDeps) {
    if (!deps.nodes.length) throw new Error('module fleet rollout: at least one node is required')
    const nodeIds = new Set(deps.nodes.map(node => node.nodeId))
    if (nodeIds.size != deps.nodes.length) throw new Error('module fleet rollout: nodeId values must be unique')
    const canaryCount = Math.max(1, Math.min(deps.nodes.length, deps.policy.canaryCount ?? 1))
    const batchSize = Math.max(1, deps.policy.batchSize ?? 1)
    const probeSamples = Math.max(1, deps.policy.probeSamples ?? 1)
    const maxFailedProbes = Math.max(0, deps.policy.maxFailedProbes ?? 0)
    const inflight = new Map<string, Promise<RolloutReceipt>>()

    function currentBindings(slotId: string) {
        const bindings: Record<string, RolloutNodeBinding> = {}
        for (const node of deps.nodes) {
            const active = node.view.active(slotId)
            if (active) bindings[node.nodeId] = active
        }
        return bindings
    }

    async function prepareAll(command: ModuleRolloutCommand) {
        const results = await Promise.allSettled(deps.nodes.map(async function prepareNode(node) {
            const candidate = await node.control.prepare(command)
            deps.journal.control.fact(command.commandId, {
                action: 'node prepared',
                nodeId: node.nodeId,
                artifactRef: command.artifactRef,
            })
            return candidate
        }))
        const failure = results.find(result => result.status == 'rejected')
        if (failure?.status == 'rejected') throw failure.reason
    }

    async function activateBatch(
        command: ModuleRolloutCommand,
        batch: readonly ModuleRuntimeNode[],
        activated: Set<string>,
    ) {
        const results = await Promise.allSettled(batch.map(async function activateNode(node) {
            const binding = await node.control.activate(command)
            activated.add(node.nodeId)
            deps.journal.control.fact(command.commandId, {
                action: 'node activated',
                nodeId: node.nodeId,
                artifactRef: command.artifactRef,
            })
            return binding
        }))
        const failure = results.find(result => result.status == 'rejected')
        if (failure?.status == 'rejected') throw failure.reason
        return results.flatMap(result => result.status == 'fulfilled' ? [result.value] : [])
    }

    async function probeBatch(
        command: ModuleRolloutCommand,
        batch: readonly ModuleRuntimeNode[],
    ) {
        let failures = 0
        const errors: string[] = []
        for (const node of batch) {
            const binding = node.view.active(command.slotId)
            if (!binding) {
                failures++
                errors.push(node.nodeId + ': no active binding')
                continue
            }
            for (let sample = 0; sample < probeSamples; sample++) {
                try {
                    const result = await deps.policy.probe({node, command, binding, sample})
                    if (!result.ok) {
                        failures++
                        errors.push(node.nodeId + ': ' + (result.error ?? 'probe rejected'))
                    }
                } catch (error) {
                    failures++
                    errors.push(node.nodeId + ': ' + errorText(error))
                }
            }
        }
        deps.journal.control.fact(command.commandId, {
            action: failures > maxFailedProbes ? 'batch probe rejected' : 'batch probe passed',
            artifactRef: command.artifactRef,
            ...(errors.length ? {error: errors.join('; ')} : {}),
        })
        if (failures > maxFailedProbes) {
            throw new Error('module fleet rollout: probe threshold exceeded: ' + errors.join('; '))
        }
    }

    async function rollbackActivated(command: ModuleRolloutCommand, activated: Set<string>) {
        const targets = [...deps.nodes].reverse().filter(node => activated.has(node.nodeId))
        const failures: string[] = []
        for (const node of targets) {
            try {
                await node.control.rollback(command)
                deps.journal.control.fact(command.commandId, {
                    action: 'node rolled back',
                    nodeId: node.nodeId,
                    artifactRef: command.artifactRef,
                })
            } catch (error) {
                failures.push(node.nodeId + ': ' + errorText(error))
            }
        }
        if (failures.length) throw new Error('module fleet rollout: rollback incomplete: ' + failures.join('; '))
    }

    async function execute(command: ModuleRolloutCommand) {
        const activated = new Set<string>()
        try {
            await prepareAll(command)
            const canaries = deps.nodes.slice(0, canaryCount)
            const remainder = deps.nodes.slice(canaryCount)
            await activateBatch(command, canaries, activated)
            await probeBatch(command, canaries)
            for (const batch of chunks(remainder, batchSize)) {
                await activateBatch(command, batch, activated)
                await probeBatch(command, batch)
            }
            return deps.journal.control.complete(command.commandId, currentBindings(command.slotId))
        } catch (error) {
            let finalError = error
            let rolledBack = false
            if (activated.size) {
                try {
                    await rollbackActivated(command, activated)
                    rolledBack = true
                } catch (rollbackError) {
                    finalError = new Error(errorText(error) + '; ' + errorText(rollbackError))
                }
            }
            return deps.journal.control.fail(
                command.commandId,
                finalError,
                currentBindings(command.slotId),
                {rolledBack},
            )
        }
    }

    function rollout(command: ModuleRolloutCommand) {
        const snapshot = deps.journal.view.snapshot()
        if (!snapshot.receipts[command.commandId] && snapshot.quarantined[command.artifactRef]) {
            throw new Error('module fleet rollout: artifact is quarantined: ' + command.artifactRef)
        }
        const accepted = deps.journal.control.accept(command)
        if (accepted.receipt.state != 'accepted') return Promise.resolve(accepted.receipt)
        const current = inflight.get(command.commandId)
        if (current) return current
        const task = execute(command).finally(function clearRollout() {
            if (inflight.get(command.commandId) == task) inflight.delete(command.commandId)
        })
        inflight.set(command.commandId, task)
        return task
    }

    async function reconcile() {
        const results: RolloutReceipt[] = []
        for (const receipt of deps.journal.view.pending()) {
            const current = inflight.get(receipt.commandId)
            const task = current ?? execute(receipt.command)
            if (!current) inflight.set(receipt.commandId, task)
            try {
                results.push(await task)
            } finally {
                if (inflight.get(receipt.commandId) == task) inflight.delete(receipt.commandId)
            }
        }
        return results
    }

    return {
        control: {
            rollout,
            reconcile,
        },
        events: {
            on: deps.journal.events.on,
        },
        view: {
            snapshot: deps.journal.view.snapshot,
            active: (slotId: string) => currentBindings(slotId),
        },
        health: {
            snapshot() {
                return {
                    journal: deps.journal.health.snapshot(),
                    nodes: Object.fromEntries(deps.nodes.map(node => [node.nodeId, node.health.snapshot()])),
                }
            },
            nodes() {
                return Object.fromEntries(deps.nodes.map(node => [node.nodeId, node.health.snapshot()]))
            },
        },
    }
}

export type ModuleFleetRollout = ReturnType<typeof createModuleFleetRollout>

export function callModuleNode<T>(
    node: ModuleRuntimeNode,
    slotId: string,
    method: string,
    input: unknown,
    opts: DynamicModuleCallOptions = {},
) {
    return node.resource.handle(slotId).call<T>(method, input, opts)
}
