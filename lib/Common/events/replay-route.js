"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayRouteSubscribe = replayRouteSubscribe;
const transport_lifecycle_1 = require("./transport-lifecycle");
function unsubscribeHandle(handle) {
    if (typeof handle == 'function') {
        handle();
        return;
    }
    if (typeof handle?.off == 'function')
        handle.off();
    else if (typeof handle?.unsubscribe == 'function')
        handle.unsubscribe();
}
function replayRouteSubscribe(remote, cb, opts = {}) {
    const { onSeq, onError, onRoute } = opts;
    let lastDelivered = opts.since ?? -1;
    let closed = false;
    let active = null;
    let currentLabel = opts.label;
    let switchChain = Promise.resolve();
    const slots = new Set();
    function emitRoute(ev) {
        if (!onRoute)
            return;
        try {
            onRoute(ev);
        }
        catch (e) {
            setTimeout(function rethrowRouteEvent() { throw e; }, 0);
        }
    }
    function deliver(ev) {
        if (closed || ev.seq <= lastDelivered)
            return;
        lastDelivered = ev.seq;
        cb(...ev.event);
        onSeq?.(ev.seq);
    }
    function deliverMany(envs, allowReset) {
        if (allowReset && envs.length && envs[0].seq <= lastDelivered) {
            lastDelivered = envs[0].seq - 1;
        }
        for (const ev of envs)
            deliver(ev);
    }
    function attach(nextRemote, since, nextOpts, allowReset) {
        const { policy = 'queue', hint, label } = nextOpts;
        let slot;
        let slotClosed = false;
        let replaying = true;
        let lineError;
        const queue = [];
        const frameLineState = (0, transport_lifecycle_1.getRpcMemberState)(nextRemote, 'frameLine');
        const liveLine = policy == 'frame' && frameLineState != false && nextRemote.frameLine ? nextRemote.frameLine : nextRemote.line;
        const handle = liveLine.on(function liveTap(ev) {
            if (slotClosed)
                return;
            if (ev == null || typeof ev.seq != 'number') {
                lineError = new Error('replayRouteSubscribe: line ended by route (' + String(ev) + ')');
                slot.close();
                if (!replaying)
                    onError?.(lineError);
                return;
            }
            if (replaying)
                queue.push(ev);
            else
                deliver(ev);
        });
        function closeSlot() {
            if (slotClosed)
                return;
            slotClosed = true;
            unsubscribeHandle(handle);
            slots.delete(slot);
        }
        async function catchUp() {
            try {
                let done = false;
                const frameState = (0, transport_lifecycle_1.getRpcMemberState)(nextRemote, 'frame');
                if (since >= 0 && frameState != false && nextRemote.frame) {
                    const envs = await nextRemote.frame(since, hint);
                    if (slotClosed)
                        return;
                    if (envs) {
                        deliverMany(envs, allowReset);
                        done = true;
                    }
                }
                if (!done) {
                    const tail = since >= 0 ? await nextRemote.since(since) : null;
                    if (slotClosed)
                        return;
                    if (tail) {
                        deliverMany(tail, false);
                    }
                    else {
                        const kf = await nextRemote.keyframe();
                        if (slotClosed)
                            return;
                        if (kf)
                            deliverMany([kf], allowReset);
                    }
                }
                if (lineError)
                    throw lineError;
                while (queue.length)
                    deliver(queue.shift());
                replaying = false;
            }
            catch (e) {
                closeSlot();
                throw e;
            }
        }
        slot = {
            label,
            ready: catchUp(),
            close: closeSlot,
            closed: () => slotClosed,
        };
        slots.add(slot);
        return slot;
    }
    async function doSwitch(nextRemote, nextOpts = {}, initial = false) {
        if (closed)
            throw new Error('replayRouteSubscribe: closed');
        const from = active;
        const fromLabel = from?.label ?? currentLabel;
        const toLabel = nextOpts.label;
        const since = nextOpts.since ?? lastDelivered;
        const allowReset = nextOpts.reset ?? (initial || !from);
        const slot = attach(nextRemote, since, nextOpts, allowReset);
        emitRoute({ phase: 'switching', from: fromLabel, to: toLabel, seq: lastDelivered });
        try {
            await slot.ready;
            if (closed || slot.closed())
                return;
            active = slot;
            currentLabel = slot.label;
            if (from && from !== slot)
                from.close();
            emitRoute({ phase: 'ready', from: fromLabel, to: toLabel, seq: lastDelivered });
        }
        catch (e) {
            slot.close();
            emitRoute({ phase: 'error', from: fromLabel, to: toLabel, seq: lastDelivered, error: e });
            onError?.(e);
            throw e;
        }
    }
    const ready = doSwitch(remote, opts, true);
    switchChain = ready.catch(() => { });
    function switchRoute(nextRemote, nextOpts = {}) {
        const run = () => doSwitch(nextRemote, nextOpts, false);
        const p = switchChain.then(run, run);
        switchChain = p.catch(() => { });
        return p;
    }
    function off() {
        if (closed)
            return;
        closed = true;
        for (const slot of Array.from(slots))
            slot.close();
        active = null;
        emitRoute({ phase: 'closed', seq: lastDelivered, to: currentLabel });
    }
    return Object.assign(off, {
        ready,
        switch: switchRoute,
        seq: () => lastDelivered,
        label: () => currentLabel,
        active: () => active != null && !active.closed(),
    });
}
