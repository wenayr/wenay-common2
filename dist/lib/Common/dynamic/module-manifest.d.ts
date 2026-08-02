export type ModuleManifestValidationLimits = {
    maxManifestBytes?: number;
    maxArtifactBytes?: number;
    maxDependencies?: number;
    maxListEntries?: number;
};
export type tSerializedModuleManifest = string | Uint8Array;
export declare function validateModuleManifest(input: unknown, limitOverrides?: ModuleManifestValidationLimits): {
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
export type ModuleManifest = ReturnType<typeof validateModuleManifest>;
export declare function parseModuleManifest(input: tSerializedModuleManifest, limitOverrides?: ModuleManifestValidationLimits): {
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
export declare function canonicalModuleManifest(manifest: ModuleManifest): string;
export declare function moduleManifestSignaturePayload(manifest: ModuleManifest): NodeJS.NonSharedUint8Array;
