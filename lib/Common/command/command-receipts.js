"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandReceiptKey = commandReceiptKey;
exports.createCommandReceipts = createCommandReceipts;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
function commandReceiptKey(account, requestId) {
    return JSON.stringify([account, requestId]);
}
function createCommandReceipts(deps = {}) {
    const owned = !deps.store;
    const store = deps.store ?? (0, store_1.createStore)({ receipts: {} });
    const restored = store.snapshot().receipts;
    const normalized = {};
    let needsRekey = false;
    for (const [key, record] of Object.entries(restored)) {
        const canonical = commandReceiptKey(record.account, record.requestId);
        if (key != canonical)
            needsRekey = true;
        const previous = normalized[canonical];
        if (!previous || record.ts >= previous.ts)
            normalized[canonical] = record;
    }
    if (needsRekey)
        store.state.receipts = normalized;
    const exposed = owned ? (0, store_replay_1.exposeStoreReplay)(store, {
        ...deps.replay,
        describe: { ...deps.replay?.describe, commandReceipts: { version: 2 } },
    }) : null;
    function set(record) {
        store.state.receipts[commandReceiptKey(record.account, record.requestId)] = record;
    }
    function deleteKey(key) {
        if (store.state.receipts[key])
            delete store.state.receipts[key];
    }
    function get(key) {
        return store.state.receipts[key];
    }
    function snapshot() {
        return store.snapshot().receipts;
    }
    function close() {
        exposed?.close();
    }
    if (owned && deps.initial)
        for (const record of deps.initial)
            set(record);
    const control = {
        set, delete: deleteKey, snapshot, get,
        flush() { exposed?.flushPending(); },
        close,
    };
    return {
        api: (exposed?.api.replay ?? null),
        control,
        store,
        close,
    };
}
