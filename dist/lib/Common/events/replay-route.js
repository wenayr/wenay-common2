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
    let deliveryQueue = [];
    let delivering = false;
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
    function reportRouteError(error) {
        if (!onError)
            return;
        try {
            onError(error);
        }
        catch (caught) {
            setTimeout(function rethrowRouteErrorCallback() { throw caught; }, 0);
        }
    }
    function deliverOne(ev) {
        if (closed || ev.seq <= lastDelivered)
            return;
        cb(...ev.event);
        lastDelivered = ev.seq;
        if (onSeq) {
            try {
                onSeq(ev.seq);
            }
            catch (error) {
                setTimeout(function rethrowRouteOnSeq() { throw error; }, 0);
            }
        }
    }
    function deliver(ev) {
        deliveryQueue.push(ev);
        if (delivering)
            return;
        delivering = true;
        let index = 0;
        try {
            while (!closed && index < deliveryQueue.length)
                deliverOne(deliveryQueue[index++]);
        }
        finally {
            deliveryQueue.length = 0;
            delivering = false;
        }
    }
    function deliverMany(envs, allowReset) {
        if (allowReset && envs.length && envs[0].seq <= lastDelivered) {
            lastDelivered = envs[0].seq - 1;
        }
        for (const ev of envs)
            deliver(ev);
    }
    function attach(nextRemote, since, nextOpts, allowReset) {
        const { policy = 'queue', hint, label, timeoutMs } = nextOpts;
        let slot;
        let slotClosed = false;
        let replaying = true;
        let lineFailed = false;
        let handle;
        const slotClosedResult = Symbol('replay route slot closed');
        let resolveSlotEnd = function resolveRouteSlotLater(_result) { };
        let rejectSlotEnd = function rejectRouteSlotLater(_error) { };
        const slotEnd = new Promise(function waitForRouteSlotEnd(resolve, reject) {
            resolveSlotEnd = resolve;
            rejectSlotEnd = reject;
        });
        const queue = [];
        function disposeSlot() {
            if (slotClosed)
                return;
            slotClosed = true;
            queue.length = 0;
            unsubscribeHandle(handle);
            slots.delete(slot);
        }
        function closeSlot() {
            if (slotClosed)
                return;
            resolveSlotEnd(slotClosedResult);
            disposeSlot();
        }
        function failLine(error) {
            if (lineFailed || slotClosed)
                return;
            lineFailed = true;
            rejectSlotEnd(error);
            disposeSlot();
            if (!replaying) {
                reportRouteError(error);
            }
        }
        function liveTap(ev) {
            if (slotClosed)
                return;
            if (ev == null || typeof ev.seq != 'number') {
                failLine(new Error('replayRouteSubscribe: line ended by route (' + String(ev) + ')'));
                return;
            }
            if (replaying)
                queue.push(ev);
            else {
                try {
                    deliver(ev);
                }
                catch (error) {
                    failLine(error);
                }
            }
        }
        function attachLiveLine() {
            if (slotClosed)
                return;
            const liveLine = policy == 'frame' && (0, transport_lifecycle_1.rpcMemberMayBeAvailable)(nextRemote, 'frameLine')
                ? nextRemote.frameLine
                : nextRemote.line;
            try {
                handle = liveLine.on(liveTap);
                if (!slotClosed && typeof handle?.then == 'function') {
                    handle.then(function routeLineEnded() { failLine(new Error('replayRouteSubscribe: logical route line ended')); }, function routeLineRejected(error) { failLine(error); });
                }
            }
            catch (error) {
                failLine(error);
            }
            if (slotClosed) {
                unsubscribeHandle(handle);
                handle = null;
            }
        }
        const schemaReady = (0, transport_lifecycle_1.getRpcSchemaReady)(nextRemote);
        let lineReady;
        if (schemaReady) {
            try {
                lineReady = Promise.resolve(schemaReady()).then(attachLiveLine);
            }
            catch (error) {
                lineReady = Promise.reject(error);
            }
            lineReady.catch(function deferRouteLineReadyFailureToCatchUp() { });
        }
        else {
            attachLiveLine();
            lineReady = Promise.resolve();
        }
        function waitForSlot(value) {
            return Promise.race([Promise.resolve(value), slotEnd]);
        }
        async function catchUpRemote() {
            const lineState = await waitForSlot(lineReady);
            if (lineState == slotClosedResult)
                return;
            let done = false;
            if (since >= 0 && (0, transport_lifecycle_1.rpcMemberMayBeAvailable)(nextRemote, 'frame')) {
                const envs = await waitForSlot(nextRemote.frame(since, hint));
                if (envs == slotClosedResult)
                    return;
                if (envs) {
                    deliverMany(envs, allowReset);
                    done = true;
                }
            }
            if (!done) {
                const tail = since >= 0 ? await waitForSlot(nextRemote.since(since)) : null;
                if (tail == slotClosedResult)
                    return;
                if (tail) {
                    deliverMany(tail, false);
                }
                else {
                    const kf = await waitForSlot(nextRemote.keyframe());
                    if (kf == slotClosedResult)
                        return;
                    if (kf)
                        deliverMany([kf], allowReset);
                }
            }
            for (let index = 0; index < queue.length; index++)
                deliver(queue[index]);
            queue.length = 0;
            replaying = false;
        }
        const catchUpReady = Promise.race([
            catchUpRemote(),
            slotEnd.then(function routeSlotClosed() { }),
        ]).catch(function closeFailedRoute(error) {
            disposeSlot();
            throw error;
        });
        slot = {
            label,
            ready: catchUpReady,
            close: closeSlot,
            closed: () => slotClosed,
        };
        if (timeoutMs != null) {
            slot.ready = new Promise(function boundRouteCatchUp(resolve, reject) {
                const timer = setTimeout(function routeCatchUpTimedOut() {
                    const error = new Error('route catch-up timeout: ' + (label ?? 'route'));
                    closeSlot();
                    reject(error);
                }, timeoutMs);
                catchUpReady.then(function routeCatchUpFinished() {
                    clearTimeout(timer);
                    resolve();
                }, function routeCatchUpFailed(error) {
                    clearTimeout(timer);
                    reject(error);
                });
            });
        }
        if (!slotClosed)
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
            if (from && from != slot)
                from.close();
            emitRoute({ phase: 'ready', from: fromLabel, to: toLabel, seq: lastDelivered });
        }
        catch (e) {
            slot.close();
            emitRoute({ phase: 'error', from: fromLabel, to: toLabel, seq: lastDelivered, error: e });
            reportRouteError(e);
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
        deliveryQueue.length = 0;
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
