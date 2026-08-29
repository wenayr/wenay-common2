import { type NodeDirectoryEntry, type NodeDirectoryView } from '../Observe/node-directory';
import type { ReplicatedMapRemote } from '../Observe/replicated-map';
import { type StoreReplicaLeadership, type StoreReplicaSession } from '../Observe/store-replica-set';
export type ScaleClusterClientDeps<T extends Record<string, any>> = {
    storeId: string;
    originId: string;
    nodeId: string;
    lineId?: string;
    initial: T;
    directory: ReplicatedMapRemote<NodeDirectoryEntry>;
    connect: (view: NodeDirectoryView) => StoreReplicaSession | Promise<StoreReplicaSession>;
    placement?: {
        label?: string;
        staleMs?: number;
        priorityOf?: (view: NodeDirectoryView) => number;
        rng?: () => number;
        balance?: {
            aboveShare?: number;
            belowShare?: number;
            checkMs?: number;
            moveChance?: number;
            cooldownMs?: number;
        };
    };
    leadership?: StoreReplicaLeadership;
    log?: (line: string) => void;
};
export declare function createClusterClient<T extends Record<string, any>>(deps: ScaleClusterClientDeps<T>): {
    store: import("../Observe").Store<T>;
    status: import("../Observe").Store<import("../Observe").StoreReplicaSetStatus>;
    ready: Promise<void>;
    placement: {
        placedNodeId: () => string | null;
        repick: () => string | null;
    };
    view: {
        nodes: () => NodeDirectoryView[];
        route: () => string | null;
    };
    close: () => void;
};
export type ScaleClusterClient<T extends Record<string, any> = Record<string, any>> = ReturnType<typeof createClusterClient<T>>;
