import { type ReplicatedMapRemote, type ReplicatedMapState } from '../Observe/replicated-map';
export type tLineSuccessionRole = 'owner' | 'follower' | 'idle';
export type LineSuccessionOwner<V> = {
    control: {
        snapshot(): ReplicatedMapState<V>;
        close(): void;
    };
};
export type LineSuccessionDeps<V, O extends LineSuccessionOwner<V>> = {
    produce: (initial: V[]) => O;
    own?: boolean;
    label?: string;
    log?: (line: string) => void;
    onError?: (error: unknown) => void;
};
export declare function createLineSuccession<V, O extends LineSuccessionOwner<V>>(deps: LineSuccessionDeps<V, O>): {
    role: () => tLineSuccessionRole;
    snapshot: () => ReplicatedMapState<V>;
    rows: () => V[];
    follow: (remote: ReplicatedMapRemote<V>) => Promise<void>;
    promote: () => O;
    demote: () => void;
    requireOwner: (verb?: string) => O;
    owner: () => O | null;
    close: () => void;
};
export type LineSuccession<V, O extends LineSuccessionOwner<V>> = ReturnType<typeof createLineSuccession<V, O>>;
