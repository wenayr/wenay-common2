import { StoreDrain } from '../Observe/store';
export type FileResourceState = 'uploading' | 'uploaded' | 'failed';
export type FileJobState = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
export type FileResource = {
    id: string;
    owner: string;
    name: string;
    mime?: string;
    size: number;
    state: FileResourceState;
    createdAt: number;
    updatedAt: number;
    error?: string;
};
export type FileJob = {
    id: string;
    fileId: string;
    owner: string;
    state: FileJobState;
    progress: number;
    message?: string;
    result?: unknown;
    error?: string;
    createdAt: number;
    updatedAt: number;
};
export type FileJobStore = {
    files: Record<string, FileResource>;
    jobs: Record<string, FileJob>;
};
export type FileUploadRequest = {
    name: string;
    size: number;
    mime?: string;
};
export type FileStoragePort = {
    beginUpload(input: {
        file: FileResource;
    }): unknown | Promise<unknown>;
    confirmUpload?(input: {
        file: FileResource;
    }): void | Promise<void>;
    download?(input: {
        file: FileResource;
    }): unknown | Promise<unknown>;
};
export type FileJobReport = {
    progress?: number;
    message?: string;
    result?: unknown;
};
export type FileJobRunner = {
    run(input: {
        file: FileResource;
        job: FileJob;
        input: unknown;
        report: (next: FileJobReport) => void;
        cancelled: () => boolean;
    }): {
        result?: unknown;
    } | void | Promise<{
        result?: unknown;
    } | void>;
};
export type FileJobPolicy = {
    canRead?: (account: string, file: FileResource) => boolean;
    canWrite?: (account: string, file: FileResource) => boolean;
};
export type FileJobHostDeps = {
    storage: FileStoragePort;
    runner: FileJobRunner;
    policy?: FileJobPolicy;
    id?: () => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function createFileJobHost(deps: FileJobHostDeps): {
    connection: (account: string) => {
        fragment: {
            state: (import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]> & {
                batch?: ReturnType<(replay: {
                    emit: import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../..").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../..").ListenKey): boolean;
                    off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../..").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../..").ListenOff;
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
                        line: import("../..").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
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
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[];
                batch?: ReturnType<(replay: {
                    emit: import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../..").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../..").ListenKey): boolean;
                    off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../..").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../..").ListenOff;
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
                        line: import("../..").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
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
            startUpload: (request: FileUploadRequest) => Promise<{
                file: {
                    id: string;
                    owner: string;
                    name: string;
                    mime?: string;
                    size: number;
                    state: FileResourceState;
                    createdAt: number;
                    updatedAt: number;
                    error?: string;
                };
                upload: unknown;
            }>;
            confirmUpload: (fileId: string) => Promise<{
                id: string;
                owner: string;
                name: string;
                mime?: string;
                size: number;
                state: FileResourceState;
                createdAt: number;
                updatedAt: number;
                error?: string;
            }>;
            startJob: (fileId: string, input: unknown) => {
                result?: unknown;
                id: string;
                fileId: string;
                owner: string;
                state: FileJobState;
                progress: number;
                message?: string;
                error?: string;
                createdAt: number;
                updatedAt: number;
            };
            cancelJob: (jobId: string) => {
                result?: unknown;
                id: string;
                fileId: string;
                owner: string;
                state: FileJobState;
                progress: number;
                message?: string;
                error?: string;
                createdAt: number;
                updatedAt: number;
            };
            download: (fileId: string) => Promise<unknown>;
        };
        close(): void;
    };
    store: import("../Observe/store").Store<FileJobStore>;
    close(): void;
};
export type FileJobHost = ReturnType<typeof createFileJobHost>;
