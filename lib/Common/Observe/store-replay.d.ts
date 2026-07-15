import { Store, StorePatch, StoreDrain, StoreEachCtx } from './store';
import { ReplayListenOptions, ReplayEvent } from '../events/replay-listen';
import { ReplayRemote, ReplaySubscribeOpts } from '../events/replay-wire';
import { ReplayRouteSubscribeOpts } from '../events/replay-route';
import { ReplayStorage } from '../events/replay-history';
export type StoreReplayOpts = Pick<ReplayListenOptions<[StorePatch]>, 'history' | 'getSince' | 'onJournal' | 'now'>;
export declare function storePatchKey(patch: StorePatch): string | null;
export declare function exposeStoreReplay<T extends object>(store: Store<T>, opts?: StoreReplayOpts): {
    api: {
        replay: import("../events/replay-wire").ReplayExpose<[StorePatch]>;
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
    close: () => void;
};
export declare function syncStoreReplay<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts?: ReplaySubscribeOpts): (() => void) & {
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
};
export declare function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts?: ReplayRouteSubscribeOpts): (() => void) & {
    ready: Promise<void>;
    switch: (nextRemote: ReplayRemote<[StorePatch]>, nextOpts?: import("../events/replay-route").ReplayRouteSwitchOpts) => Promise<void>;
    seq: () => number;
    label: () => string | undefined;
    active: () => boolean;
};
export declare function syncStoreReplayEach<T extends object>(remote: ReplayRemote<[StorePatch]>, cb: (key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx) => void, opts?: ReplaySubscribeOpts & {
    drain?: StoreDrain;
    initial?: T;
}): (() => void) & {
    store: Store<T>;
    ready: Promise<void>;
    seq: () => number;
    isStale: () => boolean;
    lastTs: () => number;
};
export declare function storeReplayAt<T extends object>(storage: ReplayStorage<[StorePatch]>, at?: {
    seq?: number;
    ts?: number;
}): T | undefined;
