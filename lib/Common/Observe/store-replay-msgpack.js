"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreReplayMsgpackCodec = createStoreReplayMsgpackCodec;
const msgpackr_1 = require("msgpackr");
const rpc_binary_value_1 = require("../rcp/rpc-binary-value");
const store_replay_codec_1 = require("./store-replay-codec");
const STORE_REPLAY_V7_MAX_SCHEMAS = 1_000;
const V7_BATCH = {
    TOP_SET: 0,
    TOP_DELETE: 1,
    V2: 2,
    ROOT_SET: 3,
};
function createSchemaKnowledge(parts = []) {
    const known = new Uint8Array(STORE_REPLAY_V7_MAX_SCHEMAS);
    function add(id) {
        if (id >= 0 && id < known.length)
            known[id] = 1;
    }
    function addParts(next) {
        for (const part of next) {
            if (typeof part == 'number') {
                add(part);
                continue;
            }
            const from = Math.max(0, part[0]);
            const to = Math.min(known.length - 1, part[1]);
            for (let id = from; id <= to; id++)
                add(id);
        }
    }
    function ranges() {
        const result = [];
        let id = 0;
        while (id < known.length) {
            if (!known[id]) {
                id++;
                continue;
            }
            const from = id;
            while (id + 1 < known.length && known[id + 1])
                id++;
            result.push(from == id ? from : [from, id]);
            id++;
        }
        return result;
    }
    function clear() {
        known.fill(0);
    }
    addParts(parts);
    return {
        has: (id) => known[id] == 1,
        add,
        ranges,
        clear,
    };
}
function encodeStoreReplayMsgpackValue(event) {
    const patches = event.event[0];
    if (patches.length == 1) {
        const patch = patches[0];
        const root = patch.value;
        const prototype = root != null && typeof root == 'object'
            ? Object.getPrototypeOf(root)
            : undefined;
        if (patch.exists && patch.path.length == 0
            && (prototype == Object.prototype || prototype == null)) {
            const keys = Object.keys(root);
            const entries = new Array(keys.length * 2 + 1);
            entries[0] = prototype == null ? 1 : 0;
            let offset = 1;
            for (const key of keys) {
                entries[offset++] = key;
                entries[offset++] = root[key];
            }
            return [V7_BATCH.ROOT_SET, event.seq, event.ts, entries];
        }
    }
    let topSet = patches.length > 0;
    let topDelete = patches.length > 0;
    for (const patch of patches) {
        const topStringKey = patch.path.length == 1 && typeof patch.path[0] == 'string';
        topSet = topSet && topStringKey && patch.exists;
        topDelete = topDelete && topStringKey && !patch.exists;
        if (!topSet && !topDelete)
            return (0, store_replay_codec_1.encodeStoreReplayBatchV2)(event);
    }
    if (topSet) {
        const entries = new Array(patches.length * 2);
        let offset = 0;
        for (const patch of patches) {
            entries[offset++] = patch.path[0];
            entries[offset++] = patch.value;
        }
        return [V7_BATCH.TOP_SET, event.seq, event.ts, entries];
    }
    if (topDelete) {
        return [
            V7_BATCH.TOP_DELETE,
            event.seq,
            event.ts,
            patches.map(patch => patch.path[0]),
        ];
    }
    return (0, store_replay_codec_1.encodeStoreReplayBatchV2)(event);
}
function decodeStoreReplayMsgpackValue(wire) {
    if (wire[0] == V7_BATCH.TOP_SET) {
        const entries = wire[3];
        const patches = new Array(entries.length / 2);
        for (let index = 0, offset = 0; index < entries.length; index += 2, offset++) {
            patches[offset] = {
                path: [entries[index]],
                exists: true,
                value: entries[index + 1],
            };
        }
        return { seq: wire[1], ts: wire[2], event: [patches] };
    }
    if (wire[0] == V7_BATCH.TOP_DELETE) {
        const patches = wire[3].map(function decodeTopDelete(key) {
            return { path: [key], exists: false, value: undefined };
        });
        return { seq: wire[1], ts: wire[2], event: [patches] };
    }
    if (wire[0] == V7_BATCH.ROOT_SET) {
        const entries = wire[3];
        const nullPrototype = entries[0] == 1;
        const root = nullPrototype ? Object.create(null) : {};
        for (let index = 1; index < entries.length; index += 2) {
            const key = entries[index];
            if (key != '__proto__' || nullPrototype) {
                root[key] = entries[index + 1];
                continue;
            }
            Object.defineProperty(root, key, {
                configurable: true, enumerable: true, writable: true,
                value: entries[index + 1],
            });
        }
        const patch = { path: [], exists: true, value: root };
        return { seq: wire[1], ts: wire[2], event: [[patch]] };
    }
    return (0, store_replay_codec_1.decodeStoreReplayBatchV2)(wire);
}
function createStoreReplayMsgpackCodec() {
    const catalogId = Math.floor(Math.random() * 0x1_0000_0000);
    const encoderStructures = [];
    function shouldShareStructure(keys) {
        return keys.length <= 64;
    }
    const encoder = new msgpackr_1.Packr({
        useRecords: true,
        structures: encoderStructures,
        maxSharedStructures: STORE_REPLAY_V7_MAX_SCHEMAS,
        shouldShareStructure,
        moreTypes: true,
    });
    const decoderStructures = [];
    const decoder = new msgpackr_1.Unpackr({
        useRecords: true,
        structures: decoderStructures,
        maxSharedStructures: STORE_REPLAY_V7_MAX_SCHEMAS,
        moreTypes: true,
        copyBuffers: true,
    });
    const defaultRemoteKnowledge = createSchemaKnowledge();
    const decoderKnowledge = createSchemaKnowledge();
    let decoderCatalogId;
    function createRemoteKnowledge(snapshot) {
        return createSchemaKnowledge(snapshot?.catalogId == catalogId ? snapshot.known : []);
    }
    function prepare(event) {
        return (0, rpc_binary_value_1.trustRpcBinaryLeaf)(encoder.pack(encodeStoreReplayMsgpackValue(event)));
    }
    function wire(payload, remoteKnowledge = defaultRemoteKnowledge) {
        const definitions = [];
        const sharedLength = encoderStructures.sharedLength ?? 0;
        for (let id = 0; id < sharedLength; id++) {
            if (remoteKnowledge.has(id))
                continue;
            const keys = encoderStructures[id];
            if (!Array.isArray(keys))
                continue;
            definitions.push([id, Array.from(keys)]);
            remoteKnowledge.add(id);
        }
        return [catalogId, definitions, payload];
    }
    function encode(event, remoteKnowledge = defaultRemoteKnowledge) {
        return wire(prepare(event), remoteKnowledge);
    }
    function knowledge() {
        return {
            catalogId: decoderCatalogId ?? 0,
            known: decoderKnowledge.ranges(),
        };
    }
    function decode(packet) {
        const [nextCatalogId, definitions, wire] = packet;
        if (decoderCatalogId != nextCatalogId) {
            decoderCatalogId = nextCatalogId;
            decoderKnowledge.clear();
            decoderStructures.length = 0;
            const state = decoderStructures;
            state.sharedLength = 0;
        }
        for (const [id, definition] of definitions) {
            const keys = Array.from(definition);
            keys.isShared = true;
            decoderStructures[id] = keys;
            decoderKnowledge.add(id);
        }
        const state = decoderStructures;
        state.sharedLength = Math.max(state.sharedLength ?? 0, decoderStructures.length);
        const source = Object.isExtensible(wire)
            ? wire
            : new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength);
        return decodeStoreReplayMsgpackValue(decoder.unpack(source));
    }
    return {
        catalogId,
        prepare,
        wire,
        encode,
        decode,
        knowledge,
        createRemoteKnowledge,
    };
}
