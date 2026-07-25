import { StorePatch } from '../Observe/store';
import { ReplayRemote } from '../events/replay-wire';
import { SignalEnvelope } from '../events/route-signal-webrtc';
import { PatchEnvelope, tRelayGap } from './peer-relay';
export type PresenceChange = {
    account: string;
    online: boolean;
};
export type PeerHostDeps = {
    authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>;
    history?: number;
    gap?: tRelayGap;
    accounts?: (account: string) => boolean;
};
export declare function createPeerHost(deps?: PeerHostDeps): {
    connection: (account: string) => {
        fragment: {
            signal: {
                send: (env: SignalEnvelope) => Promise<boolean>;
                signals: import("../..").ListenApi<[SignalEnvelope]>;
            };
            publish: (envelope: PatchEnvelope) => import("./peer-relay").RelayPushResult;
            publishBatch: (envelopes: PatchEnvelope[]) => import("./peer-relay").RelayPushResult;
            peers: Record<string, ReplayRemote<[StorePatch]>>;
            presence: {
                list: () => string[];
                changes: import("../..").ListenApi<[PresenceChange]>;
            };
        };
        close: () => void;
    };
    relay: (account: string) => {
        push: (env: PatchEnvelope) => import("./peer-relay").RelayPushResult;
        pushBatch: (envelopes: PatchEnvelope[]) => import("./peer-relay").RelayPushResult;
        remote: ReplayRemote<[StorePatch]> & {
            seq: () => number;
        };
        gap: tRelayGap;
        seq: () => number;
        snapshot: () => any;
        close: () => void;
    };
    accounts: () => string[];
    presence: {
        list: () => string[];
        changes: import("../..").ListenApi<[PresenceChange]>;
    };
    revoke: (pair: string, accounts: string[], reason?: string) => void;
    close(): void;
};
export type PeerHost = ReturnType<typeof createPeerHost>;
