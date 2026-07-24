import type { ReplayEvent } from '../events/replay-listen';
import type { StorePatch } from './store';
export type tStoreReplaySchemaKnowledgePart = number | readonly [from: number, to: number];
export type tStoreReplaySchemaKnowledge = {
    catalogId: number;
    known: readonly tStoreReplaySchemaKnowledgePart[];
};
export type tStoreReplaySchemaDefinition = readonly [id: number, keys: readonly string[]];
export type tStoreReplayWireBatchV7 = readonly [
    catalogId: number,
    definitions: readonly tStoreReplaySchemaDefinition[],
    payload: Uint8Array
];
export declare function createStoreReplayMsgpackCodec(): {
    catalogId: number;
    prepare: (event: ReplayEvent<[readonly StorePatch[]]>) => Buffer<ArrayBufferLike>;
    wire: (payload: Uint8Array, remoteKnowledge?: {
        has: (id: number) => boolean;
        add: (id: number) => void;
        ranges: () => tStoreReplaySchemaKnowledgePart[];
        clear: () => void;
    }) => tStoreReplayWireBatchV7;
    encode: (event: ReplayEvent<[readonly StorePatch[]]>, remoteKnowledge?: {
        has: (id: number) => boolean;
        add: (id: number) => void;
        ranges: () => tStoreReplaySchemaKnowledgePart[];
        clear: () => void;
    }) => tStoreReplayWireBatchV7;
    decode: (packet: tStoreReplayWireBatchV7) => ReplayEvent<[StorePatch[]]>;
    knowledge: () => tStoreReplaySchemaKnowledge;
    createRemoteKnowledge: (snapshot?: tStoreReplaySchemaKnowledge) => {
        has: (id: number) => boolean;
        add: (id: number) => void;
        ranges: () => tStoreReplaySchemaKnowledgePart[];
        clear: () => void;
    };
};
export type StoreReplayMsgpackCodec = ReturnType<typeof createStoreReplayMsgpackCodec>;
