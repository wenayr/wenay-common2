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
            state: (import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]> & {
                batch?: ReturnType<(replay: {
                    emit: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../events/Listen").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../events/Listen").ListenKey): boolean;
                    off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../events/Listen").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../events/Listen").ListenOff;
                }, prepareRead: () => void) => {
                    v2: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        } | undefined;
                    };
                    v3: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        } | undefined;
                    };
                    v4: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        } | undefined;
                    };
                    v5: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        } | undefined;
                    };
                    v6: {
                        line: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        };
                        since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined;
                        keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        } | undefined;
                    };
                    v7: {
                        line: import("../events/Listen").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
                        since: (seq: number, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null;
                        keyframe: (_snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null;
                        frame: (seq: number, hint?: unknown, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[];
                    };
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                    keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatch | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    } | undefined;
                }>;
            }) | {
                describe: () => Record<string, any>;
                line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[];
                batch?: ReturnType<(replay: {
                    emit: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../events/Listen").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../events/Listen").ListenKey): boolean;
                    off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../events/Listen").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../events/Listen").ListenOff;
                }, prepareRead: () => void) => {
                    v2: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        } | undefined;
                    };
                    v3: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        } | undefined;
                    };
                    v4: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        } | undefined;
                    };
                    v5: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        } | undefined;
                    };
                    v6: {
                        line: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        };
                        since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined;
                        keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        } | undefined;
                    };
                    v7: {
                        line: import("../events/Listen").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
                        since: (seq: number, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null;
                        keyframe: (_snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null;
                        frame: (seq: number, hint?: unknown, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[];
                    };
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                    keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatch | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    } | undefined;
                }>;
            };
            events: import("../events/replay-wire").ReplayExpose<[AiRunEvent]>;
            createRun: (request: AiRunRequest) => AiRun;
            cancelRun: (runId: string, reason?: string) => AiRun;
            resolveApproval: (approvalId: string, decision: "approved" | "rejected") => {
                data?: unknown;
                id: string;
                runId: string;
                kind: string;
                label: string;
                state: AiApprovalState;
                createdAt: number;
                updatedAt: number;
            };
            provideInput: (inputId: string, value: unknown) => {
                schema?: unknown;
                id: string;
                runId: string;
                label: string;
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
