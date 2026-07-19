// =====================================================================
// Contract resolver — deterministic compatibility and offer selection
// =====================================================================

import {
    ContractCandidateStatus,
    ContractDemand,
    ContractDescriptor,
    ContractOffer,
    ContractPolicy,
    ContractPolicyDecision,
    ContractResolution,
} from './contract-data'

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('contract runtime: ' + label + ' is required')
    return value.trim()
}

export function validateContractDescriptor(value: ContractDescriptor) {
    if (!value || value.protocol != 1) throw new Error('contract runtime: unsupported descriptor protocol')
    requiredId(value.contractId, 'descriptor contractId')
    requiredId(value.contractVersion, 'descriptor contractVersion')
    requiredId(value.implementationId, 'descriptor implementationId')
    requiredId(value.implementationVersion, 'descriptor implementationVersion')
    if (value.runtimeVersion != null) requiredId(value.runtimeVersion, 'descriptor runtimeVersion')
    if (value.integrity != null) requiredId(value.integrity, 'descriptor integrity')
    if (value.capabilities != null && (!Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item != 'string' || !item))) {
        throw new Error('contract runtime: descriptor capabilities must be non-empty strings')
    }
    return value
}

export function validateContractDemand(value: ContractDemand) {
    if (!value) throw new Error('contract runtime: demand is required')
    requiredId(value.slotId, 'demand slotId')
    requiredId(value.contractId, 'demand contractId')
    requiredId(value.versionRange, 'demand versionRange')
    requiredId(value.authorityId, 'demand authorityId')
    if (!Number.isInteger(value.generation) || value.generation < 0) throw new Error('contract runtime: demand generation must be a non-negative integer')
    if (!Number.isInteger(value.authorityEpoch) || value.authorityEpoch < 0) throw new Error('contract runtime: demand authorityEpoch must be a non-negative integer')
    if (value.capabilities != null && (!Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item != 'string' || !item))) {
        throw new Error('contract runtime: demand capabilities must be non-empty strings')
    }
    return value
}

export function validateContractOffer(value: ContractOffer) {
    if (!value) throw new Error('contract runtime: offer is required')
    requiredId(value.id, 'offer id')
    if (typeof value.open != 'function') throw new Error('contract runtime: offer open is required')
    validateContractDescriptor(value.descriptor)
    if (value.priority != null && !Number.isFinite(value.priority)) throw new Error('contract runtime: offer priority must be finite')
    return value
}

function capabilityReason(demand: ContractDemand, descriptor: ContractDescriptor) {
    const available = new Set(descriptor.capabilities ?? [])
    const missing = (demand.capabilities ?? []).filter(item => !available.has(item))
    return missing.length ? 'missing capabilities: ' + missing.join(', ') : null
}

function decision(value: ContractPolicyDecision | undefined, fallback: string) {
    if (!value || value.accepted) return null
    return value.reason?.trim() || fallback
}

function defaultCompareOffers(a: ContractOffer, b: ContractOffer) {
    const priority = (a.priority ?? 0) - (b.priority ?? 0)
    if (priority) return priority
    return -a.id.localeCompare(b.id)
}

export type ResolveContractBindingInput = {
    demand: ContractDemand
    offers: readonly ContractOffer[]
    policy?: ContractPolicy
    unavailable?: (offer: ContractOffer) => string | null
}

export async function resolveContractBinding(input: ResolveContractBindingInput) {
    const demand = validateContractDemand(input.demand)
    const policy = input.policy ?? {}
    const compatible = policy.compatible ?? function exactContractVersion(nextDemand, descriptor) {
        return descriptor.contractVersion == nextDemand.versionRange
    }
    const candidates: ContractCandidateStatus[] = []
    const accepted: ContractOffer[] = []

    for (const offer of input.offers) {
        validateContractOffer(offer)
        const descriptor = offer.descriptor
        let reason: string | null = null
        if (descriptor.contractId != demand.contractId) reason = 'different contract: ' + descriptor.contractId
        else if (!compatible(demand, descriptor)) reason = `incompatible version: ${descriptor.contractVersion} does not satisfy ${demand.versionRange}`
        else reason = capabilityReason(demand, descriptor)
        if (!reason) reason = input.unavailable?.(offer) ?? null
        if (!reason && policy.acceptOffer) reason = decision(await policy.acceptOffer(demand, offer), 'offer rejected by policy')
        const status: ContractCandidateStatus = {
            offerId: offer.id,
            descriptor: {...descriptor, capabilities: descriptor.capabilities ? [...descriptor.capabilities] : undefined},
            accepted: !reason,
            reason,
            priority: offer.priority ?? 0,
        }
        candidates.push(status)
        if (!reason) accepted.push(offer)
    }

    const compare = policy.compareOffers ?? defaultCompareOffers
    accepted.sort(function compareAccepted(a, b) {
        const preferred = compare(a, b, demand)
        return preferred ? -preferred : a.id.localeCompare(b.id)
    })
    const rank = new Map(accepted.map((offer, index) => [offer.id, index]))
    candidates.sort(function compareCandidateStatus(a, b) {
        if (a.accepted != b.accepted) return a.accepted ? -1 : 1
        if (a.accepted) return rank.get(a.offerId)! - rank.get(b.offerId)!
        return a.offerId.localeCompare(b.offerId)
    })
    const result: ContractResolution = {demand, candidates, accepted, selected: accepted[0] ?? null}
    return result
}

export function defaultCompareContractDemands(a: ContractDemand, b: ContractDemand) {
    if (a.authorityEpoch != b.authorityEpoch) return a.authorityEpoch - b.authorityEpoch
    const authority = a.authorityId.localeCompare(b.authorityId)
    if (authority) return authority
    return a.generation - b.generation
}

