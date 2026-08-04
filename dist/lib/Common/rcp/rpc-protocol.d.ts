export declare const Pkt: {
    readonly CALL: 0;
    readonly RESP: 1;
    readonly CB: 2;
    readonly MAP: 3;
    readonly STRICT: 4;
    readonly CB_END: 5;
    readonly PIPE: 6;
    readonly HELLO: 7;
    readonly SHAPE: 8;
    readonly CBV: 9;
    readonly CAPS: 10;
    readonly CB_BATCH: 11;
    readonly AUTH: 12;
    readonly BATCH: 13;
    readonly CB_FLOW: 14;
    readonly CB_ACK: 15;
};
export declare const RPC_STOP = "___STOP";
export declare const IS_RPC_LISTEN: unique symbol;
export type tAuthState = "expiring" | "expired" | "revoked";
export type RpcAuthNotice = {
    state: tAuthState;
    reason?: any;
    expiresAt?: number;
};
export declare const GRANT_FACTS_KEY = "$rpc";
export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
