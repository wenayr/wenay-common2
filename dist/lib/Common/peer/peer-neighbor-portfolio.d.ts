import { PeerPacketOffer } from './peer-packet-mesh';
export type PeerNeighborQuality = {
    rttMs?: number;
    loss?: number;
};
export type PeerNeighborCandidate<T> = {
    offer: PeerPacketOffer<T>;
    quality?: PeerNeighborQuality;
    degree?: number;
    minDegree?: number;
    diversityKeys?: readonly string[];
    reachable?: readonly string[];
    paths?: readonly (readonly string[])[];
};
export type tPeerNeighborRole = 'quality' | 'rescue' | 'diversity';
export type PeerNeighborSelection = {
    id: string;
    peerId: string;
    role: tPeerNeighborRole;
    qualityCost: number;
    degreeDeficit: number;
    diversityScore: number;
};
export type PeerNeighborPortfolioWeights = {
    diversityKey: number;
    reachability: number;
    pathDisjointness: number;
    quality: number;
};
export type PeerNeighborPortfolioDeps<T> = {
    nodeId: string;
    budget?: number;
    qualityLinks?: number;
    rescueLinks?: number;
    minDegree?: number;
    lossPenaltyMs?: number;
    unknownRttMs?: number;
    unknownLoss?: number;
    weights?: Partial<PeerNeighborPortfolioWeights>;
    qualityCost?: (candidate: PeerNeighborCandidate<T>) => number;
    initial?: readonly PeerNeighborCandidate<T>[];
};
export declare function createPeerNeighborPortfolio<T>(deps: PeerNeighborPortfolioDeps<T>): {
    control: {
        upsert: (candidate: PeerNeighborCandidate<T>) => () => void;
        remove(id: string): boolean;
        replace: (next: readonly PeerNeighborCandidate<T>[]) => void;
        sample(id: string, quality: PeerNeighborQuality): boolean;
        clear(): void;
        reconcile: () => void;
    };
    offers: {
        list: () => PeerPacketOffer<T>[];
        changes: import("../..").ListenApi<[readonly PeerPacketOffer<T>[]]>;
    };
    view: {
        selected: () => {
            id: string;
            peerId: string;
            role: tPeerNeighborRole;
            qualityCost: number;
            degreeDeficit: number;
            diversityScore: number;
        }[];
        candidates: () => {
            degree: number | undefined;
            minDegree: number | undefined;
            offer: {
                connect: () => import("./peer-packet-mesh").PeerPacketSession<T> | Promise<import("./peer-packet-mesh").PeerPacketSession<T>>;
                priority?: number;
                id: string;
                peerId: string;
            };
            quality: {
                rttMs: number | undefined;
                loss: number | undefined;
            };
            diversityKeys: string[];
            reachable: string[];
            paths: string[][];
        }[];
    };
    events: {
        changes: import("../..").ListenApi<[readonly PeerNeighborSelection[]]>;
    };
    close(): void;
};
export type PeerNeighborPortfolio<T> = ReturnType<typeof createPeerNeighborPortfolio<T>>;
