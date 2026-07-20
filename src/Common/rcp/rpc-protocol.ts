// HELLO — client presents token in-band: server verify → principal →
// facade, responds Pkt.MAP with authAck in 5th element. Additive: old peers don't send/await HELLO.
// SHAPE/CBV/CAPS — adaptive compression of subscription ticks (versioned): client sends CAPS
// (can do compact), server on frequent object shape sends SHAPE once, then CBV (values only).
// Additive: old client doesn't send CAPS → server sends usual CB; old server ignores CAPS.
export const Pkt = { CALL: 0, RESP: 1, CB: 2, MAP: 3, STRICT: 4, CB_END: 5, PIPE: 6, HELLO: 7, SHAPE: 8, CBV: 9, CAPS: 10 } as const;

// Stream end sentinel. Goes ON WIRE as first callback argument —
// hence string (Symbol won't travel via JSON); value must not change (wire compat).
export const RPC_STOP = "___STOP";

// Server marker 'this node is Listen wrapper' (doesn't travel on wire;
// on wire server declares ADDRESSES of such nodes in 4th element of Pkt.MAP).
export const IS_RPC_LISTEN = Symbol.for("isRpcListen");

export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
