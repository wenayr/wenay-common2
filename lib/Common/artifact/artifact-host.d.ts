import { Store, StoreDrain } from '../Observe/store';
export type ArtifactRuntime = 'sandboxed-iframe' | 'download';
export type ArtifactState = 'ready' | 'revoked' | 'expired';
export type ArtifactRetention = {
    class: 'ephemeral';
    expiresAt: number;
} | {
    class: 'persistent';
    expiresAt?: number;
};
export type ArtifactDescriptor = {
    kind: string;
    label: string;
    runtime: ArtifactRuntime;
    mime?: string;
    version?: string;
};
export type ArtifactRecord = {
    id: string;
    owner: string;
    descriptor: ArtifactDescriptor;
    state: ArtifactState;
    retention: ArtifactRetention;
    createdAt: number;
    updatedAt: number;
};
export type ArtifactStore = {
    artifacts: Record<string, ArtifactRecord>;
};
export type ArtifactOpenInstruction = {
    url: string;
    expiresAt: number;
};
export type ArtifactStoragePort = {
    open(input: {
        artifact: ArtifactRecord;
        storageKey: unknown;
        account: string;
    }): ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>;
    remove?(input: {
        artifact: ArtifactRecord;
        storageKey: unknown;
        reason: 'revoked' | 'expired';
    }): void | Promise<void>;
    adoptKey?(artifact: ArtifactRecord): unknown | undefined;
};
export type ArtifactRegisterInput = {
    owner: string;
    descriptor: ArtifactDescriptor;
    storageKey: unknown;
    retention: ArtifactRetention;
};
export type ArtifactPolicy = {
    canRead?: (account: string, artifact: ArtifactRecord) => boolean;
    canRevoke?: (account: string, artifact: ArtifactRecord) => boolean;
    canRegister?: (input: ArtifactRegisterInput) => boolean;
};
export type ArtifactHostDeps = {
    storage: ArtifactStoragePort;
    policy?: ArtifactPolicy;
    store?: Store<ArtifactStore>;
    id?: () => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function copyArtifact(artifact: ArtifactRecord): ArtifactRecord;
export declare function validateOpenInstruction(instruction: ArtifactOpenInstruction, now: number): {
    url: string;
    expiresAt: number;
};
export declare function createArtifactHost(deps: ArtifactHostDeps): {
    register: (input: ArtifactRegisterInput) => ArtifactRecord;
    reap: (at?: number) => Promise<ArtifactRecord[]>;
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
            open: (artifactId: string) => Promise<{
                url: string;
                expiresAt: number;
            }>;
            revoke: (artifactId: string) => Promise<ArtifactRecord>;
        };
        close(): void;
    };
    store: Store<ArtifactStore>;
    close(): void;
};
export type ArtifactHost = ReturnType<typeof createArtifactHost>;
