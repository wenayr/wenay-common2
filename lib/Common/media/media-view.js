"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachVideoCanvas = attachVideoCanvas;
exports.attachAudioPlayer = attachAudioPlayer;
exports.pipeMediaPublish = pipeMediaPublish;
const media_source_1 = require("./media-source");
function makeOff(raw) {
    function unsubscribe(h) {
        if (typeof h == 'function')
            h();
        else
            h?.off?.();
    }
    return function off() {
        if (typeof raw == 'function') {
            raw();
            return;
        }
        if (raw != null && typeof raw.then == 'function') {
            void raw.then(unsubscribe);
            return;
        }
        unsubscribe(raw);
    };
}
function mimeForCodec(codec) {
    if (codec == 'png')
        return 'image/png';
    if (codec == 'webp')
        return 'image/webp';
    return 'image/jpeg';
}
function createAgeMeter() {
    let ageMs = 0;
    return {
        note(sentAt) {
            if (typeof sentAt != 'number')
                return;
            const age = Date.now() - sentAt;
            ageMs = ageMs ? Math.round(ageMs * 0.8 + age * 0.2) : age;
        },
        get ageMs() { return ageMs; },
    };
}
function createRateMeter() {
    let windowStart = 0;
    let windowCount = 0;
    let perSec = 0;
    return {
        note() {
            const now = Date.now();
            if (now - windowStart >= 1000) {
                perSec = windowStart ? windowCount : 0;
                windowStart = now;
                windowCount = 0;
            }
            windowCount++;
        },
        get perSec() { return perSec; },
    };
}
function attachVideoCanvas(line, canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('2d canvas context is not available');
    const makeBitmap = opts.createBitmap ?? function defaultBitmap(blob) {
        const create = globalThis.createImageBitmap;
        if (typeof create != 'function')
            throw new Error('createImageBitmap is not available');
        return create(blob);
    };
    const age = createAgeMeter();
    const rate = createRateMeter();
    let frames = 0;
    let drawn = 0;
    let width = 0;
    let height = 0;
    let busy = false;
    let closed = false;
    let bitmap = null;
    const detach = makeOff(line.on(async function onVideoFrame(raw, sentAt) {
        frames++;
        age.note(sentAt);
        rate.note();
        if (busy)
            return;
        busy = true;
        try {
            const f = (0, media_source_1.decodeMediaFrame)((0, media_source_1.toBytes)(raw));
            if (f.kind != 'video-frame' || !f.width || !f.height)
                return;
            const blobPayload = f.payload.buffer instanceof ArrayBuffer
                ? f.payload
                : f.payload.slice();
            bitmap = await makeBitmap(new Blob([blobPayload], { type: mimeForCodec(f.codec) }));
            if (closed)
                return;
            if (canvas.width != f.width)
                canvas.width = f.width;
            if (canvas.height != f.height)
                canvas.height = f.height;
            ctx.drawImage(bitmap, 0, 0);
            width = f.width;
            height = f.height;
            drawn++;
        }
        catch (e) {
            opts.onError?.(e);
        }
        finally {
            try {
                bitmap?.close?.();
            }
            catch (e) {
                opts.onError?.(e);
            }
            bitmap = null;
            busy = false;
        }
    }));
    function off() {
        if (closed)
            return;
        closed = true;
        detach();
    }
    return {
        stats: () => ({ frames, drawn, perSec: rate.perSec, ageMs: age.ageMs, width, height }),
        off,
    };
}
function attachAudioPlayer(line, opts = {}) {
    const maxBacklogSec = opts.maxBacklogSec ?? 0.35;
    const age = createAgeMeter();
    const rate = createRateMeter();
    let audioCtx = null;
    let playhead = 0;
    let frames = 0;
    let played = 0;
    let dropped = 0;
    function makeContext() {
        if (opts.audioContext)
            return opts.audioContext();
        const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!Ctor)
            throw new Error('AudioContext is not available');
        return new Ctor();
    }
    function toSamples(codec, payload) {
        const copy = payload.slice();
        if (codec == 'float32')
            return new Float32Array(copy.buffer);
        if (codec != 'pcm16')
            return null;
        const pcm = new Int16Array(copy.buffer);
        const out = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++)
            out[i] = pcm[i] / 0x8000;
        return out;
    }
    function push(raw) {
        const f = (0, media_source_1.decodeMediaFrame)((0, media_source_1.toBytes)(raw));
        if (f.kind != 'audio-pcm')
            return;
        const samples = toSamples(f.codec, f.payload);
        if (!samples)
            return;
        const channels = f.channels || 1;
        const sampleRate = f.sampleRate || 48000;
        const nFrames = Math.floor(samples.length / channels);
        if (!nFrames)
            return;
        if (playhead - audioCtx.currentTime > maxBacklogSec) {
            playhead = audioCtx.currentTime + 0.05;
            dropped++;
        }
        const buf = audioCtx.createBuffer(channels, nFrames, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            const chan = buf.getChannelData(ch);
            for (let i = 0; i < nFrames; i++)
                chan[i] = samples[i * channels + ch];
        }
        const node = audioCtx.createBufferSource();
        node.buffer = buf;
        node.connect(audioCtx.destination);
        const at = Math.max(audioCtx.currentTime + 0.05, playhead);
        node.start(at);
        playhead = at + nFrames / sampleRate;
        played++;
    }
    const off = makeOff(line.on(function onAudioFrame(raw, sentAt) {
        frames++;
        age.note(sentAt);
        rate.note();
        if (!audioCtx)
            return;
        try {
            push(raw);
        }
        catch (e) {
            opts.onError?.(e);
        }
    }));
    return {
        enable() {
            audioCtx = audioCtx ?? makeContext();
            playhead = 0;
            void audioCtx.resume?.();
        },
        disable() {
            void audioCtx?.close?.();
            audioCtx = null;
        },
        get enabled() { return !!audioCtx; },
        stats: () => ({ frames, played, dropped, perSec: rate.perSec, ageMs: age.ageMs }),
        off,
    };
}
function pipeMediaPublish(line, publish, opts = {}) {
    return line.on(function publishFrame(frame) {
        try {
            const result = publish(frame, opts.stamp == false ? undefined : Date.now());
            if (result != null
                && (typeof result == 'object' || typeof result == 'function')
                && typeof result.then == 'function') {
                Promise.resolve(result).catch(function onPublishFail(e) { opts.onError?.(e); });
            }
        }
        catch (e) {
            opts.onError?.(e);
        }
    });
}
