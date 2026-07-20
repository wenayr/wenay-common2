import { StoreDrain, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { ReplayEvent } from '../events/replay-listen';
import { ReplayStorage } from '../events/replay-history';
export type StorePlaybackOpts = {
    speed?: number;
    maxStepMs?: number;
    drain?: StoreDrain;
    expose?: Pick<StoreReplayOpts, 'describe' | 'history' | 'now'>;
};
export declare function playbackStoreReplay<T extends object>(storage: ReplayStorage<[StorePatch]>, opts?: StorePlaybackOpts): {
    store: import("./store").Store<T>;
    api: {
        replay: import("../events/replay-wire").ReplayExpose<[StorePatch]> | {
            describe: () => {
                [x: string]: any;
            };
            line: import("../..").ListenApi<[ReplayEvent<[StorePatch]>]>;
            since: (seq: number) => ReplayEvent<[StorePatch]>[] | null;
            keyframe: () => ReplayEvent<[StorePatch]> | null;
            frame: (sinceSeq: number, hint?: unknown) => ReplayEvent<[StorePatch]>[];
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
