import { ContractDemand, ContractDescriptor, ContractOffer, ContractPolicy, ContractResolution } from './contract-data';
export declare function validateContractDescriptor(value: ContractDescriptor): ContractDescriptor;
export declare function validateContractDemand(value: ContractDemand): ContractDemand;
export declare function validateContractOffer(value: ContractOffer): ContractOffer;
export type ResolveContractBindingInput = {
    demand: ContractDemand;
    offers: readonly ContractOffer[];
    policy?: ContractPolicy;
    unavailable?: (offer: ContractOffer) => string | null;
};
export declare function resolveContractBinding(input: ResolveContractBindingInput): Promise<ContractResolution>;
export declare function defaultCompareContractDemands(a: ContractDemand, b: ContractDemand): number;
