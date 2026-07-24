import { type RpcBinaryProtocolVersion } from './rpc-binary-envelope';
export declare function createRpcBinaryPeer({ sessionId, maxShapes, protocolVersion, maxSchemas, promotionThreshold, predeclared, }: {
    sessionId: number;
    maxShapes: number;
    protocolVersion?: RpcBinaryProtocolVersion;
    maxSchemas?: number;
    promotionThreshold?: number;
    predeclared?: readonly unknown[];
}): {
    protocolVersion: RpcBinaryProtocolVersion;
    prepare: (packet: any[]) => {
        wire: Uint8Array<ArrayBuffer>;
        commit: () => void;
        rollback: () => void;
    };
    measure: (packet: any[]) => number;
    decode: (payload: Uint8Array) => any;
    encodePrelude: () => Uint8Array<ArrayBuffer>;
    decodePrelude: (payload: Uint8Array) => void;
    stats: () => any;
    reset: () => void;
};
export type RpcBinaryPeer = ReturnType<typeof createRpcBinaryPeer>;
