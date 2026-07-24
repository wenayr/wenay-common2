import { Store, StoreDrain } from '../Observe/store';
import { ArtifactOpenInstruction, ArtifactPolicy, ArtifactRecord, ArtifactStore } from './artifact-host';
export type ArtifactMirrorDeps = {
    catalog: Store<ArtifactStore>;
    policy?: Pick<ArtifactPolicy, 'canRead' | 'canRevoke'>;
    open: (input: {
        artifact: ArtifactRecord;
        account: string;
    }) => Promise<ArtifactOpenInstruction> | ArtifactOpenInstruction;
    revoke?: (account: string, artifactId: string) => Promise<ArtifactRecord> | ArtifactRecord;
    history?: number;
    drain?: StoreDrain;
    now?: () => number;
};
export declare function createArtifactMirror(deps: ArtifactMirrorDeps): {
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
                        line: {
                            on(cb: (wire: import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7) => void, opts?: {
                                knowledge?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge;
                            }): import("../..").ListenOff;
                            emit: import("../..").Listener<Buffer<ArrayBufferLike>[]>;
                            has(key: import("../..").ListenKey): boolean;
                            off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<Buffer<ArrayBufferLike>[]> | null): void;
                            once(cb: import("../..").Listener<Buffer<ArrayBufferLike>[]>, opts?: {
                                key?: import("../..").ListenKey;
                            }): import("../..").ListenOff;
                            close(): void;
                            count(): number;
                            keys(): import("../..").ListenKey[];
                            isRunning(): boolean;
                            run(): void;
                            onClose(cb: () => void): import("../..").ListenOff;
                        };
                        since: (seq: number, snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7[] | null;
                        keyframe: (snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7 | null;
                        frame: (seq: number, hint?: unknown, snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7[];
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
                        line: {
                            on(cb: (wire: import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7) => void, opts?: {
                                knowledge?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge;
                            }): import("../..").ListenOff;
                            emit: import("../..").Listener<Buffer<ArrayBufferLike>[]>;
                            has(key: import("../..").ListenKey): boolean;
                            off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<Buffer<ArrayBufferLike>[]> | null): void;
                            once(cb: import("../..").Listener<Buffer<ArrayBufferLike>[]>, opts?: {
                                key?: import("../..").ListenKey;
                            }): import("../..").ListenOff;
                            close(): void;
                            count(): number;
                            keys(): import("../..").ListenKey[];
                            isRunning(): boolean;
                            run(): void;
                            onClose(cb: () => void): import("../..").ListenOff;
                        };
                        since: (seq: number, snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7[] | null;
                        keyframe: (snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7 | null;
                        frame: (seq: number, hint?: unknown, snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-msgpack").tStoreReplayWireBatchV7[];
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
        close: () => void;
    };
    close(): void;
};
export type ArtifactMirror = ReturnType<typeof createArtifactMirror>;
