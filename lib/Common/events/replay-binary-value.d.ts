import { type RpcLimits } from '../rcp/rpc-limits';
declare const REPLAY_BINARY_CALLBACK_REF: unique symbol;
type tReplayBinaryCallbackRef = {
    [REPLAY_BINARY_CALLBACK_REF]: number;
};
export declare function ReplayBinaryCallbackRefValue(): void;
export declare function createReplayBinaryCallbackRef(id: number): Readonly<tReplayBinaryCallbackRef>;
export declare function replayBinaryCallbackRefId(value: unknown): number | undefined;
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
export declare function trustReplayBinaryLeaf<T extends ArrayBufferView>(value: T): T;
export declare function replayBinaryNativeOwnStateError(value: object, kind: 'Date' | 'RegExp' | 'Map' | 'Set' | 'ArrayBuffer' | 'DataView' | 'TypedArray', typedArrayItems?: number): string | undefined;
export declare function replayBinaryRegExpError(source: string, flags: string): "RegExp flags are unsupported or non-canonical in protocol v1" | "RegExp source syntax is unsupported in protocol v1" | undefined;
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
