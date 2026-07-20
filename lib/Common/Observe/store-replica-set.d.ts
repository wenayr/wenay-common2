import { ReplayRemote } from '../events/replay-wire';
import { Store, StorePatch } from './store';
import { StoreReplayOpts } from './store-replay';
import { diffKeyedState } from './store-follower';
export type tStoreReplicaRole = 'leader' | 'follower' | 'offline' | 'electing' | 'reconciling' | 'closed';
export type tStoreReplicaRouteState = 'connecting' | 'open' | 'failed' | 'rejected' | 'closed';
export type StoreReplicaDescriptor = {
    protocol: 1;
    storeId: string;
    originId: string;
    nodeId: string;
    lineId: string;
    leaderId: string | null;
    epoch: number;
    role: 'leader' | 'follower' | 'candidate';
    authorityLineId: string | null;
    authoritySeq: number;
    authorityCost: number | null;
    path: string[];
    headSeq: number;
    proof?: unknown;
};
export type StoreReplicaRemote = {
    descriptor: () => StoreReplicaDescriptor | Promise<StoreReplicaDescriptor>;
    changed?: {
        on: (cb: (descriptor?: StoreReplicaDescriptor) => void) => any;
    };
    replay: ReplayRemote<[StorePatch]>;
    ping?: () => unknown | Promise<unknown>;
};
export type StoreReplicaSession = {
    remote: StoreReplicaRemote;
    close: () => void;
    onFail?: {
        on: (cb: (reason?: unknown) => void) => any;
    };
};
export type StoreReplicaOffer = {
    id: string;
    connect: () => StoreReplicaSession | Promise<StoreReplicaSession>;
    priority?: number;
};
export type StoreReplicaOfferSource = {
    list: () => readonly StoreReplicaOffer[];
    changes: {
        on: (cb: (offers: readonly StoreReplicaOffer[]) => void) => any;
    };
};
export type StoreReplicaRouteStatus = {
    id: string;
    state: tStoreReplicaRouteState;
    nodeId: string | null;
    leaderId: string | null;
    epoch: number | null;
    lineId: string | null;
    authoritySeq: number;
    path: string[];
    rtt: number | null;
    cost: number | null;
    error: string | null;
};
export type StoreReplicaSetStatus = {
    role: tStoreReplicaRole;
    nodeId: string;
    leaderId: string | null;
    epoch: number;
    authorityLineId: string | null;
    authoritySeq: number;
    authorityCost: number | null;
    path: string[];
    routeId: string | null;
    routeNodeId: string | null;
    rtt: number | null;
    conflicts: number;
    error: string | null;
    routes: Record<string, StoreReplicaRouteStatus>;
};
export type StoreReplicaConflict<T extends object> = {
    detectedAt: number;
    local: StoreReplicaDescriptor;
    authority: StoreReplicaDescriptor;
    localState: T;
    authorityState: T;
    diff: ReturnType<typeof diffKeyedState<any>>;
};
export type StoreReplicaRouteEvent = {
    from: string | null;
    to: string | null;
    reason: string;
    rtt: number | null;
};
export type StoreReplicaElectionContext = {
    storeId: string;
    originId: string;
    nodeId: string;
    maxEpoch: number;
    candidates: StoreReplicaDescriptor[];
};
export type StoreReplicaLeadership = {
    initialRole?: 'leader' | 'follower';
    epoch?: number;
    proof?: unknown;
    autoPromoteMs?: number;
    eligible?: boolean;
    elect?: (ctx: StoreReplicaElectionContext) => {
        epoch: number;
        proof?: unknown;
    } | null | Promise<{
        epoch: number;
        proof?: unknown;
    } | null>;
    compare?: (a: StoreReplicaDescriptor, b: StoreReplicaDescriptor) => number;
    accept?: (descriptor: StoreReplicaDescriptor) => boolean | Promise<boolean>;
};
export type StoreReplicaRoutePolicy = {
    probeIntervalMs?: number;
    reconnectMs?: number;
    pingTimeoutMs?: number;
    hysteresisMs?: number;
};
export type StoreReplicaSetDeps<T extends object> = {
    storeId: string;
    originId: string;
    nodeId: string;
    lineId?: string;
    store?: Store<T>;
    initial?: T;
    expose?: StoreReplayOpts;
    offers?: StoreReplicaOfferSource;
    leadership?: StoreReplicaLeadership;
    route?: StoreReplicaRoutePolicy;
    now?: () => number;
};
export declare function createStoreReplicaOffers(initial?: readonly StoreReplicaOffer[]): {
    control: {
        upsert: (offer: StoreReplicaOffer) => () => void;
        remove(id: string): boolean;
        replace: (next: readonly StoreReplicaOffer[]) => void;
        clear(): void;
    };
    api: {
        list: () => StoreReplicaOffer[];
        changes: import("../events/Listen").ListenApi<[readonly StoreReplicaOffer[]]>;
    };
};
export type StoreReplicaOffers = ReturnType<typeof createStoreReplicaOffers>;
export declare function createStoreReplicaSet<T extends object>(deps: StoreReplicaSetDeps<T>): {
    control: {
        store: Store<T>;
        addOffer: (offerValue: StoreReplicaOffer) => () => void;
        removeOffer: (id: string) => boolean;
        setOffers: (next: readonly StoreReplicaOffer[]) => void;
        probe: () => Promise<void>;
        reconcile: (reason?: string) => Promise<void>;
        promote: (reason?: string) => Promise<StoreReplicaDescriptor | null>;
        canWrite: () => boolean;
        close: () => void;
    };
    api: {
        store: Store<T>;
        status: Store<StoreReplicaSetStatus>;
        ready: Promise<void>;
        descriptor: () => StoreReplicaDescriptor;
        changed: import("../events/Listen").ListenApi<[StoreReplicaDescriptor]>;
        conflicts: import("../events/Listen").ListenApi<[StoreReplicaConflict<T>]>;
        routes: import("../events/Listen").ListenApi<[StoreReplicaRouteEvent]>;
        replay: {
            emit: import("../events/Listen").Listener<[StorePatch]>;
            head: () => number;
            isStale: () => boolean;
            lastTs: () => number;
            close: () => void;
            getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[] | undefined;
            line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[StorePatch]>]>;
            hasKeyframe: boolean;
            keyframe: () => import("../events/replay-listen").ReplayEvent<[StorePatch]> | undefined;
            frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[];
            on: import("../events/replay-listen").ListenOnReplay<[StorePatch]>;
            once: (cb: import("../events/Listen").Listener<[StorePatch]>, opts?: {
                key?: string | symbol;
                current?: import("../events/Listen").ListenCurrent<[StorePatch]> | undefined;
            }) => () => void;
            has(key: import("../events/Listen").ListenKey): boolean;
            off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[StorePatch]> | null): void;
            count(): number;
            keys(): import("../events/Listen").ListenKey[];
            isRunning(): boolean;
            run(): void;
            onClose(cb: () => void): import("../events/Listen").ListenOff;
        };
        fragment: {
            descriptor: () => StoreReplicaDescriptor;
            changed: import("../events/Listen").ListenApi<[StoreReplicaDescriptor]>;
            replay: import("../events/replay-wire").ReplayExpose<[StorePatch]> | {
                describe: () => {
                    [x: string]: any;
                };
                line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[StorePatch]>[];
            };
            ping: () => number;
        };
        canWrite: () => boolean;
    };
    close: () => void;
};
export type StoreReplicaSet<T extends object> = ReturnType<typeof createStoreReplicaSet<T>>;
