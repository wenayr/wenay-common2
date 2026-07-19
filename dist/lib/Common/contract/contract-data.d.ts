export type tContractSlotState = 'idle' | 'resolving' | 'preparing' | 'active' | 'degraded' | 'failed' | 'closed';
export type ContractDescriptor = {
    protocol: 1;
    contractId: string;
    contractVersion: string;
    implementationId: string;
    implementationVersion: string;
    runtimeVersion?: string;
    integrity?: string;
    capabilities?: readonly string[];
    proof?: unknown;
};
export type ContractDemand = {
    slotId: string;
    contractId: string;
    versionRange: string;
    generation: number;
    authorityId: string;
    authorityEpoch: number;
    required?: boolean;
    capabilities?: readonly string[];
    proof?: unknown;
};
export type ContractBinding = {
    slotId: string;
    demand: ContractDemand;
    offerId: string;
    descriptor: ContractDescriptor;
    bindingGeneration: number;
    activatedAt: number;
};
export type ContractSession<T extends object = any> = {
    api: T;
    onFail?: {
        on: (cb: (reason?: unknown) => void) => any;
    };
    drain?: (reason?: unknown) => void | Promise<void>;
    close: () => void;
};
export type ContractOfferContext = {
    demand: ContractDemand;
    descriptor: ContractDescriptor;
    previous: ContractBinding | null;
};
export type ContractOffer<T extends object = any> = {
    id: string;
    descriptor: ContractDescriptor;
    open: (ctx: ContractOfferContext) => ContractSession<T> | Promise<ContractSession<T>>;
    priority?: number;
};
export type ContractOfferSource = {
    list: () => readonly ContractOffer[];
    changes: {
        on: (cb: (offers: readonly ContractOffer[]) => void) => any;
    };
};
export type ContractPolicyDecision = {
    accepted: boolean;
    reason?: string;
};
export type ContractPolicy = {
    compatible?: (demand: ContractDemand, descriptor: ContractDescriptor) => boolean;
    acceptDemand?: (demand: ContractDemand) => ContractPolicyDecision | Promise<ContractPolicyDecision>;
    acceptOffer?: (demand: ContractDemand, offer: ContractOffer) => ContractPolicyDecision | Promise<ContractPolicyDecision>;
    acceptSession?: (demand: ContractDemand, offer: ContractOffer, api: object) => ContractPolicyDecision | Promise<ContractPolicyDecision>;
    compareOffers?: (a: ContractOffer, b: ContractOffer, demand: ContractDemand) => number;
    compareDemands?: (a: ContractDemand, b: ContractDemand) => number;
};
export type ContractCandidateStatus = {
    offerId: string;
    descriptor: ContractDescriptor;
    accepted: boolean;
    reason: string | null;
    priority: number;
};
export type ContractResolution = {
    demand: ContractDemand;
    candidates: ContractCandidateStatus[];
    accepted: ContractOffer[];
    selected: ContractOffer | null;
};
export type ContractSlotStatus = {
    slotId: string;
    state: tContractSlotState;
    demand: ContractDemand | null;
    binding: ContractBinding | null;
    previous: ContractBinding | null;
    candidates: ContractCandidateStatus[];
    error: string | null;
};
export type ContractRuntimeStatus = {
    closed: boolean;
    slots: Record<string, ContractSlotStatus>;
};
export type ContractBindingEvent = {
    at: number;
    slotId: string;
    from: ContractBinding | null;
    to: ContractBinding | null;
    reason: string;
    error?: string;
};
export type ContractExplanation = {
    slotId: string;
    demand: ContractDemand | null;
    binding: ContractBinding | null;
    previous: ContractBinding | null;
    candidates: ContractCandidateStatus[];
    state: tContractSlotState;
    error: string | null;
};
export type ContractLease<T extends object> = {
    api: T;
    binding: ContractBinding;
    release: () => void;
};
