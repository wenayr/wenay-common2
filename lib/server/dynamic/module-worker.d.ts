export declare const MODULE_WORKER_VERIFIED_SOURCE: 'wenay-common2/verified-module-source@1';
export type VerifiedModuleSource = {
    verification: typeof MODULE_WORKER_VERIFIED_SOURCE;
    moduleId: string;
    version: string;
    contentHash: `sha256:${string}`;
    source: string;
};
type tModuleWorkerState = 'idle' | 'starting' | 'ready' | 'terminating' | 'closed' | 'failed';
type tModuleWorkerHealth = 'unknown' | 'healthy' | 'unhealthy' | 'closed';
type tModuleWorkerErrorCode = 'E_INVALID_VERIFIED_SOURCE' | 'E_SOURCE_LIMIT' | 'E_SESSION_STATE' | 'E_SESSION_CLOSED' | 'E_WORKER_START' | 'E_WORKER_EXIT' | 'E_WORKER_PROTOCOL' | 'E_HEARTBEAT_TIMEOUT' | 'E_CALL_TIMEOUT' | 'E_CALL_ABORTED' | 'E_CONCURRENCY_LIMIT' | 'E_INPUT_LIMIT' | 'E_OUTPUT_LIMIT' | 'E_METHOD_NOT_FOUND' | 'E_MCP_REGISTRATION' | 'E_MCP_TOOL_UNAVAILABLE' | 'E_DEPENDENCY_UNAVAILABLE' | 'E_MODULE_CALL';
type ModuleWorkerMetadata = {
    moduleId: string;
    version: string;
    contentHash: `sha256:${string}`;
    candidateId: string;
    bindingGeneration: number;
};
export type tModuleWorkerMcpLifetime = 'host' | 'generation' | 'session';
export type ModuleWorkerMcpAnnotations = {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
};
export type ModuleWorkerMcpToolDescriptor = {
    contributionId: string;
    lifetime: tModuleWorkerMcpLifetime;
    toolId: string;
    title?: string;
    description?: string;
    annotations?: ModuleWorkerMcpAnnotations;
};
export type ModuleWorkerMcpPolicy = {
    contributions: readonly {
        contributionId: string;
        lifetime: tModuleWorkerMcpLifetime;
        tools: readonly Omit<ModuleWorkerMcpToolDescriptor, 'contributionId' | 'lifetime'>[];
    }[];
    maxTools?: number;
};
type tModuleWorkerMcpRegistrationState = 'accepted' | 'attached' | 'detached' | 'rejected' | 'removed';
export type ModuleWorkerMcpRegistration = {
    registrationId: number;
    descriptor: ModuleWorkerMcpToolDescriptor;
    state: tModuleWorkerMcpRegistrationState;
    reason?: string;
};
export type tModuleWorkerSessionEvent = {
    type: 'state';
    state: tModuleWorkerState;
    at: number;
    reason?: string;
} | {
    type: 'heartbeat';
    at: number;
} | {
    type: 'call';
    phase: 'started' | 'settled';
    callId: number;
    method: string;
    correlationId: string;
    bindingGeneration: number;
    at: number;
} | {
    type: 'mcp';
    phase: tModuleWorkerMcpRegistrationState;
    registration: ModuleWorkerMcpRegistration;
    at: number;
} | {
    type: 'error';
    error: ModuleWorkerError;
    at: number;
};
export declare class ModuleWorkerError extends Error {
    readonly code: tModuleWorkerErrorCode;
    readonly moduleId: string;
    readonly version: string;
    readonly candidateId: string;
    readonly bindingGeneration: number;
    readonly correlationId: string | undefined;
    readonly remoteStack: string | undefined;
    constructor(code: tModuleWorkerErrorCode, message: string, metadata: ModuleWorkerMetadata, opts?: {
        cause?: unknown;
        correlationId?: string;
        remoteStack?: string;
    });
}
export type ModuleWorkerSessionDeps = {
    verified: VerifiedModuleSource;
    candidateId: string;
    bindingGeneration: number;
    startupTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    defaultCallTimeoutMs?: number;
    maxCallTimeoutMs?: number;
    maxConcurrentCalls?: number;
    maxSourceBytes?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    memoryMb?: number;
    allowedDependencies?: readonly ModuleWorkerDependencyPolicy[];
    mcpPolicy?: ModuleWorkerMcpPolicy;
    dependencyCall?: (request: {
        moduleId: string;
        method: string;
        input: unknown;
        correlationId: string;
        bindingGeneration: number;
        dependency: ModuleWorkerDependencyPolicy;
        callerModuleId: string;
        callerVersion: string;
        callerContentHash: `sha256:${string}`;
    }) => unknown | Promise<unknown>;
};
export type ModuleWorkerDependencyPolicy = {
    moduleId: string;
    apiRange: string;
    required: boolean;
    capabilities?: readonly string[];
    degradation?: 'unavailable-result' | 'cached-read' | 'reject';
};
export type ModuleWorkerCallOptions = {
    correlationId: string;
    bindingGeneration?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
};
export declare function createModuleWorkerSession(deps: ModuleWorkerSessionDeps): {
    control: {
        start: () => Promise<void>;
        terminate: (reason?: string) => Promise<void>;
    };
    resource: {
        call: <T>(method: string, input: unknown, opts: ModuleWorkerCallOptions) => Promise<T>;
    };
    events: {
        on: import("../..").ListenOn<[tModuleWorkerSessionEvent]>;
    };
    view: {
        snapshot: () => {
            moduleId: string;
            version: string;
            contentHash: `sha256:${string}`;
            candidateId: string;
            bindingGeneration: number;
            state: tModuleWorkerState;
            startedAt: number | null;
            closedAt: number | null;
            lastHeartbeatAt: number | null;
            inFlight: number;
            methods: string[];
            mcp: {
                enabled: boolean;
                total: number;
                accepted: number;
                attached: number;
                detached: number;
                rejected: number;
                removed: number;
                registrations: ModuleWorkerMcpRegistration[];
            };
            memoryMb: number;
            failure: {
                code: tModuleWorkerErrorCode;
                message: string;
            } | null;
        };
    };
    health: {
        snapshot: () => {
            moduleId: string;
            version: string;
            contentHash: `sha256:${string}`;
            candidateId: string;
            bindingGeneration: number;
            health: tModuleWorkerHealth;
            lastHeartbeatAt: number | null;
            inFlight: number;
            maxConcurrentCalls: number;
            memoryMb: number;
            mcpAccepted: number;
        };
    };
    mcp: {
        control: {
            setPublished: (registrationId: number, attached: boolean, reason?: string) => boolean;
        };
        resource: {
            call: <T>(registrationId: number, input: unknown, opts: ModuleWorkerCallOptions) => Promise<T>;
        };
        events: {
            on(cb: (event: Extract<tModuleWorkerSessionEvent, {
                type: 'mcp';
            }>) => void): import("../..").ListenOff;
        };
        view: {
            snapshot: () => {
                enabled: boolean;
                total: number;
                accepted: number;
                attached: number;
                detached: number;
                rejected: number;
                removed: number;
                registrations: ModuleWorkerMcpRegistration[];
            };
        };
    };
};
export type ModuleWorkerSession = ReturnType<typeof createModuleWorkerSession>;
export {};
