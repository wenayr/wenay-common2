export type tPeerPacketRouteState = 'connecting' | 'open' | 'failed' | 'closed';
export type PeerPacketRouteAdvertisement = {
    targetId: string;
    cost: number;
    path: string[];
};
export type PeerPacketEnvelope<T> = {
    protocol: 1;
    kind: 'packet';
    meshId: string;
    packetId: string;
    originId: string;
    targetId: string;
    sequence: number;
    ttl: number;
    path: string[];
    payload: T;
};
export type PeerPacketRouteMessage = {
    protocol: 1;
    kind: 'routes';
    meshId: string;
    from: string;
    version: number;
    routes: PeerPacketRouteAdvertisement[];
};
export type PeerPacketWire<T> = PeerPacketEnvelope<T> | PeerPacketRouteMessage;
export type PeerPacketSession<T> = {
    peerId: string;
    send: (message: PeerPacketWire<T>) => boolean | void | Promise<boolean | void>;
    messages: {
        on: (cb: (message: PeerPacketWire<T>) => void) => any;
    };
    ping?: () => unknown | Promise<unknown>;
    close: () => void;
    onFail?: {
        on: (cb: (reason?: unknown) => void) => any;
    };
};
export type PeerPacketOffer<T> = {
    id: string;
    peerId: string;
    connect: () => PeerPacketSession<T> | Promise<PeerPacketSession<T>>;
    priority?: number;
};
export type PeerPacketOfferSource<T> = {
    list: () => readonly PeerPacketOffer<T>[];
    changes: {
        on: (cb: (offers: readonly PeerPacketOffer<T>[]) => void) => any;
    };
};
export type PeerPacketRoute = {
    targetId: string;
    nextHopId: string;
    offerId: string;
    cost: number;
    path: string[];
};
export type PeerPacketMeta = {
    packetId: string;
    originId: string;
    targetId: string;
    sequence: number;
    path: string[];
    hops: number;
};
export type PeerPacketSendResult = {
    ok: boolean;
    packetId: string;
    targetId: string;
    nextHopId?: string;
    path?: string[];
    reason?: 'no-route' | 'ttl' | 'rejected';
};
export type PeerPacketMeshStats = {
    sent: number;
    forwarded: number;
    delivered: number;
    duplicates: number;
    invalid: number;
    rejected: number;
    noRoute: number;
};
export type PeerPacketRouteStatus = {
    id: string;
    peerId: string;
    state: tPeerPacketRouteState;
    rtt: number | null;
    cost: number | null;
    error: string | null;
};
export type PeerPacketMeshDeps<T> = {
    meshId: string;
    nodeId: string;
    offers: PeerPacketOfferSource<T>;
    instanceId?: string;
    maxHops?: number;
    seenLimit?: number;
    reconnectMs?: number;
    probeIntervalMs?: number;
    pingTimeoutMs?: number;
    now?: () => number;
    accept?: (packet: PeerPacketEnvelope<T>, from: string) => boolean | Promise<boolean>;
};
export declare function createPeerPacketOffers<T>(initial?: readonly PeerPacketOffer<T>[]): {
    control: {
        upsert: (offer: PeerPacketOffer<T>) => () => void;
        remove(id: string): boolean;
        replace: (next: readonly PeerPacketOffer<T>[]) => void;
        clear(): void;
    };
    api: {
        list: () => PeerPacketOffer<T>[];
        changes: import("../events/Listen").ListenApi<[readonly PeerPacketOffer<T>[]]>;
    };
};
export type PeerPacketOffers<T> = ReturnType<typeof createPeerPacketOffers<T>>;
export declare function createPeerPacketMesh<T>(deps: PeerPacketMeshDeps<T>): {
    nodeId: string;
    meshId: string;
    send: (target: string, payload: T, opts?: {
        packetId?: string;
        ttl?: number;
    }) => Promise<PeerPacketSendResult>;
    broadcast: (targets: readonly string[], payload: T, opts?: {
        ttl?: number;
    }) => Promise<PeerPacketSendResult[]>;
    packets: import("../events/Listen").ListenApi<[T, PeerPacketMeta]>;
    routes: () => {
        path: string[];
        targetId: string;
        nextHopId: string;
        offerId: string;
        cost: number;
    }[];
    routeChanges: import("../events/Listen").ListenApi<[readonly PeerPacketRoute[]]>;
    status: () => PeerPacketRouteStatus[];
    statusChanges: import("../events/Listen").ListenApi<[readonly PeerPacketRouteStatus[]]>;
    stats: () => {
        sent: number;
        forwarded: number;
        delivered: number;
        duplicates: number;
        invalid: number;
        rejected: number;
        noRoute: number;
    };
    probe(): Promise<void>;
    close(): void;
};
export type PeerPacketMesh<T> = ReturnType<typeof createPeerPacketMesh<T>>;
