"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playbackStoreReplay = playbackStoreReplay;
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
const replay_history_1 = require("../events/replay-history");
function playbackStoreReplay(storage, opts = {}) {
    const { speed = 1, maxStepMs, drain } = opts;
    const all = storage.getEvents(0, Infinity);
    let base = storage.getKeyframe(all.length ? { seq: all[0].seq - 1 } : {});
    let tail;
    if (base)
        tail = all.filter(ev => ev.seq > base.seq);
    else {
        const envs = (0, replay_history_1.openHistory)(storage).at({});
        base = envs?.[0];
        tail = envs?.slice(1) ?? [];
    }
    const store = (0, store_1.createStore)({}, drain !== undefined ? { drain } : {});
    if (base)
        (0, store_1.applyStorePatch)(store, base.event[0]);
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, { ...(opts.expose ?? {}), firstSeq: base?.seq ?? 0 });
    let closed = false;
    let timer = null;
    let index = 0;
    let resolveDone = function resolveLater() { };
    const done = new Promise(function waitPlayback(resolve) { resolveDone = resolve; });
    function finish() { if (!closed) {
        closed = true;
        resolveDone();
    } }
    function step() {
        timer = null;
        while (!closed && index < tail.length) {
            const ev = tail[index++];
            (0, store_1.applyStorePatch)(store, ev.event[0]);
            if (index >= tail.length)
                break;
            const gap = Math.max(0, tail[index].ts - ev.ts) / speed;
            const wait = maxStepMs != null ? Math.min(gap, maxStepMs) : gap;
            if (wait > 0 && Number.isFinite(wait)) {
                timer = setTimeout(step, wait);
                timer.unref?.();
                return;
            }
        }
        finish();
    }
    if (speed == Infinity || !tail.length)
        step();
    else {
        timer = setTimeout(step, 0);
        timer.unref?.();
    }
    return {
        store,
        api: exposed.api,
        replay: exposed.replay,
        range: { from: base?.seq ?? 0, to: tail.length ? tail[tail.length - 1].seq : base?.seq ?? 0 },
        done,
        close() { if (timer) {
            clearTimeout(timer);
            timer = null;
        } finish(); exposed.close(); },
    };
}
