import { SignalEnvelope, SignalPort } from '../events/route-signal-webrtc';
export type tCallState = 'ringing' | 'active' | 'ended';
export type tCallEnd = 'declined' | 'busy' | 'offline' | 'timeout' | 'hangup' | 'canceled' | 'closed';
export type CallManagerDeps = {
    port: SignalPort;
    self: string;
    ringTimeoutMs?: number;
    incoming?: (info: {
        peer: string;
        meta?: unknown;
    }) => boolean | Promise<boolean>;
};
export declare function callPortOf(remote: {
    signal: {
        send: (env: SignalEnvelope) => any;
        signals: {
            on: (cb: (env: SignalEnvelope) => void) => any;
        };
    };
}): SignalPort;
export declare function createCallManager(deps: CallManagerDeps): {
    ready: Promise<void>;
    call: (other: string, meta?: unknown) => {
        id: string;
        peer: string;
        direction: "out" | "in";
        meta: unknown;
        state: () => tCallState;
        reason: () => tCallEnd | null;
        changed: import("../events/Listen").ListenApi<[tCallState]>;
        ended: Promise<tCallEnd>;
        accept(): void;
        decline(why?: tCallEnd): void;
        hangup(): void;
    };
    rings: import("../events/Listen").ListenApi<[{
        id: string;
        peer: string;
        direction: "out" | "in";
        meta: unknown;
        state: () => tCallState;
        reason: () => tCallEnd | null;
        changed: import("../events/Listen").ListenApi<[tCallState]>;
        ended: Promise<tCallEnd>;
        accept(): void;
        decline(why?: tCallEnd): void;
        hangup(): void;
    }]>;
    active: () => {
        id: string;
        peer: string;
        direction: "out" | "in";
        meta: unknown;
        state: () => tCallState;
        reason: () => tCallEnd | null;
        changed: import("../events/Listen").ListenApi<[tCallState]>;
        ended: Promise<tCallEnd>;
        accept(): void;
        decline(why?: tCallEnd): void;
        hangup(): void;
    } | null;
    close(): void;
};
export type CallManager = ReturnType<typeof createCallManager>;
export type CallHandle = ReturnType<CallManager['call']>;
