import { ContractBinding, ContractBindingEvent, ContractDemand } from '../../Common/contract/contract-data';
import { ContractRuntime } from '../../Common/contract/contract-runtime';
import { ModuleArtifactVerifier, tModuleArtifactBytes } from '../../Common/dynamic/module-verifier';
import { ModuleManifest, tSerializedModuleManifest } from '../../Common/dynamic/module-manifest';
import { ModuleIsolationCallOptions, ModuleIsolationPort } from './module-isolation';
export type tDynamicModuleCandidateState = 'verifying' | 'instantiating' | 'warming' | 'health-checking' | 'ready' | 'activating' | 'active' | 'retired' | 'rejected' | 'closed';
export type DynamicModuleCandidateSnapshot = {
    candidateId: string;
    slotId: string;
    offerId: string | null;
    moduleId: string | null;
    version: string | null;
    contentHash: string | null;
    state: tDynamicModuleCandidateState;
    priority: number;
    createdAt: number;
    updatedAt: number;
    error: string | null;
};
export type tDynamicModuleHostEvent = {
    type: 'candidate';
    candidate: DynamicModuleCandidateSnapshot;
} | {
    type: 'binding';
    binding: ContractBindingEvent;
} | {
    type: 'audit';
    audit: DynamicModuleAuditEvent;
};
export type DynamicModuleAuditEvent = {
    at: number;
    action: string;
    candidateId?: string;
    slotId?: string;
    offerId?: string;
    moduleId?: string;
    version?: string;
    contentHash?: string;
    bindingGeneration?: number;
    correlationId?: string;
    error?: string;
};
export type DynamicModuleStageRequest = {
    candidateId?: string;
    slotId: string;
    priority?: number;
    manifest: tSerializedModuleManifest;
    bytes: tModuleArtifactBytes;
};
export type DynamicModuleCallOptions = {
    correlationId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
};
export type DynamicModuleCallPort = {
    call: <T>(method: string, input: unknown, opts: ModuleIsolationCallOptions) => Promise<T>;
};
export type DynamicModuleHostDeps = {
    verifier: ModuleArtifactVerifier;
    isolation: ModuleIsolationPort;
    runtime?: ContractRuntime;
    candidateId?: () => string;
    correlationId?: () => string;
    now?: () => number;
    auditLimit?: number;
    drainTimeoutMs?: number;
    dependencyCallTimeoutMs?: number;
    dependencySlot?: (dependency: ModuleManifest['dependencies'][number], owner: ModuleManifest) => string;
    dependencyCompatible?: (apiRange: string, activeVersion: string) => boolean;
};
export type DynamicModuleDependencyRequest = {
    moduleId: string;
    method: string;
    input: unknown;
    correlationId: string;
    bindingGeneration: number;
    dependency: ModuleManifest['dependencies'][number];
    callerModuleId: string;
    callerVersion: string;
    callerContentHash: `sha256:${string}`;
};
export declare class DynamicModuleHostError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
    });
}
export declare function createDynamicModuleHost(deps: DynamicModuleHostDeps): {
    control: {
        require: (demand: ContractDemand) => Promise<{
            accepted: boolean;
            reason: string;
            replay?: undefined;
            status?: undefined;
        } | {
            reason?: undefined;
            accepted: boolean;
            replay: boolean;
            status: import("../../Common/contract/contract-data").ContractSlotStatus;
        }>;
        stage: (request: DynamicModuleStageRequest) => Promise<DynamicModuleCandidateSnapshot>;
        activate: (candidateId: string) => Promise<ContractBinding>;
        rollback: (slotId: string) => Promise<ContractBinding>;
        revoke: (candidateId: string, reason?: string) => Promise<boolean>;
        discard: (candidateId: string, reason?: string) => Promise<boolean>;
    };
    resource: {
        handle: (slotId: string) => {
            call<T>(method: string, input: unknown, opts?: DynamicModuleCallOptions): Promise<T>;
            view: {
                binding: () => ContractBinding | null;
            };
        };
        dependencyCall: (request: DynamicModuleDependencyRequest) => Promise<unknown>;
    };
    events: {
        on: import("../..").ListenOn<[tDynamicModuleHostEvent]>;
    };
    view: {
        snapshot(): {
            closed: boolean;
            candidates: {
                [k: string]: DynamicModuleCandidateSnapshot;
            };
            contracts: import("../../Common/contract/contract-data").ContractRuntimeStatus;
        };
        candidate: (candidateId: string) => DynamicModuleCandidateSnapshot | null;
        binding: (slotId: string) => ContractBinding | null;
        explain: (slotId: string) => import("../../Common/contract/contract-data").ContractExplanation;
        audit: () => {
            at: number;
            action: string;
            candidateId?: string;
            slotId?: string;
            offerId?: string;
            moduleId?: string;
            version?: string;
            contentHash?: string;
            bindingGeneration?: number;
            correlationId?: string;
            error?: string;
        }[];
    };
    health: {
        snapshot(): {
            [k: string]: {
                health: string;
                inFlight: number;
            };
        };
    };
    close(): Promise<void>;
};
export type DynamicModuleHost = ReturnType<typeof createDynamicModuleHost>;
