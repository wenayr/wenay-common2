import { ReplayRemote } from './replay-wire';
import { RouteConnector } from './route-coordinator';
import { ReplayMessageChannel } from './replay-channel';
export type tSignalType = 'offer' | 'answer' | 'ice' | 'revoke' | 'close' | 'ring' | 'accept' | 'decline' | 'hangup';
export type SignalEnvelope = {
    type: tSignalType;
    pair: string;
    from: string;
    to: string;
    sdp?: string;
    candidate?: unknown;
    session?: unknown;
    reason?: string;
};
export type SignalPort = {
    send: (env: SignalEnvelope) => Promise<boolean | void> | boolean | void;
    signals: {
        on: (cb: (env: SignalEnvelope) => void) => any;
    };
};
export declare function createSignalHub(deps?: {
    authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>;
}): {
    register: (account: string) => {
        account: string;
        send: (env: SignalEnvelope) => Promise<boolean>;
        signals: import("./Listen").ListenApi<[SignalEnvelope]>;
        close: () => void;
    };
    revoke: (pair: string, accounts: string[], reason?: string) => void;
    accounts: () => string[];
    close(): void;
};
export type SignalHub = ReturnType<typeof createSignalHub>;
export type RtcSessionDescription = {
    type: string;
    sdp?: string;
};
export type RtcDataChannel = {
    send: (data: string) => void;
    close: () => void;
    onopen?: ((ev?: unknown) => void) | null;
    onmessage?: ((ev: {
        data: unknown;
    }) => void) | null;
    onclose?: ((ev?: unknown) => void) | null;
    onerror?: ((ev?: unknown) => void) | null;
};
export type RtcPeerConnection = {
    createDataChannel: (label: string, opts?: unknown) => RtcDataChannel;
    createOffer: () => Promise<RtcSessionDescription>;
    createAnswer: () => Promise<RtcSessionDescription>;
    setLocalDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown;
    setRemoteDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown;
    addIceCandidate: (c: unknown) => Promise<unknown> | unknown;
    close: () => void;
    onicecandidate?: ((ev: {
        candidate?: unknown;
    }) => void) | null;
    ondatachannel?: ((ev: {
        channel: RtcDataChannel;
    }) => void) | null;
};
export declare function channelFromDataChannel(dc: RtcDataChannel): ReplayMessageChannel;
export type WebRtcConnectorDeps = {
    port: SignalPort;
    rtc: () => RtcPeerConnection;
    self: string;
    peer: string;
    pair: string;
    session?: unknown;
    label?: string;
    openTimeoutMs?: number;
};
export declare function createWebRtcConnector<Z extends any[] = any[]>(deps: WebRtcConnectorDeps): RouteConnector<Z>;
export type WebRtcAcceptDeps<Z extends any[]> = {
    port: SignalPort;
    rtc: () => RtcPeerConnection;
    self: string;
    serve: (env: SignalEnvelope) => ReplayRemote<Z> | null | Promise<ReplayRemote<Z> | null>;
    accept?: (env: SignalEnvelope) => boolean | Promise<boolean>;
};
export declare function acceptWebRtcDirect<Z extends any[] = any[]>(deps: WebRtcAcceptDeps<Z>): () => void;
