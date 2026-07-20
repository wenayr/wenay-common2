"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.conflateReplay = conflateReplay;
const Listen_1 = require("./Listen");
function conflateReplay(replay, opts) {
    const { pending, highWater, lowWater = 0, pollMs = 25, keyOf, maxKeys = 1024 } = opts;
    if (!replay.hasKeyframe)
        throw new TypeError('conflateReplay: need current-provider (keyframe recovery)');
    const gate = (0, Listen_1.createListen)(() => { });
    gate.run();
    let conflating = false;
    let closed = false;
    let dropped = 0;
    let keyframes = 0;
    let coalesced = 0;
    let flushes = 0;
    let held = null;
    let timer = null;
    function stopPoll() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }
    function startPoll() {
        if (timer || closed)
            return;
        timer = setInterval(recoverIfDrained, pollMs);
        timer.unref?.();
    }
    function recoverIfDrained() {
        if (!conflating || closed)
            return;
        if (pending() > lowWater)
            return;
        conflating = false;
        stopPoll();
        if (held) {
            const tail = [...held.values()];
            held = null;
            flushes++;
            for (const ev of tail)
                gate.emit(ev);
            return;
        }
        const kf = replay.keyframe();
        if (kf) {
            keyframes++;
            gate.emit(kf);
        }
    }
    function absorb(ev) {
        const k = keyOf(...ev.event);
        if (k == null || (!held.has(k) && held.size >= maxKeys)) {
            dropped += held.size + 1;
            held = null;
            return;
        }
        if (held.delete(k))
            coalesced++;
        held.set(k, ev);
    }
    const offLine = replay.line.on(function gateForward(ev) {
        if (closed)
            return;
        if (!conflating && pending() > highWater) {
            conflating = true;
            held = keyOf ? new Map() : null;
            startPoll();
        }
        if (conflating) {
            if (held) {
                absorb(ev);
                recoverIfDrained();
                return;
            }
            recoverIfDrained();
            if (conflating)
                dropped++;
            return;
        }
        gate.emit(ev);
    });
    function close() {
        if (closed)
            return;
        closed = true;
        held = null;
        stopPoll();
        offLine();
        gate.close();
    }
    return {
        api: {
            line: gate,
            since: (seq) => replay.getSince(seq) ?? null,
            keyframe: () => replay.keyframe() ?? null,
            frame: (seq, hint) => replay.frame(seq, hint),
        },
        close,
        stats: () => ({ conflating, dropped, keyframes, coalesced, flushes }),
    };
}
