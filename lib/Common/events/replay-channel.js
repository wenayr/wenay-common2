"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serveReplayChannel = serveReplayChannel;
exports.channelReplayRemote = channelReplayRemote;
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
function serveReplayChannel(source, channel) {
    let lineOff = null;
    let closed = false;
    async function handleRequest(msg) {
        try {
            const v = msg.m == 'since' ? await source.since(msg.a[0])
                : msg.m == 'keyframe' ? await source.keyframe()
                    : msg.m == 'frame' ? (source.frame ? await source.frame(msg.a[0], msg.a[1]) : null)
                        : undefined;
            if (!closed)
                channel.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, v: v ?? null }));
        }
        catch (e) {
            if (!closed)
                channel.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, e: String(e) }));
        }
    }
    const offMsg = channel.onMessage(function onReplayChannelMessage(raw) {
        if (closed)
            return;
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (msg?.t == 'sub' && !lineOff) {
            lineOff = source.line.on(function forwardEnvelope(ev) {
                if (!closed)
                    channel.send(JSON.stringify({ t: 'ev', ev }));
            });
            return;
        }
        if (msg?.t == 'req')
            void handleRequest(msg);
    });
    function close() {
        if (closed)
            return;
        closed = true;
        unsubscribeHandle(lineOff);
        lineOff = null;
        if (typeof offMsg == 'function')
            offMsg();
    }
    channel.onClose?.(close);
    return close;
}
function channelReplayRemote(channel) {
    let nextId = 1;
    let subscribed = false;
    let closed = false;
    const pending = new Map();
    const lineCbs = new Set();
    channel.onMessage(function onRemoteChannelMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (msg?.t == 'ev') {
            for (const cb of Array.from(lineCbs))
                cb(msg.ev);
            return;
        }
        if (msg?.t == 'res') {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (!p)
                return;
            if (msg.ok)
                p.resolve(msg.v);
            else
                p.reject(new Error(msg.e ?? 'replay channel request failed'));
        }
    });
    channel.onClose?.(function onRemoteChannelClosed() {
        if (closed)
            return;
        closed = true;
        for (const [, p] of pending)
            p.reject(new Error('replay channel closed'));
        pending.clear();
        for (const cb of Array.from(lineCbs))
            cb(null);
        lineCbs.clear();
    });
    function req(m, a) {
        if (closed)
            return Promise.reject(new Error('replay channel closed'));
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            channel.send(JSON.stringify({ t: 'req', id, m, a }));
        });
    }
    return {
        line: {
            on(cb) {
                lineCbs.add(cb);
                if (!subscribed && !closed) {
                    subscribed = true;
                    channel.send(JSON.stringify({ t: 'sub' }));
                }
                return function offChannelLine() { lineCbs.delete(cb); };
            },
        },
        since: seq => req('since', [seq]),
        keyframe: () => req('keyframe', []),
        frame: (seq, hint) => req('frame', [seq, hint]),
    };
}
