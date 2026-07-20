import { StoreDrain } from '../Observe/store';
export type AiRunState = 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type AiApprovalState = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type AiInputState = 'waiting' | 'provided' | 'cancelled';
export type AiRunUsage = {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
};
export type AiArtifact = {
    id: string;
    kind: string;
    label?: string;
    resourceId?: string;
    descriptor?: unknown;
};
export type AiRun = {
    id: string;
    owner: string;
    requestId: string;
    kind: string;
    resourceIds: string[];
    state: AiRunState;
    progress: number;
    message?: string;
    result?: unknown;
    artifacts: AiArtifact[];
    usage?: AiRunUsage;
    error?: string;
    createdAt: number;
    updatedAt: number;
};
export type AiRunApproval = {
    id: string;
    runId: string;
    kind: string;
    label: string;
    data?: unknown;
    state: AiApprovalState;
    createdAt: number;
    updatedAt: number;
};
export type AiRunInput = {
    id: string;
    runId: string;
    label: string;
    schema?: unknown;
    state: AiInputState;
    createdAt: number;
    updatedAt: number;
};
export type AiRunStore = {
    runs: Record<string, AiRun>;
    approvals: Record<string, AiRunApproval>;
    inputs: Record<string, AiRunInput>;
};
export type AiCapability = {
    kind: string;
    label?: string;
    inputSchema?: unknown;
    acceptsResources?: boolean;
};
export type AiRunRequest = {
    requestId: string;
    kind: string;
    input: unknown;
    resourceIds?: string[];
};
export type AiRunReport = {
    progress?: number;
    message?: string;
    usage?: AiRunUsage;
};
export type AiArtifactInput = Omit<AiArtifact, 'id'> & {
    id?: string;
};
export type AiRunLiveEvent = {
    type: 'text.delta';
    text: string;
} | {
    type: 'notice';
    message: string;
    data?: unknown;
} | {
    type: 'tool.call';
    callId: string;
    name: string;
    input?: unknown;
} | {
    type: 'tool.result';
    callId: string;
    result?: unknown;
};
export type AiRunEvent = {
    type: 'sync';
    runs: AiRun[];
    approvals: AiRunApproval[];
    inputs: AiRunInput[];
} | ({
    runId: string;
} & (AiRunLiveEvent | {
    type: 'started';
} | {
    type: 'progress';
    progress: number;
    message?: string;
    usage?: AiRunUsage;
} | {
    type: 'artifact';
    artifact: AiArtifact;
} | {
    type: 'approval.requested';
    approval: AiRunApproval;
} | {
    type: 'approval.resolved';
    approval: AiRunApproval;
} | {
    type: 'input.requested';
    input: AiRunInput;
} | {
    type: 'input.provided';
    input: AiRunInput;
} | {
    type: 'completed';
    result?: unknown;
    usage?: AiRunUsage;
} | {
    type: 'failed';
    error: string;
} | {
    type: 'cancelled';
    reason?: string;
}));
export type AiRunOutput = {
    result?: unknown;
    usage?: AiRunUsage;
};
export type AiRunRunner = {
    run(input: {
        run: AiRun;
        input: unknown;
        resourceIds: string[];
        report: (next: AiRunReport) => void;
        emit: (event: AiRunLiveEvent) => void;
        artifact: (artifact: AiArtifactInput) => AiArtifact | undefined;
        requestApproval: (request: {
            kind: string;
            label: string;
            data?: unknown;
        }) => Promise<'approved' | 'rejected'>;
        waitForInput: (request: {
            label: string;
            schema?: unknown;
        }) => Promise<unknown>;
        cancelled: () => boolean;
    }): AiRunOutput | void | Promise<AiRunOutput | void>;
    cancel?(input: {
        run: AiRun;
        reason?: string;
    }): void | Promise<void>;
};
export type AiRunPolicy = {
    canRead?: (account: string, run: AiRun) => boolean;
    canWrite?: (account: string, run: AiRun) => boolean;
    canCreate?: (account: string, request: AiRunRequest) => boolean;
};
export type AiRunHostDeps = {
    runner: AiRunRunner;
    capabilities?: AiCapability[];
    policy?: AiRunPolicy;
    id?: () => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function createAiRunHost(deps: AiRunHostDeps): {
    connection: (account: string) => {
        fragment: {
            capabilities: () => {
                kind: string;
                label?: string;
                inputSchema?: unknown;
                acceptsResources?: boolean;
            }[];
            state: import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]> | {
                describe: () => {
                    [x: string]: any;
                };
                line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[];
            };
            events: import("../events/replay-wire").ReplayExpose<[AiRunEvent]>;
            createRun: (request: AiRunRequest) => AiRun;
            cancelRun: (runId: string, reason?: string) => AiRun;
            resolveApproval: (approvalId: string, decision: "approved" | "rejected") => {
                id: string;
                runId: string;
                kind: string;
                label: string;
                data?: unknown;
                state: AiApprovalState;
                createdAt: number;
                updatedAt: number;
            };
            provideInput: (inputId: string, value: unknown) => {
                id: string;
                runId: string;
                label: string;
                schema?: unknown;
                state: AiInputState;
                createdAt: number;
                updatedAt: number;
            };
        };
        close(): void;
    };
    store: import("../Observe/store").Store<AiRunStore>;
    close(): void;
};
export type AiRunHost = ReturnType<typeof createAiRunHost>;
