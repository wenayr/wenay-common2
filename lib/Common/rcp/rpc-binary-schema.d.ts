type tSchemaHint = string | number;
export type RpcBinarySchemaCodecOptions = {
    magic: readonly number[] | Uint8Array;
    version: number;
    label: string;
    callbackRefs?: boolean;
    maxSchemas?: number;
    promotionThreshold?: number;
    predeclared?: readonly unknown[];
    maxDepth?: number;
    maxBinaryBytes?: number;
    maxWireBytes?: number;
};
export declare function createRpcBinarySchemaCodec(options: RpcBinarySchemaCodecOptions): {
    encode: (value: unknown, rootDepth?: number) => Uint8Array<ArrayBuffer>;
    prepareEncode: (value: unknown, rootDepth?: number) => {
        wire: Uint8Array<ArrayBuffer>;
        commit: () => void;
        rollback: () => void;
    };
    prepareEncodeTrusted: (value: unknown, rootDepth?: number, trustedHint?: tSchemaHint) => {
        wire: Uint8Array<ArrayBuffer>;
        commit: () => void;
        rollback: () => void;
    };
    measureEncode: (value: unknown, rootDepth?: number) => number;
    measureEncodeTrusted: (value: unknown, rootDepth?: number, trustedHint?: tSchemaHint) => number;
    decode: (wire: unknown) => any;
    decodeTrusted: (wire: unknown) => any;
    stats: () => {
        generation: number;
        pendingEncode: boolean;
        encodeSchemas: number;
        decodeSchemas: number;
        encodeCandidates: number;
        encodePromotions: number;
        encodeDefinitions: number;
        decodeDefinitions: number;
        encodeReferences: number;
        decodeReferences: number;
        encodeRuns: number;
        decodeRuns: number;
        encodeRows: number;
        decodeRows: number;
        encodeGeneric: number;
        decodeGeneric: number;
        encodeTypedFields: number;
        decodeTypedFields: number;
        encodedBytes: number;
    };
    reset: () => void;
    encodePrelude: () => Uint8Array<ArrayBuffer>;
    decodePrelude: (payload: unknown) => undefined;
};
export type RpcBinarySchemaCodec = ReturnType<typeof createRpcBinarySchemaCodec>;
export {};
