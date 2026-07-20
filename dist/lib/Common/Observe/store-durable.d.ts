import { StoreDrain, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayStorage } from '../events/replay-history';
export type DurableStoreReplayDeps<T extends object> = {
    storage: ReplayStorage<[StorePatch]>;
    initial?: T;
    everyEvents?: number;
    everyMs?: number;
    drain?: StoreDrain;
    expose?: Pick<StoreReplayOpts, 'describe' | 'onJournal' | 'now'>;
};
export declare function createDurableStoreReplay<T extends object>(deps: DurableStoreReplayDeps<T>): {
    store: import("./store").Store<T>;
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
    restored: {
        seq: number;
        fromArchive: boolean;
    };
    stats: () => {
        events: number;
        keyframes: number;
    };
    close(): void;
};
export type DurableStoreReplay<T extends object> = ReturnType<typeof createDurableStoreReplay<T>>;
