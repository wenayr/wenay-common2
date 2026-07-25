import { Store, StoreDrain, StorePatch } from '../Observe/store';
import { ReplayRemote } from '../events/replay-wire';
import { RoutePolicy } from '../events/route-coordinator';
import { RtcPeerConnection, SignalEnvelope } from '../events/route-signal-webrtc';
import { PatchEnvelope, RelayPushResult, tRelayGap } from './peer-relay';
export type PeerRemote = {
    signal: {
        send: (env: SignalEnvelope) => Promise<boolean | void>;
        signals: {
            on: (cb: (env: SignalEnvelope) => void) => any;
        };
    };
    publish: (env: PatchEnvelope) => Promise<RelayPushResult | void> | RelayPushResult | void;
    publishBatch?: (envelopes: PatchEnvelope[]) => Promise<RelayPushResult | void> | RelayPushResult | void;
    peers: Record<string, ReplayRemote<[StorePatch]> & {
        seq?: () => number | Promise<number>;
    }>;
    presence?: {
        list: () => Promise<string[]> | string[];
        changes: {
            on: (cb: (change: {
                account: string;
                online: boolean;
            }) => void) => any;
        };
    };
};
export type tPublishRepair<J extends tRelayGap = 'resume'> = J extends 'sacred' ? 'tail' : 'tail' | 'keyframe';
export type PeerClientDeps<T extends object, J extends tRelayGap = 'resume'> = {
    remote: PeerRemote;
    account: string;
    initial: T;
    rtc?: () => RtcPeerConnection;
    session?: unknown;
    accept?: (env: SignalEnvelope) => boolean | Promise<boolean>;
    policy?: RoutePolicy;
    peerInitial?: () => T;
    journal?: J;
    repair?: tPublishRepair<J>;
    onPublishError?: (e: unknown) => void;
    history?: number;
    drain?: StoreDrain;
};
export declare function createPeerClient<T extends object, J extends tRelayGap = 'resume'>(deps: PeerClientDeps<T, J>): {
    store: Store<T>;
    peer: (other: string) => {
        account: string;
        store: Store<T>;
        ready: Promise<void>;
        seq: () => number;
        route: () => string;
        state: () => import("../events/route-coordinator").tRouteState;
        promoteDirect: (opts?: import("../events/route-coordinator").PromoteDirectOpts) => Promise<import("../events/route-coordinator").RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<import("../events/route-coordinator").RouteOpResult>;
        fallback: (reason?: unknown) => Promise<import("../events/route-coordinator").RouteOpResult>;
        block: (reason?: unknown) => Promise<import("../events/route-coordinator").RouteOpResult>;
        close(): void;
    };
    onRoute: (cb: (ev: import("../events/route-coordinator").RouteChangeEvent) => void) => import("../..").ListenOff;
    resync: () => Promise<void>;
    close(): void;
};
export type PeerClient<T extends object> = ReturnType<typeof createPeerClient<T>>;
