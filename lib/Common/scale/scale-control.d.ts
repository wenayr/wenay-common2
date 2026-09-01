import { type Store } from '../Observe/store';
import { type StoreReplayRemote } from '../Observe/store-replay';
import type { NodeDirectoryState } from '../Observe/node-directory';
import type { CommandReceiptsState } from '../command/command-receipts';
import type { StoreNodeRevocation } from '../Observe/store-node';
export type ScaleControlState = NodeDirectoryState & CommandReceiptsState & {
    revoked: Record<string, StoreNodeRevocation>;
};
export declare function emptyControlState(): ScaleControlState;
export type tControlLineRole = 'owner' | 'follower' | 'idle';
export type ControlLineDeps<S extends object> = {
    initial: S;
    own?: boolean;
    describe?: Record<string, any>;
    label?: string;
    log?: (line: string) => void;
};
export declare function createControlLine<S extends object>(deps: ControlLineDeps<S>): {
    role: () => tControlLineRole;
    store: () => Store<S>;
    api: (verb?: string) => StoreReplayRemote;
    owner: () => boolean;
    follow: (remote: StoreReplayRemote) => Promise<void>;
    promote: () => Store<S>;
    demote: () => void;
    followStatus: () => Store<import("../Observe").FollowerStatus> | null;
    close: () => void;
};
export type ControlLine<S extends object> = ReturnType<typeof createControlLine<S>>;
export declare function projectStoreSection<S extends object, K extends keyof S & string>(source: Store<S>, key: K, describe?: Record<string, any>): {
    api: StoreReplayRemote;
    store: Store<Pick<S, K>>;
    close(): void;
};
