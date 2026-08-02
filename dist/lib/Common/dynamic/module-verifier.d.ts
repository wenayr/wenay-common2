import { ModuleManifest, ModuleManifestValidationLimits, tSerializedModuleManifest } from './module-manifest';
export type ModulePolicyDecision = {
    accepted: boolean;
    reason?: string;
};
export type ModuleVerificationPolicy = {
    publisherKeyIds: readonly string[];
    capabilities?: readonly string[];
    permissions?: {
        network?: readonly string[];
        storage?: readonly string[];
        secrets?: readonly string[];
    };
    accept?: (input: {
        manifest: ModuleManifest;
        contentHash: string;
        manifestHash: string;
    }) => ModulePolicyDecision | Promise<ModulePolicyDecision>;
};
export type ModuleSignatureVerifier = (input: {
    algorithm: string;
    keyId: string;
    signature: string;
    payload: Uint8Array;
}) => boolean | ModulePolicyDecision | Promise<boolean | ModulePolicyDecision>;
export type ModuleArtifactVerifierDeps = {
    verifySignature: ModuleSignatureVerifier;
    policy: ModuleVerificationPolicy;
    manifestLimits?: ModuleManifestValidationLimits;
    now?: () => number;
};
export type tModuleArtifactBytes = string | Uint8Array;
declare function createVerifiedModuleArtifact(input: {
    manifest: ModuleManifest;
    bytes: Uint8Array;
    manifestHash: string;
    verifiedAt: number;
}): Readonly<{
    manifest: {
        readonly manifestProtocol: 1;
        readonly moduleId: string;
        readonly version: string;
        readonly contentHash: string;
        readonly entrypoint: string;
        readonly compatibility: {
            readonly api: {
                readonly contractId: string;
                readonly version: string;
            };
            readonly schema?: {
                readonly id: string;
                readonly version: string;
            } | undefined;
            readonly state?: {
                readonly id: string;
                readonly version: string;
            } | undefined;
            readonly runtime?: {
                readonly name: unknown;
                readonly range: string;
            } | undefined;
        };
        readonly dependencies: readonly {
            readonly moduleId: string;
            readonly apiRange: string;
            readonly required: boolean;
            readonly capabilities?: readonly string[] | undefined;
            readonly degradation?: "cached-read" | "reject" | "unavailable-result" | undefined;
        }[];
        readonly capabilities: readonly string[];
        readonly permissions: {
            readonly network?: readonly string[] | undefined;
            readonly storage?: readonly string[] | undefined;
            readonly secrets?: readonly string[] | undefined;
        };
        readonly integrity: {
            readonly algorithm: 'sha256';
            readonly digest: string;
            readonly size: number;
        };
        readonly signature: {
            readonly algorithm: string;
            readonly keyId: string;
            readonly value: string;
            readonly signedFields: readonly string[];
        };
        readonly migration?: {
            readonly fromStateRanges: readonly string[];
            readonly prepareHook?: string | undefined;
            readonly commitHook?: string | undefined;
            readonly abortHook?: string | undefined;
            readonly reversible: boolean;
        } | undefined;
        readonly health: {
            readonly warmupHook?: string | undefined;
            readonly checkHook: string;
            readonly timeoutMs: number;
            readonly failureThreshold: number;
        };
        readonly budget: {
            readonly callTimeoutMs: number;
            readonly warmupTimeoutMs: number;
            readonly memoryMb?: number | undefined;
            readonly cpuMs?: number | undefined;
            readonly concurrency?: number | undefined;
        };
    };
    descriptor: Readonly<{
        moduleId: string;
        version: string;
        contentHash: string;
        manifestHash: string;
        apiContractId: string;
        apiVersion: string;
        stateVersion?: string | undefined;
        publisherKeyId: string;
        verifiedAt: number;
    }>;
    resource: Readonly<{
        bytes(): Uint8Array<ArrayBuffer>;
    }>;
}>;
export type VerifiedModuleArtifact = ReturnType<typeof createVerifiedModuleArtifact>;
export declare function assertVerifiedModuleArtifact(value: unknown): asserts value is VerifiedModuleArtifact;
export declare function createModuleArtifactVerifier(deps: ModuleArtifactVerifierDeps): {
    control: {
        verify: (input: {
            manifest: tSerializedModuleManifest;
            bytes: tModuleArtifactBytes;
        }) => Promise<Readonly<{
            manifest: {
                readonly manifestProtocol: 1;
                readonly moduleId: string;
                readonly version: string;
                readonly contentHash: string;
                readonly entrypoint: string;
                readonly compatibility: {
                    readonly api: {
                        readonly contractId: string;
                        readonly version: string;
                    };
                    readonly schema?: {
                        readonly id: string;
                        readonly version: string;
                    } | undefined;
                    readonly state?: {
                        readonly id: string;
                        readonly version: string;
                    } | undefined;
                    readonly runtime?: {
                        readonly name: unknown;
                        readonly range: string;
                    } | undefined;
                };
                readonly dependencies: readonly {
                    readonly moduleId: string;
                    readonly apiRange: string;
                    readonly required: boolean;
                    readonly capabilities?: readonly string[] | undefined;
                    readonly degradation?: "cached-read" | "reject" | "unavailable-result" | undefined;
                }[];
                readonly capabilities: readonly string[];
                readonly permissions: {
                    readonly network?: readonly string[] | undefined;
                    readonly storage?: readonly string[] | undefined;
                    readonly secrets?: readonly string[] | undefined;
                };
                readonly integrity: {
                    readonly algorithm: 'sha256';
                    readonly digest: string;
                    readonly size: number;
                };
                readonly signature: {
                    readonly algorithm: string;
                    readonly keyId: string;
                    readonly value: string;
                    readonly signedFields: readonly string[];
                };
                readonly migration?: {
                    readonly fromStateRanges: readonly string[];
                    readonly prepareHook?: string | undefined;
                    readonly commitHook?: string | undefined;
                    readonly abortHook?: string | undefined;
                    readonly reversible: boolean;
                } | undefined;
                readonly health: {
                    readonly warmupHook?: string | undefined;
                    readonly checkHook: string;
                    readonly timeoutMs: number;
                    readonly failureThreshold: number;
                };
                readonly budget: {
                    readonly callTimeoutMs: number;
                    readonly warmupTimeoutMs: number;
                    readonly memoryMb?: number | undefined;
                    readonly cpuMs?: number | undefined;
                    readonly concurrency?: number | undefined;
                };
            };
            descriptor: Readonly<{
                moduleId: string;
                version: string;
                contentHash: string;
                manifestHash: string;
                apiContractId: string;
                apiVersion: string;
                stateVersion?: string | undefined;
                publisherKeyId: string;
                verifiedAt: number;
            }>;
            resource: Readonly<{
                bytes(): Uint8Array<ArrayBuffer>;
            }>;
        }>>;
    };
};
export type ModuleArtifactVerifier = ReturnType<typeof createModuleArtifactVerifier>;
export {};
