import { VerifiedModuleArtifact } from '../../Common/dynamic/module-verifier';
import { ModuleIsolationOpenInput } from './module-isolation';
import { ModuleWorkerSessionDeps } from './module-worker';
export type ModuleWorkerIsolationDeps = {
    startupTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    dependencyCall?: ModuleWorkerSessionDeps['dependencyCall'];
    resolveMcpPolicy?: (artifact: VerifiedModuleArtifact) => ModuleWorkerSessionDeps['mcpPolicy'];
};
export declare function createModuleWorkerIsolation(deps?: ModuleWorkerIsolationDeps): {
    resource: {
        open: (input: ModuleIsolationOpenInput) => {
            control: {
                start: () => Promise<void>;
                terminate: (reason?: string) => Promise<void>;
            };
            resource: {
                call: <T>(method: string, input: unknown, opts: import("./module-worker").ModuleWorkerCallOptions) => Promise<T>;
            };
            events: {
                on: import("../..").ListenOn<[import("./module-worker").tModuleWorkerSessionEvent]>;
            };
            view: {
                snapshot: () => {
                    moduleId: string;
                    version: string;
                    contentHash: `sha256:${string}`;
                    candidateId: string;
                    bindingGeneration: number;
                    state: "closed" | "failed" | "idle" | "ready" | "starting" | "terminating";
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
                        registrations: import("./module-worker").ModuleWorkerMcpRegistration[];
                    };
                    memoryMb: number;
                    failure: {
                        code: "E_CALL_ABORTED" | "E_CALL_TIMEOUT" | "E_CONCURRENCY_LIMIT" | "E_DEPENDENCY_UNAVAILABLE" | "E_HEARTBEAT_TIMEOUT" | "E_INPUT_LIMIT" | "E_INVALID_VERIFIED_SOURCE" | "E_MCP_REGISTRATION" | "E_MCP_TOOL_UNAVAILABLE" | "E_METHOD_NOT_FOUND" | "E_MODULE_CALL" | "E_OUTPUT_LIMIT" | "E_SESSION_CLOSED" | "E_SESSION_STATE" | "E_SOURCE_LIMIT" | "E_WORKER_EXIT" | "E_WORKER_PROTOCOL" | "E_WORKER_START";
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
                    health: "closed" | "healthy" | "unhealthy" | "unknown";
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
                    call: <T>(registrationId: number, input: unknown, opts: import("./module-worker").ModuleWorkerCallOptions) => Promise<T>;
                };
                events: {
                    on(cb: (event: Extract<import("./module-worker").tModuleWorkerSessionEvent, {
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
                        registrations: import("./module-worker").ModuleWorkerMcpRegistration[];
                    };
                };
            };
        };
    };
};
export type ModuleWorkerIsolation = ReturnType<typeof createModuleWorkerIsolation>;
