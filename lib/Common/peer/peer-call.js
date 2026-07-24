"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callPortOf = callPortOf;
exports.createCallManager = createCallManager;
const Listen_1 = require("../events/Listen");
function callPortOf(remote) {
    return {
        send: env => remote.signal.send(env),
        signals: { on: cb => remote.signal.signals.on(cb) },
    };
}
function createCallManager(deps) {
    const { port, self, ringTimeoutMs = 30_000, incoming } = deps;
    const [emitRing, rings] = (0, Listen_1.listen)();
    const calls = new Map();
    let n = 0;
    const callScope = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    let evaluatingIncoming = 0;
    let closed = false;
    function makeCall(pair, other, direction, meta) {
        let state = 'ringing';
        let reason = null;
        const [emitChange, changed] = (0, Listen_1.listen)();
        let resolveEnded;
        const ended = new Promise(r => { resolveEnded = r; });
        const ringTimer = setTimeout(function onRingTimeout() { finish('timeout', direction == 'out'); }, ringTimeoutMs);
        function send(type, why) {
            void Promise.resolve(port.send({ type, pair, from: self, to: other, reason: why })).catch(swallowSendError);
        }
        function finish(why, notify, notifyAs = 'hangup') {
            if (state == 'ended')
                return;
            state = 'ended';
            reason = why;
            clearTimeout(ringTimer);
            calls.delete(pair);
            if (notify)
                send(notifyAs, why);
            emitChange('ended');
            changed.close();
            resolveEnded(why);
        }
        function activate() {
            if (state != 'ringing')
                return;
            state = 'active';
            clearTimeout(ringTimer);
            emitChange('active');
        }
        const handle = {
            id: pair,
            peer: other,
            direction,
            meta,
            state: () => state,
            reason: () => reason,
            changed,
            ended,
            accept() {
                if (direction != 'in' || state != 'ringing')
                    return;
                send('accept');
                activate();
            },
            decline(why = 'declined') {
                if (direction != 'in' || state != 'ringing')
                    return;
                finish(why, true, 'decline');
            },
            hangup() {
                finish(state == 'ringing' && direction == 'out' ? 'canceled' : 'hangup', true);
            },
        };
        return { handle, activate, finish };
    }
    function swallowSendError() { }
    function hasLiveCall() {
        for (const c of calls.values())
            if (c.handle.state() != 'ended')
                return true;
        return false;
    }
    function call(other, meta) {
        if (closed)
            throw new Error('call manager is closed');
        const pair = 'call:' + self + ':' + callScope + ':' + (++n);
        const made = makeCall(pair, other, 'out', meta);
        calls.set(pair, made);
        Promise.resolve(port.send({ type: 'ring', pair, from: self, to: other, session: meta }))
            .then(function onRingVerdict(accepted) {
            if (accepted == false)
                made.finish('offline', false);
        }, function onRingSendError() { made.finish('offline', false); });
        return made.handle;
    }
    async function onRing(env) {
        if (calls.has(env.pair))
            return;
        evaluatingIncoming++;
        const gate = incoming ?? function defaultBusyGate() {
            return evaluatingIncoming == 1 && !hasLiveCall();
        };
        let allowed = false;
        try {
            allowed = !!(await gate({ peer: env.from, meta: env.session }));
        }
        catch {
            allowed = false;
        }
        finally {
            evaluatingIncoming--;
        }
        if (closed)
            return;
        if (!allowed) {
            void Promise.resolve(port.send({ type: 'decline', pair: env.pair, from: self, to: env.from, reason: 'busy' })).catch(swallowSendError);
            return;
        }
        const made = makeCall(env.pair, env.from, 'in', env.session);
        calls.set(env.pair, made);
        emitRing(made.handle);
    }
    const readyProbe = 'call-ready:' + self;
    let resolveReady;
    const ready = new Promise(r => { resolveReady = r; });
    let readySettled = false;
    function settleReady() {
        if (readySettled)
            return;
        readySettled = true;
        resolveReady();
    }
    const offSignals = port.signals.on(function onCallSignal(env) {
        if (closed || env == null || env.to != self)
            return;
        if (env.pair == readyProbe) {
            settleReady();
            return;
        }
        if (env.type == 'ring') {
            void onRing(env);
            return;
        }
        const live = calls.get(env.pair);
        if (!live)
            return;
        if (env.type == 'accept') {
            live.activate();
            return;
        }
        if (env.type == 'decline') {
            live.finish(env.reason ?? 'declined', false);
            return;
        }
        if (env.type == 'hangup') {
            live.finish(live.handle.state() == 'ringing' ? 'canceled' : 'hangup', false);
        }
    });
    Promise.resolve(port.send({ type: 'close', pair: readyProbe, from: self, to: self }))
        .then(function onProbeVerdict(v) { if (v == false)
        settleReady(); }, settleReady);
    return {
        ready,
        call,
        rings,
        active: () => Array.from(calls.values()).map(c => c.handle).find(h => h.state() == 'active') ?? null,
        close() {
            if (closed)
                return;
            closed = true;
            settleReady();
            if (typeof offSignals == 'function')
                offSignals();
            else
                offSignals?.off?.();
            for (const c of Array.from(calls.values()))
                c.finish('closed', true);
            rings.close();
        },
    };
}
