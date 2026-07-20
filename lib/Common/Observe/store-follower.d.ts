import { StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayRemote } from '../events/replay-wire';
export type tFollowerUpstream = 'catching-up' | 'live' | 'offline' | 'promoted' | 'closed';
export type FollowerStatus = {
    upstream: tFollowerUpstream;
    seq: number;
    epoch: number;
    error: string | null;
};
export type StoreFollowerDeps<T extends object> = {
    remote: ReplayRemote<[StorePatch]>;
    initial?: T;
    expose?: StoreReplayOpts;
    staleMs?: number;
    epoch?: number;
};
export declare function createStoreFollower<T extends object>(deps: StoreFollowerDeps<T>): {
    store: import("./store").Store<T>;
    status: import("./store").Store<FollowerStatus>;
    isStale: () => boolean;
    api: {
        replay: import("../events/replay-wire").ReplayExpose<[StorePatch]> | {
            describe: () => {
                [x: string]: any;
            };
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[StorePatch]>]>;
            since: (seq: number) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[] | null;
            keyframe: () => import("../events/replay-listen").ReplayEvent<[StorePatch]> | null;
            frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[];
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
        head: () => number;
        isStale: () => boolean;
        lastTs: () => number;
        close: () => void;
        getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[] | undefined;
        line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[StorePatch]>]>;
        hasKeyframe: boolean;
        keyframe: () => import("../events/replay-listen").ReplayEvent<[StorePatch]> | undefined;
        frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[];
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
    ready: Promise<void>;
    promote: () => {
        store: import("./store").Store<T>;
        replay: {
            emit: import("../..").Listener<[StorePatch]>;
            head: () => number;
            isStale: () => boolean;
            lastTs: () => number;
            close: () => void;
            getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[] | undefined;
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[StorePatch]>]>;
            hasKeyframe: boolean;
            keyframe: () => import("../events/replay-listen").ReplayEvent<[StorePatch]> | undefined;
            frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[];
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
