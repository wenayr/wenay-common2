import { ContractOffer } from './contract-data';
export declare function createContractOffers(initial?: readonly ContractOffer[]): {
    control: {
        upsert: (offer: ContractOffer) => () => void;
        remove(id: string): boolean;
        replace: (next: readonly ContractOffer[]) => void;
        clear(): void;
    };
    api: {
        list: () => ContractOffer[];
        changes: import("../events/Listen").ListenApi<[readonly ContractOffer[]]>;
    };
};
export type ContractOffers = ReturnType<typeof createContractOffers>;
