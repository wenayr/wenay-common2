import { StoreDrain, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayEvent } from '../events/replay-listen';
import { ReplayStorage } from '../events/replay-history';
export type StorePlaybackOpts = {
    speed?: number;
    maxStepMs?: number;
    drain?: StoreDrain;
    expose?: Pick<StoreReplayOpts, 'describe' | 'history' | 'now' | 'batch'>;
};
export declare function playbackStoreReplay<T extends object>(storage: ReplayStorage<[StorePatch]>, opts?: StorePlaybackOpts): {
    store: import("./store").Store<T>;
    api: {
        replay: (import("../events/replay-wire").ReplayExpose<[StorePatch]> & {
            batch?: ReturnType<(replay: {
                emit: import("../..").Listener<[readonly StorePatch[]]>;
                emitBatch: (events: readonly [readonly StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                getSince: (seq: number) => ReplayEvent<[readonly StorePatch[]]>[] | undefined;
                line: import("../..").ListenApi<[ReplayEvent<[readonly StorePatch[]]>]>;
                hasKeyframe: boolean;
                keyframe: () => ReplayEvent<[readonly StorePatch[]]> | undefined;
                frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[readonly StorePatch[]]>[];
                on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
                }) => () => void;
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly StorePatch[]]> | null): void;
                count(): number;
                keys(): import("../..").ListenKey[];
                isRunning(): boolean;
                run(): void;
                onClose(cb: () => void): import("../..").ListenOff;
            }, prepareRead: () => void) => {
                v2: {
                    line: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                };
                v3: {
                    line: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                    } | undefined;
                };
                v4: {
                    line: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                    } | undefined;
                };
                v5: {
                    line: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                    } | undefined;
                };
                v6: {
                    line: {
                        on: (cb: (batch: ReplayEvent<[readonly StorePatch[]]>) => void) => any;
                    };
                    since: (seq: number) => ReplayEvent<[readonly StorePatch[]]>[] | Promise<ReplayEvent<[readonly StorePatch[]]>[] | null | undefined> | null | undefined;
                    keyframe: () => ReplayEvent<[readonly StorePatch[]]> | Promise<ReplayEvent<[readonly StorePatch[]]> | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => ReplayEvent<[readonly StorePatch[]]>[] | Promise<ReplayEvent<[readonly StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: ReplayEvent<[readonly StorePatch[]]>) => void) => any;
                    } | undefined;
                };
                v7: {
                    line: {
                        on(cb: (wire: import("./store-replay-msgpack").tStoreReplayWireBatchV7) => void, opts?: {
                            knowledge?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge;
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
                    since: (seq: number, snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7[] | null;
                    keyframe: (snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7 | null;
                    frame: (seq: number, hint?: unknown, snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7[];
                };
                line: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatch) => void) => any;
                };
                since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatch[] | Promise<import("./store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                keyframe: () => import("./store-replay-codec").tStoreReplayWireBatch | Promise<import("./store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatch[] | Promise<import("./store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatch) => void) => any;
                } | undefined;
            }>;
        }) | {
            describe: () => Record<string, any>;
            line: import("../..").ListenApi<[ReplayEvent<[StorePatch]>]>;
            since: (seq: number) => ReplayEvent<[StorePatch]>[] | null;
            keyframe: () => ReplayEvent<[StorePatch]> | null;
            frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[StorePatch]>[];
            batch?: ReturnType<(replay: {
                emit: import("../..").Listener<[readonly StorePatch[]]>;
                emitBatch: (events: readonly [readonly StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                getSince: (seq: number) => ReplayEvent<[readonly StorePatch[]]>[] | undefined;
                line: import("../..").ListenApi<[ReplayEvent<[readonly StorePatch[]]>]>;
                hasKeyframe: boolean;
                keyframe: () => ReplayEvent<[readonly StorePatch[]]> | undefined;
                frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[readonly StorePatch[]]>[];
                on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
                }) => () => void;
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly StorePatch[]]> | null): void;
                count(): number;
                keys(): import("../..").ListenKey[];
                isRunning(): boolean;
                run(): void;
                onClose(cb: () => void): import("../..").ListenOff;
            }, prepareRead: () => void) => {
                v2: {
                    line: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                };
                v3: {
                    line: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                    } | undefined;
                };
                v4: {
                    line: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                    } | undefined;
                };
                v5: {
                    line: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                    };
                    since: (seq: number) => import("./store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                    keyframe: () => import("./store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("./store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("./store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("./store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                    } | undefined;
                };
                v6: {
                    line: {
                        on: (cb: (batch: ReplayEvent<[readonly StorePatch[]]>) => void) => any;
                    };
                    since: (seq: number) => ReplayEvent<[readonly StorePatch[]]>[] | Promise<ReplayEvent<[readonly StorePatch[]]>[] | null | undefined> | null | undefined;
                    keyframe: () => ReplayEvent<[readonly StorePatch[]]> | Promise<ReplayEvent<[readonly StorePatch[]]> | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => ReplayEvent<[readonly StorePatch[]]>[] | Promise<ReplayEvent<[readonly StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: ReplayEvent<[readonly StorePatch[]]>) => void) => any;
                    } | undefined;
                };
                v7: {
                    line: {
                        on(cb: (wire: import("./store-replay-msgpack").tStoreReplayWireBatchV7) => void, opts?: {
                            knowledge?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge;
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
                    since: (seq: number, snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7[] | null;
                    keyframe: (snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7 | null;
                    frame: (seq: number, hint?: unknown, snapshot?: import("./store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("./store-replay-msgpack").tStoreReplayWireBatchV7[];
                };
                line: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatch) => void) => any;
                };
                since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatch[] | Promise<import("./store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                keyframe: () => import("./store-replay-codec").tStoreReplayWireBatch | Promise<import("./store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatch[] | Promise<import("./store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatch) => void) => any;
                } | undefined;
            }>;
        };
        get(): T;
        get<M extends import("./store").StoreMask<T>>(mask: M): import("./store").StorePick<T, M>;
        set(path: import("./store").StorePath, value: any): void;
        replace(path: import("./store").StorePath, value: any): void;
        changed: any;
        changedPaths: any;
    };
    replay: {
        emit: import("../..").Listener<[StorePatch]>;
        emitBatch: (events: readonly [StorePatch][]) => void;
        head: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        close: () => void;
        getSince: (seq: number) => ReplayEvent<[StorePatch]>[] | undefined;
        line: import("../..").ListenApi<[ReplayEvent<[StorePatch]>]>;
        hasKeyframe: boolean;
        keyframe: () => ReplayEvent<[StorePatch]> | undefined;
        frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[StorePatch]>[];
        on: import("../events/replay-listen").ListenOnReplay<[StorePatch]>;
        once: (cb: import("../..").Listener<[StorePatch]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[StorePatch]> | undefined;
        }) => () => void;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[StorePatch]> | null): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
    };
    range: {
        from: number;
        to: number;
    };
    done: Promise<void>;
    close(): void;
};
export type StorePlayback<T extends object> = ReturnType<typeof playbackStoreReplay<T>>;
