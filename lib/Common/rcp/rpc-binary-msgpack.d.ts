export declare function createRpcBinaryMsgpackCodec({ maxWireBytes, }: {
    maxWireBytes: number;
}): {
    encode: (value: unknown) => Buffer<ArrayBufferLike>;
    decode: (wire: Uint8Array) => any;
    measure: (value: unknown) => number;
    stats: () => {
        encodedFrames: number;
        decodedFrames: number;
        encodedBytes: number;
        decodedBytes: number;
    };
    reset: () => void;
};
export type RpcBinaryMsgpackCodec = ReturnType<typeof createRpcBinaryMsgpackCodec>;
