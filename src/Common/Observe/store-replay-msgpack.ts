// =====================================================================
// Store Replay v7 — unchanged v2 value for the universal msgpack RPC lane
// =====================================================================

import type {ReplayEvent} from '../events/replay-listen'
import type {StorePatch} from './store'
import {
    decodeStoreReplayBatchV2,
    encodeStoreReplayBatchV2,
    type tStoreReplayWireBatchV2,
} from './store-replay-codec'

// Retained as a source-compatible no-op. V7 no longer owns a second schema
// catalog: the universal RPC codec owns binary serialization for every packet.
export type tStoreReplaySchemaKnowledgePart =
    | number
    | readonly [from: number, to: number]

export type tStoreReplaySchemaKnowledge = {
    catalogId: number
    known: readonly tStoreReplaySchemaKnowledgePart[]
}

export type tStoreReplayWireBatchV7 = tStoreReplayWireBatchV2

const EMPTY_KNOWLEDGE: tStoreReplaySchemaKnowledge = {
    catalogId: 0,
    known: [],
}

function createEmptyKnowledge() {
    return {
        has: (_id: number) => false,
        add: (_id: number) => {},
        ranges: () => [] as tStoreReplaySchemaKnowledgePart[],
        clear: () => {},
    }
}

export function createStoreReplayMsgpackCodec() {
    function prepare(event: ReplayEvent<[readonly StorePatch[]]>) {
        return encodeStoreReplayBatchV2(event)
    }

    function wire(
        payload: tStoreReplayWireBatchV2,
        _remoteKnowledge?: ReturnType<typeof createEmptyKnowledge>,
    ) {
        return payload
    }

    function encode(
        event: ReplayEvent<[readonly StorePatch[]]>,
        _remoteKnowledge?: ReturnType<typeof createEmptyKnowledge>,
    ) {
        return prepare(event)
    }

    function decode(packet: tStoreReplayWireBatchV7 | unknown) {
        return decodeStoreReplayBatchV2(packet)
    }

    function knowledge() {
        return EMPTY_KNOWLEDGE
    }

    function createRemoteKnowledge(_snapshot?: tStoreReplaySchemaKnowledge) {
        return createEmptyKnowledge()
    }

    return {
        catalogId: 0,
        prepare,
        wire,
        encode,
        decode,
        knowledge,
        createRemoteKnowledge,
    }
}

export type StoreReplayMsgpackCodec = ReturnType<typeof createStoreReplayMsgpackCodec>
