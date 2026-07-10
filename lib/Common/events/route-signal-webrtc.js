"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignalHub = createSignalHub;
exports.channelFromDataChannel = channelFromDataChannel;
exports.createWebRtcConnector = createWebRtcConnector;
exports.acceptWebRtcDirect = acceptWebRtcDirect;
const Listen_1 = require("./Listen");
const replay_channel_1 = require("./replay-channel");
function createSignalHub(deps = {}) {
    const { authorize } = deps;
    const ports = new Map();
    function register(account) {
        const [emit, signals] = (0, Listen_1.listen)();
        const accountPorts = ports.get(account) ?? [];
        accountPorts.push(emit);
        ports.set(account, accountPorts);
        async function send(env) {
            if (env == null || env.from != account)
                return false;
            if (authorize && !(await authorize(env)))
                return false;
            const targets = ports.get(env.to);
            const target = targets?.[targets.length - 1];
            if (!target)
                return false;
            target(env);
            return true;
        }
        function close() {
            const accountPorts = ports.get(account);
            if (accountPorts) {
                const i = accountPorts.indexOf(emit);
                if (i >= 0)
                    accountPorts.splice(i, 1);
                if (!accountPorts.length)
                    ports.delete(account);
            }
            signals.close();
        }
        return { account, send, signals, close };
    }
    function revoke(pair, accounts, reason) {
        for (const account of accounts) {
            const accountPorts = ports.get(account);
            accountPorts?.[accountPorts.length - 1]?.({ type: 'revoke', pair, from: '', to: account, reason });
        }
    }
    return {
        register,
        revoke,
        accounts: () => Array.from(ports.keys()),
        close() {
            ports.clear();
        },
    };
}
function channelFromDataChannel(dc) {
    const msgCbs = new Set();
    const closeCbs = new Set();
    let closed = false;
    function fireClose() {
        if (closed)
            return;
        closed = true;
        for (const cb of Array.from(closeCbs))
            cb();
    }
    dc.onmessage = function onDcMessage(ev) {
        const data = String(ev.data);
        for (const cb of Array.from(msgCbs))
            cb(data);
    };
    dc.onclose = fireClose;
    dc.onerror = fireClose;
    return {
        send: data => dc.send(data),
        onMessage: cb => { msgCbs.add(cb); return () => msgCbs.delete(cb); },
        onClose: cb => { closeCbs.add(cb); return () => closeCbs.delete(cb); },
        close: () => { dc.close(); fireClose(); },
    };
}
function createWebRtcConnector(deps) {
    const { port, rtc, self, peer, pair, session, label = 'direct', openTimeoutMs = 10_000 } = deps;
    let state = 'idle';
    let pc = null;
    let channel = null;
    let offSignals = null;
    let abortOpen = null;
    const [emitFail, failListen] = (0, Listen_1.listen)();
    function teardown(next) {
        state = next;
        if (typeof offSignals == 'function')
            offSignals();
        else
            offSignals?.off?.();
        offSignals = null;
        channel?.close?.();
        channel = null;
        pc?.close();
        pc = null;
    }
    function fail(reason) {
        if (state == 'closed' || state == 'failed')
            return;
        const abort = abortOpen;
        abortOpen = null;
        teardown('failed');
        abort?.(reason instanceof Error ? reason : new Error(String(reason)));
        emitFail(reason);
    }
    async function open() {
        state = 'opening';
        const me = rtc();
        pc = me;
        const dc = me.createDataChannel('replay');
        let openTimer = null;
        const opened = new Promise((resolve, reject) => {
            abortOpen = reject;
            dc.onopen = () => resolve();
            openTimer = setTimeout(function webRtcOpenTimeout() {
                reject(new Error('webrtc direct open timeout: ' + pair));
            }, openTimeoutMs);
        });
        opened.catch(() => { });
        offSignals = port.signals.on(function onSignal(env) {
            if (env == null || env.pair != pair || env.to != self || pc != me)
                return;
            if (env.type == 'answer' && env.sdp != null) {
                void Promise.resolve(me.setRemoteDescription({ type: 'answer', sdp: env.sdp }))
                    .catch(fail);
                return;
            }
            if (env.type == 'ice' && env.candidate != null) {
                void Promise.resolve(me.addIceCandidate(env.candidate)).catch(fail);
                return;
            }
            if (env.type == 'revoke' || env.type == 'close') {
                fail(new Error('direct route ' + env.type + (env.reason ? ': ' + env.reason : '')));
            }
        });
        me.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                const c = ev.candidate;
                void port.send({ type: 'ice', pair, from: self, to: peer, candidate: c?.toJSON ? c.toJSON() : c });
            }
        };
        try {
            const offer = await me.createOffer();
            await me.setLocalDescription(offer);
            const accepted = await port.send({ type: 'offer', pair, from: self, to: peer, sdp: offer.sdp, session });
            if (accepted == false)
                throw new Error('signaling rejected offer (endpoint not exposed): ' + pair);
            await opened;
        }
        catch (e) {
            teardown('failed');
            throw e;
        }
        finally {
            clearTimeout(openTimer);
            abortOpen = null;
        }
        state = 'open';
        channel = channelFromDataChannel(dc);
        channel.onClose?.(function onDirectChannelDied() {
            if (state == 'open')
                fail(new Error('direct channel closed: ' + pair));
        });
        return (0, replay_channel_1.channelReplayRemote)(channel);
    }
    return {
        info: { label, kind: 'direct', binary: false, ordered: true, reliable: true },
        open,
        close() {
            if (state == 'closed')
                return;
            void port.send({ type: 'close', pair, from: self, to: peer });
            teardown('closed');
        },
        state: () => state,
        onFail: { on: cb => failListen.on(cb) },
    };
}
function acceptWebRtcDirect(deps) {
    const { port, rtc, self, serve, accept } = deps;
    const sessions = new Map();
    let closed = false;
    function dropSession(key) {
        const s = sessions.get(key);
        if (!s)
            return;
        sessions.delete(key);
        s.stop?.();
        s.pc.close();
    }
    async function onOffer(env) {
        const key = env.pair + '|' + env.from;
        if (accept && !(await accept(env))) {
            void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'offer rejected' });
            return;
        }
        const source = await serve(env);
        if (!source) {
            void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'nothing to serve' });
            return;
        }
        dropSession(key);
        const pc = rtc();
        const session = { pc, stop: null };
        sessions.set(key, session);
        pc.ondatachannel = function onIncomingChannel(ev) {
            session.stop = (0, replay_channel_1.serveReplayChannel)(source, channelFromDataChannel(ev.channel));
        };
        pc.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                const c = ev.candidate;
                void port.send({ type: 'ice', pair: env.pair, from: self, to: env.from, candidate: c?.toJSON ? c.toJSON() : c });
            }
        };
        try {
            await pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            void port.send({ type: 'answer', pair: env.pair, from: self, to: env.from, sdp: answer.sdp });
        }
        catch {
            dropSession(key);
            void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed' });
        }
    }
    const offSignals = port.signals.on(function onAcceptSignal(env) {
        if (closed || env == null || env.to != self)
            return;
        if (env.type == 'offer') {
            void onOffer(env);
            return;
        }
        const key = env.pair + '|' + env.from;
        if (env.type == 'ice' && env.candidate != null) {
            void Promise.resolve(sessions.get(key)?.pc.addIceCandidate(env.candidate)).catch(() => dropSession(key));
            return;
        }
        if (env.type == 'close' || env.type == 'revoke')
            dropSession(key);
    });
    return function closeAccept() {
        if (closed)
            return;
        closed = true;
        if (typeof offSignals == 'function')
            offSignals();
        else
            offSignals?.off?.();
        for (const key of Array.from(sessions.keys()))
            dropSession(key);
    };
}
