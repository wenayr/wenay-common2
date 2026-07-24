"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreReplayMsgpackCodec = createStoreReplayMsgpackCodec;
const store_replay_codec_1 = require("./store-replay-codec");
const EMPTY_KNOWLEDGE = {
    catalogId: 0,
    known: [],
};
function createEmptyKnowledge() {
    return {
        has: (_id) => false,
        add: (_id) => { },
        ranges: () => [],
        clear: () => { },
    };
}
function createStoreReplayMsgpackCodec() {
    function prepare(event) {
        return (0, store_replay_codec_1.encodeStoreReplayBatchV2)(event);
    }
    function wire(payload, _remoteKnowledge) {
        return payload;
    }
    function encode(event, _remoteKnowledge) {
        return prepare(event);
    }
    function decode(packet) {
        return (0, store_replay_codec_1.decodeStoreReplayBatchV2)(packet);
    }
    function knowledge() {
        return EMPTY_KNOWLEDGE;
    }
    function createRemoteKnowledge(_snapshot) {
        return createEmptyKnowledge();
    }
    return {
        catalogId: 0,
        prepare,
        wire,
        encode,
        decode,
        knowledge,
        createRemoteKnowledge,
    };
}
