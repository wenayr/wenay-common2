// HELLO — client presents token in-band: server verify → principal →
// facade, responds Pkt.MAP with authAck in 5th element. Additive: old peers don't send/await HELLO.
// HELLO carries a correlation id in its 3rd element (negotiated by Caps.HELLO_ID); the MAP that
// ANSWERS it echoes that id back in the 6th. Only a reply carries one, so an UNSOLICITED MAP
// (STRICT push, token downgrade) can never be mistaken for the answer to a pending reauth.
// No id in → no id out: a peer that does not correlate sees the previous wire byte-for-byte.
// SHAPE/CBV/CAPS — adaptive compression of subscription ticks (versioned): client sends CAPS
// (can do compact), server on frequent object shape sends SHAPE once, then CBV (values only).
// CB_BATCH — negotiated, ordered physical envelope for live CB/SHAPE/CBV packets.
// BATCH — a SECOND envelope, negotiated by Caps.REQ_BATCH, for CALL/PIPE going out and for
// RESP/CB_END coming back alongside the callbacks they follow. Deliberately its OWN opcode and
// not a widened CB_BATCH: today's client validates a CB_BATCH item against CB/SHAPE/CBV and
// silently drops the whole envelope on anything else, so a widened CB_BATCH would mean two
// different things depending on a bit. An unknown opcode instead falls through every existing
// switch (client `handlePacket`, server `handleServerPacket`) — the additive rule of rpc-caps.
// Items keep their own session id at index 5, so unwrapping yields exactly the packets that
// separate frames would have delivered, in the same order.
// Both envelopes are additive: an old client sends no CAPS → server sends the usual CB and never
// wraps anything; an old server ignores CAPS and neither envelope is ever negotiated.
// AUTH — server→client push of authorization state (token lifetime / revocation), negotiated
// by Caps.AUTH_STATE: a peer that doesn't advertise the bit never receives it. Deliberately a
// CONTROL packet and not a Listen node: such a node lives inside the principal's facade and
// would vanish exactly when the state has to be reported.
export const Pkt = {
    CALL: 0,
    RESP: 1,
    CB: 2,
    MAP: 3,
    STRICT: 4,
    CB_END: 5,
    PIPE: 6,
    HELLO: 7,
    SHAPE: 8,
    CBV: 9,
    CAPS: 10,
    CB_BATCH: 11,
    AUTH: 12,
    BATCH: 13,
} as const

// Stream end sentinel. Goes ON WIRE as first callback argument —
// hence string (Symbol won't travel via JSON); value must not change (wire compat).
export const RPC_STOP = "___STOP";

// Server marker 'this node is Listen wrapper' (doesn't travel on wire;
// on wire server declares ADDRESSES of such nodes in 4th element of Pkt.MAP).
export const IS_RPC_LISTEN = Symbol.for("isRpcListen");

// Authorization state of the CURRENT session, pushed by the server as [Pkt.AUTH, notice].
// 'expiring' — deadline is near, session still live (renew now); 'expired'/'revoked' — the
// principal is ALREADY downgraded to the object the server was constructed with.
export type tAuthState = "expiring" | "expired" | "revoked";

export type RpcAuthNotice = {
    state: tAuthState;
    /** Why: message of the revoking error, or a short expiry reason. */
    reason?: any;
    /** Absolute ms deadline of the current token (goes with 'expiring'). */
    expiresAt?: number;
};

// Reserved sub-object of authAck (5th element of Pkt.MAP) carrying the SERVER's facts about the
// current grant — today only `{expiresAt}`. authAck is the APPLICATION's value: any shape, read
// field by field by its own consumers, so server facts go under ONE `$`-prefixed key (an ack does
// not carry `$rpc` by accident) instead of N loose ones. An ack that is not a plain object, or
// that already owns this key, travels UNCHANGED — the application wins. Hence the key is optional
// by contract and every consumer must read it defensively. Wire contract: the value must not
// change. Attached by `withGrantDeadline` (rpc-server.ts), read by `grantDeadline` (rpc-client.ts).
export const GRANT_FACTS_KEY = '$rpc'

export type SocketTmpl = {
    emit: (e: string, d: any) => void;
    on: (e: string, cb: (d: any) => void) => void;
};
