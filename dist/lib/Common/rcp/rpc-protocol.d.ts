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
};
export declare const RPC_STOP = "___STOP";
export declare const IS_RPC_LISTEN: unique symbol;
export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
