import { type RpcLimits } from './rpc-limits';
declare const RPC_BINARY_CALLBACK_REF: unique symbol;
type tRpcBinaryCallbackRef = {
    [RPC_BINARY_CALLBACK_REF]: number;
};
export declare function RpcBinaryCallbackRefValue(): void;
export declare function createRpcBinaryCallbackRef(id: number): Readonly<tRpcBinaryCallbackRef>;
export declare function rpcBinaryCallbackRefId(value: unknown): number | undefined;
export type BinaryShapeCacheOptions = {
    maxEntries?: number;
    maxFieldRefs?: number;
    maxKeyTextBytes?: number;
};
export type BinaryValueCodecOptions = {
    magic: readonly number[] | Uint8Array;
    version: number;
    label: string;
    callbackRefs?: boolean;
    shapeCache?: boolean | number | BinaryShapeCacheOptions;
    maxDepth?: number;
    maxBinaryBytes?: number;
    maxWireBytes?: number;
};
export type BinaryValueWireLimits = {
    maxWireBytes?: number;
};
export declare function trustRpcBinaryLeaf<T extends ArrayBufferView>(value: T): T;
export declare function rpcBinaryNativeOwnStateError(value: object, kind: 'Date' | 'RegExp' | 'Map' | 'Set' | 'ArrayBuffer' | 'DataView' | 'TypedArray', typedArrayItems?: number): string | undefined;
export declare function rpcBinaryRegExpV1Error(source: string, flags: string): "RegExp flags are unsupported or non-canonical in protocol v1" | "RegExp source syntax is unsupported in protocol v1" | undefined;
export declare function createBinaryValueCodec(options: BinaryValueCodecOptions): {
    encode: (value: unknown) => Uint8Array<ArrayBuffer>;
    prepareEncode: (value: unknown) => {
        wire: Uint8Array<ArrayBuffer>;
        commit: () => void;
        rollback: () => void;
    };
    measureEncode: (value: unknown) => number;
    decode: (wire: unknown, requestedLimits?: RpcLimits, wireLimits?: BinaryValueWireLimits) => unknown;
    decodeTrusted: (wire: unknown, requestedLimits?: RpcLimits, wireLimits?: BinaryValueWireLimits) => unknown;
    stats: () => {
        generation: number;
        pendingEncode: boolean;
        encodeShapes: number;
        decodeShapes: number;
        encodeFieldRefs: number;
        decodeFieldRefs: number;
        encodeKeyTextBytes: number;
        decodeKeyTextBytes: number;
        encodeDefinitions: number;
        encodeReferences: number;
        encodeRawShapes: number;
        decodeDefinitions: number;
        decodeReferences: number;
    };
    reset: () => void;
};
export type BinaryValueCodec = ReturnType<typeof createBinaryValueCodec>;
export {};
