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
    const cadenceEvents = everyEvents ?? 64;
    let events = 0;
    let keyframes = 0;
    let lastKfSeq = 0;
    let lastKfTs = 0;
    let lineHead = () => restoredSeq;
    const { batch: requestedBatch = true, onJournal: userOnJournal, ...exposeOpts } = deps.expose ?? {};
    const bulkPut = storage.putEvents;
    function persistEvent(ev) {
        userOnJournal?.(ev);
        storage.putEvent(ev);
        events++;
    }
    function persistBatch(batch) {
        bulkPut(batch);
        events += batch.length;
    }
    const safeBatch = requestedBatch ? {
        ...(requestedBatch === true ? {} : requestedBatch),
        getSince: undefined,
        firstSeq: restoredSeq,
    } : false;
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, {
        ...exposeOpts,
        batch: safeBatch,
        firstSeq: restoredSeq,
        onJournal: bulkPut ? userOnJournal : persistEvent,
        onJournalBatch: bulkPut ? persistBatch : undefined,
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
    function takeKeyframe() {
        const kf = exposed.replay.keyframe();
        if (!kf)
            return;
        storage.putKeyframe(kf);
        keyframes++;
        lastKfSeq = kf.seq;
        lastKfTs = kf.ts;
    }
    function updateKeyframeCadence() {
        const head = exposed.replay.head();
        const ts = exposed.replay.lastTs();
        const due = head - lastKfSeq >= cadenceEvents || (everyMs != null && ts - lastKfTs >= everyMs);
        if (due)
            takeKeyframe();
    }
    try {
        takeKeyframe();
    }
    catch (error) {
        exposed.close();
        throw error;
    }
    const offBurst = (0, store_1.listenStorePatches)(store).on(function finishDurableBurst() { updateKeyframeCadence(); });
    function retry() {
        exposed.flushPending();
        updateKeyframeCadence();
    }
    const archive = {
        stats: () => ({ events, keyframes }),
        close() {
            offBurst();
        },
    };
    return {
        store,
        api: exposed.api,
        replay: exposed.replay,
        restored: { seq: restoredSeq, fromArchive: !!envelopes },
        stats: archive.stats,
        retry,
        close() { archive.close(); exposed.close(); },
    };
}
