export declare const RPC_BINARY_PROTOCOL_VERSION = 1;
export declare const RPC_BINARY_SCHEMA_PROTOCOL_VERSION = 2;
export declare const RPC_BINARY_MSGPACK_PROTOCOL_VERSION = 3;
export declare const RPC_BINARY_MAX_FRAME_BYTES = 32000000;
export type RpcBinaryProtocolVersion = typeof RPC_BINARY_PROTOCOL_VERSION | typeof RPC_BINARY_SCHEMA_PROTOCOL_VERSION | typeof RPC_BINARY_MSGPACK_PROTOCOL_VERSION;
export declare const RpcBinaryFrame: {
    readonly PROBE: 0;
    readonly PROBE_ACK: 1;
    readonly PACKET: 2;
};
type tRpcBinaryFrameKind = typeof RpcBinaryFrame[keyof typeof RpcBinaryFrame];
export declare function isRpcBinaryEnvelope(wire: unknown): boolean;
export declare function inspectRpcBinaryEnvelope(wire: unknown): {
    kind: tRpcBinaryFrameKind;
    version: 1 | 2 | 3;
    sessionId: number;
    payload: Uint8Array<ArrayBufferLike>;
} | undefined;
export declare function encodeRpcBinaryControl(kind: typeof RpcBinaryFrame.PROBE | typeof RpcBinaryFrame.PROBE_ACK, sessionId: number, version?: RpcBinaryProtocolVersion, payload?: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function wrapRpcBinaryPacket(sessionId: number, payload: Uint8Array, version?: RpcBinaryProtocolVersion): Uint8Array<ArrayBuffer>;
export {};
