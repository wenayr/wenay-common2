// =====================================================================
// Contract runtime data — desired contracts, implementation offers, bindings
// =====================================================================

export type tContractSlotState =
    | 'idle'
    | 'resolving'
    | 'preparing'
    | 'active'
    | 'degraded'
    | 'failed'
    | 'closed'

export type ContractDescriptor = {
    protocol: 1
    contractId: string
    contractVersion: string
    implementationId: string
    implementationVersion: string
    runtimeVersion?: string
    integrity?: string
    capabilities?: readonly string[]
    proof?: unknown
}

export type ContractDemand = {
    slotId: string
    contractId: string
    /** Exact by default; an injected compatibility policy may interpret a range. */
    versionRange: string
    generation: number
    authorityId: string
    authorityEpoch: number
    required?: boolean
    capabilities?: readonly string[]
    proof?: unknown
}

export type ContractBinding = {
    slotId: string
    demand: ContractDemand
    offerId: string
    descriptor: ContractDescriptor
    bindingGeneration: number
    activatedAt: number
}

export type ContractSession<T extends object = any> = {
    api: T
    onFail?: {on: (cb: (reason?: unknown) => void) => any}
    /** Called after replacement, once acquired leases have drained or timed out. */
    drain?: (reason?: unknown) => void | Promise<void>
    close: () => void
}

export type ContractOfferContext = {
    demand: ContractDemand
    descriptor: ContractDescriptor
    previous: ContractBinding | null
}

/** A reusable implementation capability, not a live implementation. */
export type ContractOffer<T extends object = any> = {
    id: string
    descriptor: ContractDescriptor
    open: (ctx: ContractOfferContext) => ContractSession<T> | Promise<ContractSession<T>>
    /** Higher values are preferred after compatibility and policy checks. */
    priority?: number
}

export type ContractOfferSource = {
    list: () => readonly ContractOffer[]
    changes: {on: (cb: (offers: readonly ContractOffer[]) => void) => any}
}

export type ContractPolicyDecision = {
    accepted: boolean
    reason?: string
}

export type ContractPolicy = {
    /** Default: offered contract version must exactly equal demand.versionRange. */
    compatible?: (demand: ContractDemand, descriptor: ContractDescriptor) => boolean
    acceptDemand?: (demand: ContractDemand) => ContractPolicyDecision | Promise<ContractPolicyDecision>
    acceptOffer?: (demand: ContractDemand, offer: ContractOffer) => ContractPolicyDecision | Promise<ContractPolicyDecision>
    acceptSession?: (demand: ContractDemand, offer: ContractOffer, api: object) =>
        ContractPolicyDecision | Promise<ContractPolicyDecision>
    /** Positive means a is preferred. Default: priority, then stable offer id. */
    compareOffers?: (a: ContractOffer, b: ContractOffer, demand: ContractDemand) => number
    /** Positive means a is newer/preferred. Default: epoch, authority id, generation. */
    compareDemands?: (a: ContractDemand, b: ContractDemand) => number
}

export type ContractCandidateStatus = {
    offerId: string
    descriptor: ContractDescriptor
    accepted: boolean
    reason: string | null
    priority: number
}

export type ContractResolution = {
    demand: ContractDemand
    candidates: ContractCandidateStatus[]
    accepted: ContractOffer[]
    selected: ContractOffer | null
}

export type ContractSlotStatus = {
    slotId: string
    state: tContractSlotState
    demand: ContractDemand | null
    binding: ContractBinding | null
    previous: ContractBinding | null
    candidates: ContractCandidateStatus[]
    error: string | null
}

export type ContractRuntimeStatus = {
    closed: boolean
    slots: Record<string, ContractSlotStatus>
}

export type ContractBindingEvent = {
    at: number
    slotId: string
    from: ContractBinding | null
    to: ContractBinding | null
    reason: string
    error?: string
}

export type ContractExplanation = {
    slotId: string
    demand: ContractDemand | null
    binding: ContractBinding | null
    previous: ContractBinding | null
    candidates: ContractCandidateStatus[]
    state: tContractSlotState
    error: string | null
}

export type ContractLease<T extends object> = {
    api: T
    binding: ContractBinding
    release: () => void
}

