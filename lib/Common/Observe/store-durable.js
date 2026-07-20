"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDurableStoreReplay = createDurableStoreReplay;
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
const replay_history_1 = require("../events/replay-history");
function createDurableStoreReplay(deps) {
    const { storage, everyEvents, everyMs, drain } = deps;
    const envelopes = (0, replay_history_1.openHistory)(storage).at({});
    let restoredSeq = 0;
    let state = (deps.initial ?? {});
    if (envelopes) {
        const scratch = (0, store_1.createStore)({});
        for (const ev of envelopes)
            (0, store_1.applyStorePatch)(scratch, ev.event[0]);
        state = scratch.snapshot();
        restoredSeq = envelopes[envelopes.length - 1].seq;
    }
    const store = (0, store_1.createStore)(state, drain !== undefined ? { drain } : {});
    let lineHead = () => restoredSeq;
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, {
        ...(deps.expose ?? {}),
        firstSeq: restoredSeq,
        getSince: function persistedSince(seq) {
            if (seq > lineHead())
                return undefined;
            if (seq == lineHead())
                return [];
            const tail = storage.getEvents(seq, Infinity);
            if (!tail.length || tail[0].seq != seq + 1)
                return undefined;
            return tail;
        },
    });
    lineHead = exposed.replay.head;
    const archive = (0, replay_history_1.archiveReplay)(exposed.replay, {
        storage,
        ...(everyEvents != null ? { everyEvents } : {}),
        ...(everyMs != null ? { everyMs } : {}),
    });
    return {
        store,
        api: exposed.api,
        replay: exposed.replay,
        restored: { seq: restoredSeq, fromArchive: !!envelopes },
        stats: archive.stats,
        close() { archive.close(); exposed.close(); },
    };
}
