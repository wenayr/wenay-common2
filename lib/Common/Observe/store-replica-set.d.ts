import { Store, StorePatch } from './store';
import { StoreReplayOpts, StoreReplayRemote } from './store-replay';
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
    replay: StoreReplayRemote;
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
        changes: import("../..").ListenApi<[readonly StoreReplicaOffer[]]>;
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
        changed: import("../..").ListenApi<[StoreReplicaDescriptor]>;
        conflicts: import("../..").ListenApi<[StoreReplicaConflict<T>]>;
        routes: import("../..").ListenApi<[StoreReplicaRouteEvent]>;
        replay: {
            has(key: import("../..").ListenKey): boolean;
            off(keyOrCallback: import("../..").Listener<[readonly StorePatch[]]> | import("../..").ListenKey | null): void;
            count(): number;
            keys(): import("../..").ListenKey[];
            isRunning(): boolean;
            run(): void;
            onClose(cb: () => void): import("../..").ListenOff;
            emit: import("../..").Listener<[readonly StorePatch[]]>;
            emitBatch: (events: readonly [readonly StorePatch[]][]) => void;
            head: () => number;
            isStale: () => boolean;
            lastTs: () => number;
            close: () => void;
            line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>]>;
            hasKeyframe: boolean;
            on: import("../events/replay-listen").ListenOnReplay<[readonly StorePatch[]]>;
            once: (cb: import("../..").Listener<[readonly StorePatch[]]>, opts?: {
                key?: string | symbol;
                current?: import("../..").ListenCurrent<[readonly StorePatch[]]> | undefined;
            }) => () => void;
            getSince(seq: number): import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>[] | undefined;
            keyframe(): import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]> | undefined;
            frame(seq: number, hint?: unknown): import("../events/replay-listen").ReplayEvent<[readonly StorePatch[]]>[];
        };
        fragment: {
            descriptor: () => StoreReplicaDescriptor;
            changed: import("../..").ListenApi<[StoreReplicaDescriptor]>;
            replay: {
                line: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                };
                since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                } | undefined;
            } | {
                line: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                };
                since: (seq: number) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                keyframe: () => Promise<import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("./store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("./store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("./store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("./store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                } | undefined;
                describe: () => Record<string, any>;
            };
            ping: () => number;
        };
        canWrite: () => boolean;
    };
    close: () => void;
};
export type StoreReplicaSet<T extends object> = ReturnType<typeof createStoreReplicaSet<T>>;
