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
    const binaryCbs = new Set();
    const closeCbs = new Set();
    let closed = false;
    dc.binaryType = 'arraybuffer';
    function fireClose() {
        if (closed)
            return;
        closed = true;
        for (const cb of Array.from(closeCbs))
            cb();
    }
    dc.onmessage = function onDcMessage(ev) {
        if (typeof ev.data == 'string') {
            for (const cb of Array.from(msgCbs))
                cb(ev.data);
            return;
        }
        const data = ev.data instanceof ArrayBuffer
            ? new Uint8Array(ev.data)
            : ArrayBuffer.isView(ev.data)
                ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength)
                : null;
        if (!data)
            return;
        for (const cb of Array.from(binaryCbs))
            cb(data);
    };
    dc.onclose = fireClose;
    dc.onerror = fireClose;
    return {
        send: data => dc.send(data),
        sendBinary: data => dc.send(data),
        onMessage: cb => { msgCbs.add(cb); return () => msgCbs.delete(cb); },
        onBinaryMessage: cb => { binaryCbs.add(cb); return () => binaryCbs.delete(cb); },
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
    let offerSent = false;
    let remoteDescriptionReady = false;
    const pendingLocalIce = [];
    const pendingRemoteIce = [];
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
        function sendLocalIce(candidate) {
            void port.send({ type: 'ice', pair, from: self, to: peer, candidate });
        }
        async function acceptAnswer(sdp) {
            await me.setRemoteDescription({ type: 'answer', sdp });
            if (pc != me)
                return;
            remoteDescriptionReady = true;
            while (pendingRemoteIce.length) {
                await me.addIceCandidate(pendingRemoteIce.shift());
                if (pc != me)
                    return;
            }
        }
        function acceptRemoteIce(candidate) {
            if (!remoteDescriptionReady) {
                pendingRemoteIce.push(candidate);
                return;
            }
            void Promise.resolve(me.addIceCandidate(candidate)).catch(fail);
        }
        offSignals = port.signals.on(function onSignal(env) {
            if (env == null || env.pair != pair || env.to != self || pc != me)
                return;
            if (env.type == 'answer' && env.sdp != null) {
                void acceptAnswer(env.sdp).catch(fail);
                return;
            }
            if (env.type == 'ice' && env.candidate != null) {
                acceptRemoteIce(env.candidate);
                return;
            }
            if (env.type == 'revoke' || env.type == 'close') {
                fail(new Error('direct route ' + env.type + (env.reason ? ': ' + env.reason : '')));
            }
        });
        me.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                const c = ev.candidate;
                const candidate = c?.toJSON ? c.toJSON() : c;
                if (offerSent)
                    sendLocalIce(candidate);
                else
                    pendingLocalIce.push(candidate);
            }
        };
        try {
            const offer = await me.createOffer();
            await me.setLocalDescription(offer);
            const accepted = await port.send({ type: 'offer', pair, from: self, to: peer, sdp: offer.sdp, session });
            if (accepted == false)
                throw new Error('signaling rejected offer (endpoint not exposed): ' + pair);
            offerSent = true;
            while (pendingLocalIce.length)
                sendLocalIce(pendingLocalIce.shift());
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
        info: { label, kind: 'direct', binary: true, ordered: true, reliable: true },
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
    const pendingOffers = new Map();
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
        const pendingIce = [];
        pendingOffers.set(key, pendingIce);
        let session = null;
        function currentOffer() {
            return pendingOffers.get(key) == pendingIce;
        }
        try {
            if (accept && !(await accept(env))) {
                if (currentOffer()) {
                    void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'offer rejected' });
                }
                return;
            }
            if (!currentOffer())
                return;
            const source = await serve(env);
            if (!currentOffer())
                return;
            if (!source) {
                void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'nothing to serve' });
                return;
            }
            dropSession(key);
            if (!currentOffer())
                return;
            const pc = rtc();
            session = { pc, stop: null, remoteDescriptionReady: false, pendingIce };
            sessions.set(key, session);
            pendingOffers.delete(key);
            pc.ondatachannel = function onIncomingChannel(ev) {
                session.stop = (0, replay_channel_1.serveReplayChannel)(source, channelFromDataChannel(ev.channel));
            };
            pc.onicecandidate = function onIce(ev) {
                if (ev?.candidate != null) {
                    const c = ev.candidate;
                    void port.send({ type: 'ice', pair: env.pair, from: self, to: env.from, candidate: c?.toJSON ? c.toJSON() : c });
                }
            };
            await pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
            if (sessions.get(key) != session)
                return;
            session.remoteDescriptionReady = true;
            while (session.pendingIce.length)
                await pc.addIceCandidate(session.pendingIce.shift());
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            void port.send({ type: 'answer', pair: env.pair, from: self, to: env.from, sdp: answer.sdp });
        }
        catch {
            if (session && sessions.get(key) == session) {
                dropSession(key);
                void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed' });
            }
            else if (!session && currentOffer()) {
                void port.send({ type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed' });
            }
        }
        finally {
            if (currentOffer())
                pendingOffers.delete(key);
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
            const session = sessions.get(key);
            if (!session) {
                pendingOffers.get(key)?.push(env.candidate);
                return;
            }
            if (!session.remoteDescriptionReady) {
                session.pendingIce.push(env.candidate);
                return;
            }
            void Promise.resolve(session.pc.addIceCandidate(env.candidate)).catch(() => dropSession(key));
            return;
        }
        if (env.type == 'close' || env.type == 'revoke') {
            pendingOffers.delete(key);
            dropSession(key);
        }
    });
    return function closeAccept() {
        if (closed)
            return;
        closed = true;
        if (typeof offSignals == 'function')
            offSignals();
        else
            offSignals?.off?.();
        pendingOffers.clear();
        for (const key of Array.from(sessions.keys()))
            dropSession(key);
    };
}
