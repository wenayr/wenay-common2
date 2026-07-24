import { StoreReplayOpts, StoreReplayRemote, tStoreReplayMode } from './store-replay';
export type tFollowerUpstream = 'catching-up' | 'live' | 'offline' | 'promoted' | 'closed';
export type FollowerStatus = {
    upstream: tFollowerUpstream;
    seq: number;
    replayMode?: tStoreReplayMode;
    epoch: number;
    error: string | null;
};
export type StoreFollowerDeps<T extends object> = {
    remote: StoreReplayRemote;
    initial?: T;
    expose?: StoreReplayOpts;
    staleMs?: number;
    batch?: boolean;
    epoch?: number;
};
export declare function createStoreFollower<T extends object>(deps: StoreFollowerDeps<T>): {
    store: import("./store").Store<T>;
    status: import("./store").Store<FollowerStatus>;
    isStale: () => boolean;
    api: {
        replay: (import("../events/replay-wire").ReplayExpose<[import("./store").StorePatch]> & {
            batch?: ReturnType<(replay: {
                emit: import("../..").Listener<[readonly import("./store").StorePatch[]]>;
                emitBatch: (events: readonly [readonly import("./store").StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | undefined;
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>]>;
                hasKeyframe: boolean;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | undefined;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[];
                on: import("../events/replay-listen").ListenOnReplay<[readonly import("./store").StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly import("./store").StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly import("./store").StorePatch[]]> | undefined;
                }) => () => void;
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly import("./store").StorePatch[]]> | null): void;
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
                        on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>) => void) => any;
                    };
                    since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | null | undefined> | null | undefined;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>) => void) => any;
                    } | undefined;
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
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>]>;
            since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[] | null;
            keyframe: () => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]> | null;
            frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[];
            batch?: ReturnType<(replay: {
                emit: import("../..").Listener<[readonly import("./store").StorePatch[]]>;
                emitBatch: (events: readonly [readonly import("./store").StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | undefined;
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>]>;
                hasKeyframe: boolean;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | undefined;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[];
                on: import("../events/replay-listen").ListenOnReplay<[readonly import("./store").StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly import("./store").StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly import("./store").StorePatch[]]> | undefined;
                }) => () => void;
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[readonly import("./store").StorePatch[]]> | null): void;
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
                        on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>) => void) => any;
                    };
                    since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | null | undefined> | null | undefined;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]> | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("./store").StorePatch[]]>) => void) => any;
                    } | undefined;
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
        emit: import("../..").Listener<[import("./store").StorePatch]>;
        emitBatch: (events: readonly [import("./store").StorePatch][]) => void;
        head: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        close: () => void;
        getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[] | undefined;
        line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>]>;
        hasKeyframe: boolean;
        keyframe: () => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]> | undefined;
        frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[];
        on: import("../events/replay-listen").ListenOnReplay<[import("./store").StorePatch]>;
        once: (cb: import("../..").Listener<[import("./store").StorePatch]>, opts?: {
            key?: string | symbol;
            current?: import("../..").ListenCurrent<[import("./store").StorePatch]> | undefined;
        }) => () => void;
        has(key: import("../..").ListenKey): boolean;
        off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[import("./store").StorePatch]> | null): void;
        count(): number;
        keys(): import("../..").ListenKey[];
        isRunning(): boolean;
        run(): void;
        onClose(cb: () => void): import("../..").ListenOff;
    };
    ready: Promise<void>;
    promote: () => {
        store: import("./store").Store<T>;
        replay: {
            emit: import("../..").Listener<[import("./store").StorePatch]>;
            emitBatch: (events: readonly [import("./store").StorePatch][]) => void;
            head: () => number;
            isStale: () => boolean;
            lastTs: () => number;
            close: () => void;
            getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[] | undefined;
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>]>;
            hasKeyframe: boolean;
            keyframe: () => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]> | undefined;
            frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("./store").StorePatch]>[];
            on: import("../events/replay-listen").ListenOnReplay<[import("./store").StorePatch]>;
            once: (cb: import("../..").Listener<[import("./store").StorePatch]>, opts?: {
                key?: string | symbol;
                current?: import("../..").ListenCurrent<[import("./store").StorePatch]> | undefined;
            }) => () => void;
            has(key: import("../..").ListenKey): boolean;
            off(keyOrCallback: import("../..").ListenKey | import("../..").Listener<[import("./store").StorePatch]> | null): void;
            count(): number;
            keys(): import("../..").ListenKey[];
            isRunning(): boolean;
            run(): void;
            onClose(cb: () => void): import("../..").ListenOff;
        };
        epoch: number;
    };
    close(): void;
};
export type StoreFollower<T extends object> = ReturnType<typeof createStoreFollower<T>>;
export type KeyedConflict<T> = {
    key: string;
    local: T;
    authority: T;
};
export declare function diffKeyedState<T extends object>(local: Record<string, T>, authority: Record<string, T>): {
    localOnly: T[];
    authorityOnly: T[];
    conflicts: KeyedConflict<T>[];
};
