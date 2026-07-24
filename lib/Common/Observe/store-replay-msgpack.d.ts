import type { ReplayEvent } from '../events/replay-listen';
import type { StorePatch } from './store';
import { type tStoreReplayWireBatchV2 } from './store-replay-codec';
export type tStoreReplaySchemaKnowledgePart = number | readonly [from: number, to: number];
export type tStoreReplaySchemaKnowledge = {
    catalogId: number;
    known: readonly tStoreReplaySchemaKnowledgePart[];
};
export type tStoreReplayWireBatchV7 = tStoreReplayWireBatchV2;
declare function createEmptyKnowledge(): {
    has: (_id: number) => boolean;
    add: (_id: number) => void;
    ranges: () => tStoreReplaySchemaKnowledgePart[];
    clear: () => void;
};
export declare function createStoreReplayMsgpackCodec(): {
    catalogId: number;
    prepare: (event: ReplayEvent<[readonly StorePatch[]]>) => tStoreReplayWireBatchV2;
    wire: (payload: tStoreReplayWireBatchV2, _remoteKnowledge?: ReturnType<typeof createEmptyKnowledge>) => tStoreReplayWireBatchV2;
    encode: (event: ReplayEvent<[readonly StorePatch[]]>, _remoteKnowledge?: ReturnType<typeof createEmptyKnowledge>) => tStoreReplayWireBatchV2;
    decode: (packet: tStoreReplayWireBatchV7 | unknown) => ReplayEvent<[StorePatch[]]>;
    knowledge: () => tStoreReplaySchemaKnowledge;
    createRemoteKnowledge: (_snapshot?: tStoreReplaySchemaKnowledge) => {
        has: (_id: number) => boolean;
        add: (_id: number) => void;
        ranges: () => tStoreReplaySchemaKnowledgePart[];
        clear: () => void;
    };
};
export type StoreReplayMsgpackCodec = ReturnType<typeof createStoreReplayMsgpackCodec>;
export {};
