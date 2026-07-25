import { ContractBinding, ContractBindingEvent, ContractDemand, ContractExplanation, ContractLease, ContractOffer, ContractOfferSource, ContractPolicy, ContractRuntimeStatus, ContractSlotStatus } from './contract-data';
export type ContractRuntimeDeps = {
    offers?: ContractOfferSource;
    policy?: ContractPolicy;
    retryMs?: number;
    drainTimeoutMs?: number;
    history?: number;
    now?: () => number;
};
export declare function createContractRuntime(deps?: ContractRuntimeDeps): {
    control: {
        require(demand: ContractDemand): Promise<{
            accepted: boolean;
            reason: string;
            replay?: undefined;
            status?: undefined;
        } | {
            reason?: undefined;
            accepted: boolean;
            replay: boolean;
            status: ContractSlotStatus;
        }>;
        apply(demands: readonly ContractDemand[]): Promise<({
            accepted: boolean;
            reason: string;
            replay?: undefined;
            status?: undefined;
        } | {
            reason?: undefined;
            accepted: boolean;
            replay: boolean;
            status: ContractSlotStatus;
        })[]>;
        release(slotId: string, reason?: string): Promise<boolean>;
        addOffer(offer: ContractOffer): Promise<void>;
        removeOffer(offerId: string): Promise<boolean>;
        replaceOffers(next: readonly ContractOffer[]): Promise<void>;
        revokeOffer(offerId: string, reason?: string): Promise<void>;
        restoreOffer(offerId: string): Promise<boolean>;
        reconcile(slotId?: string): Promise<void>;
        rollback(slotId: string): Promise<ContractBinding>;
    };
    api: {
        status: import("../Observe").Store<ContractRuntimeStatus>;
        changed: import("../..").ListenApi<[ContractBindingEvent]>;
        binding(slotId: string): ContractBinding | null;
        acquire<T extends object>(slotId: string): ContractLease<T>;
        explain(slotId: string): ContractExplanation;
        history: () => {
            at: number;
            slotId: string;
            reason: string;
            error?: string;
            from: ContractBinding | null;
            to: ContractBinding | null;
        }[];
    };
    close(): void;
};
export type ContractRuntime = ReturnType<typeof createContractRuntime>;
