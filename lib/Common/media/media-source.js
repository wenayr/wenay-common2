"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MEDIA_FRAME_HEADER_BYTES = exports.MEDIA_FRAME_VERSION = exports.MEDIA_FRAME_MAGIC = void 0;
exports.toBytes = toBytes;
exports.encodeMediaFrame = encodeMediaFrame;
exports.decodeMediaFrame = decodeMediaFrame;
exports.createAudioSource = createAudioSource;
exports.createVideoSource = createVideoSource;
const Listen_1 = require("../events/Listen");
const replay_listen_1 = require("../events/replay-listen");
exports.MEDIA_FRAME_MAGIC = 0x57434d32;
exports.MEDIA_FRAME_VERSION = 1;
exports.MEDIA_FRAME_HEADER_BYTES = 40;
const KIND_TO_CODE = {
    'audio-pcm': 1,
    'audio-record': 2,
    'video-frame': 3,
};
const CODE_TO_KIND = {
    1: 'audio-pcm',
    2: 'audio-record',
    3: 'video-frame',
};
const CODEC_TO_CODE = {
    pcm16: 1,
    float32: 2,
    jpeg: 10,
    png: 11,
    webp: 12,
    'webm-opus': 20,
};
const CODE_TO_CODEC = {
    1: 'pcm16',
    2: 'float32',
    10: 'jpeg',
    11: 'png',
    12: 'webp',
    20: 'webm-opus',
};
function nowMono() {
    const perf = globalThis.performance;
    return typeof perf?.now == 'function' ? perf.now() : Date.now();
}
function toBytes(data) {
    if (ArrayBuffer.isView(data))
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}
function clonePayload(data) {
    const src = toBytes(data);
    const out = new Uint8Array(src.byteLength);
    out.set(src);
    return out;
}
function writeU32(view, offset, value) {
    view.setUint32(offset, Math.max(0, Math.min(0xffffffff, Math.floor(value ?? 0))), true);
}
function readPayload(frame, headerBytes) {
    return frame.subarray(headerBytes);
}
function encodeMediaFrame(meta, payload) {
    const body = toBytes(payload);
    const out = new Uint8Array(exports.MEDIA_FRAME_HEADER_BYTES + body.byteLength);
    const view = new DataView(out.buffer, out.byteOffset, exports.MEDIA_FRAME_HEADER_BYTES);
    view.setUint32(0, exports.MEDIA_FRAME_MAGIC, true);
    view.setUint8(4, exports.MEDIA_FRAME_VERSION);
    view.setUint8(5, KIND_TO_CODE[meta.kind]);
    view.setUint8(6, CODEC_TO_CODE[meta.codec]);
    view.setUint8(7, 0);
    view.setUint16(8, exports.MEDIA_FRAME_HEADER_BYTES, true);
    view.setUint16(10, 0, true);
    writeU32(view, 12, meta.seq);
    view.setFloat64(16, meta.tMono, true);
    if (meta.kind == 'video-frame') {
        writeU32(view, 24, meta.width);
        writeU32(view, 28, meta.height);
    }
    else {
        writeU32(view, 24, meta.sampleRate);
        writeU32(view, 28, meta.channels);
        writeU32(view, 32, meta.nSamples);
    }
    writeU32(view, 36, body.byteLength);
    out.set(body, exports.MEDIA_FRAME_HEADER_BYTES);
    return out;
}
function decodeMediaFrame(frameLike) {
    const frame = toBytes(frameLike);
    if (frame.byteLength < exports.MEDIA_FRAME_HEADER_BYTES)
        throw new Error('media frame too short');
    const view = new DataView(frame.buffer, frame.byteOffset, exports.MEDIA_FRAME_HEADER_BYTES);
    if (view.getUint32(0, true) != exports.MEDIA_FRAME_MAGIC)
        throw new Error('media frame magic mismatch');
    const version = view.getUint8(4);
    if (version != exports.MEDIA_FRAME_VERSION)
        throw new Error(`media frame version ${version} is not supported`);
    const kind = CODE_TO_KIND[view.getUint8(5)];
    const codec = CODE_TO_CODEC[view.getUint8(6)];
    if (!kind || !codec)
        throw new Error('media frame kind/codec is not supported');
    const headerBytes = view.getUint16(8, true);
    if (headerBytes < exports.MEDIA_FRAME_HEADER_BYTES || headerBytes > frame.byteLength)
        throw new Error('media frame header size is invalid');
    const payloadBytes = view.getUint32(36, true);
    const payload = readPayload(frame, headerBytes);
    if (payload.byteLength != payloadBytes)
        throw new Error('media frame payload size mismatch');
    const base = {
        kind,
        codec,
        seq: view.getUint32(12, true),
        tMono: view.getFloat64(16, true),
        payload,
    };
    if (kind == 'video-frame') {
        return {
            ...base,
            width: view.getUint32(24, true),
            height: view.getUint32(28, true),
        };
    }
    return {
        ...base,
        sampleRate: view.getUint32(24, true),
        channels: view.getUint32(28, true),
        nSamples: view.getUint32(32, true),
    };
}
function createStats(sourceId, kind) {
    return {
        sourceId,
        kind,
        state: 'idle',
        seq: 0,
        frames: 0,
        bytes: 0,
        dropped: 0,
        startedAt: 0,
        lastAt: 0,
        fps: 0,
    };
}
function hasGetUserMedia() {
    const nav = globalThis.navigator;
    return typeof nav?.mediaDevices?.getUserMedia == 'function';
}
async function listDevices(kind) {
    const nav = globalThis.navigator;
    if (typeof nav?.mediaDevices?.enumerateDevices != 'function')
        return [];
    const devices = await nav.mediaDevices.enumerateDevices();
    const prefix = kind == 'audio' ? 'audioinput' : 'videoinput';
    return devices
        .filter(d => d?.kind == prefix)
        .map(d => ({ deviceId: String(d.deviceId ?? ''), label: String(d.label ?? ''), kind: String(d.kind ?? '') }));
}
function stopTracks(stream) {
    const tracks = typeof stream?.getTracks == 'function' ? stream.getTracks() : [];
    for (const track of tracks)
        track.stop?.();
}
function stateFromMediaError(e) {
    const name = String(e?.name ?? '');
    if (name == 'NotAllowedError' || name == 'SecurityError' || name == 'PermissionDeniedError')
        return 'denied';
    if (name == 'NotFoundError' || name == 'DevicesNotFoundError')
        return 'no-device';
    return 'error';
}
function defaultReplayOptions(kind) {
    if (kind == 'video') {
        return {
            history: 8,
            current: 'last',
            frame: tail => tail.length ? [tail[tail.length - 1]] : [],
        };
    }
    return { history: 1024 };
}
function createSourceShell(kind, sourceId, transport, replay) {
    const replayOpts = replay == true ? defaultReplayOptions(kind) : replay;
    const [emit, listenApi] = replayOpts ? (0, replay_listen_1.replayListen)(replayOpts) : (0, Listen_1.listen)();
    const stats = createStats(sourceId, kind);
    let state = 'idle';
    let error;
    function setState(next, err) {
        state = next;
        stats.state = next;
        error = err ? String(err?.message ?? err) : undefined;
        stats.error = error;
    }
    function emitFrame(frame, seq) {
        stats.seq = seq;
        stats.frames++;
        stats.bytes += frame.byteLength;
        stats.lastAt = nowMono();
        const age = Math.max(1, stats.lastAt - (stats.startedAt || stats.lastAt));
        stats.fps = Math.round((stats.frames * 10000) / age) / 10;
        emit(frame);
    }
    return { emit, listenApi, stats, get state() { return state; }, get error() { return error; }, setState, emitFrame };
}
function attachControl(pair, control) {
    Object.defineProperties(pair, Object.getOwnPropertyDescriptors(control));
    return pair;
}
function ensureSocketTransport(mode) {
    if (mode == 'webrtc') {
        throw new Error('WebRTC media transport is reserved for a future opt-in SFU/signaling adapter; use transport:"socket" today');
    }
}
function int16PcmFromFloat(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const x = Math.max(-1, Math.min(1, input[i]));
        out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    return new Uint8Array(out.buffer);
}
function interleaveChannels(buffers, frames, channels) {
    const out = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < channels; ch++)
            out[i * channels + ch] = buffers[ch]?.[i] ?? 0;
    }
    return out;
}
function rmsOf(input) {
    if (input.length == 0)
        return 0;
    let sum = 0;
    for (let i = 0; i < input.length; i++)
        sum += input[i] * input[i];
    return Math.sqrt(sum / input.length);
}
function audioWorkletCode() {
    return `
class WenayCommon2PcmProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0]
        if (!input || !input.length || !input[0]) return true
        const channels = input.length
        const frames = input[0].length
        const out = new Float32Array(frames * channels)
        for (let i = 0; i < frames; i++) {
            for (let ch = 0; ch < channels; ch++) out[i * channels + ch] = input[ch] ? input[ch][i] : 0
        }
        this.port.postMessage({sampleRate, channels, frames, samples: out}, [out.buffer])
        return true
    }
}
registerProcessor('wenay-common2-pcm', WenayCommon2PcmProcessor)
`;
}
function createAudioSource(opts = {}) {
    const sourceId = opts.sourceId ?? 'audio';
    const transport = opts.transport ?? 'socket';
    const shell = createSourceShell('audio', sourceId, transport, opts.replay);
    let deviceId = opts.deviceId;
    let stream = null;
    let audioCtx = null;
    let mediaNode = null;
    let workletNode = null;
    let recorder = null;
    let seq = 0;
    function emitPcm(samples, sampleRate, channels, frames) {
        const codec = opts.format == 'float32' ? 'float32' : 'pcm16';
        const payload = codec == 'float32' ? new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength) : int16PcmFromFloat(samples);
        shell.stats.rms = rmsOf(samples);
        shell.emitFrame(encodeMediaFrame({
            kind: 'audio-pcm',
            codec,
            seq: ++seq,
            tMono: nowMono(),
            sampleRate,
            channels,
            nSamples: frames,
        }, payload), seq);
    }
    async function startPcm(nextStream) {
        const AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AudioContextCtor)
            throw new Error('AudioContext is not available');
        audioCtx = new AudioContextCtor(opts.sampleRate ? { sampleRate: opts.sampleRate } : undefined);
        mediaNode = audioCtx.createMediaStreamSource(nextStream);
        if (opts.worklet != false && audioCtx.audioWorklet && globalThis.Blob && globalThis.URL) {
            const blob = new globalThis.Blob([audioWorkletCode()], { type: 'text/javascript' });
            const url = globalThis.URL.createObjectURL(blob);
            try {
                await audioCtx.audioWorklet.addModule(url);
            }
            finally {
                globalThis.URL.revokeObjectURL(url);
            }
            const AudioWorkletNodeCtor = globalThis.AudioWorkletNode;
            workletNode = new AudioWorkletNodeCtor(audioCtx, 'wenay-common2-pcm', {
                numberOfInputs: 1,
                numberOfOutputs: 0,
                channelCount: opts.channels ?? 1,
            });
            workletNode.port.onmessage = function onWorkletSamples(ev) {
                const data = ev.data ?? {};
                emitPcm(data.samples, data.sampleRate ?? audioCtx.sampleRate, data.channels ?? 1, data.frames ?? 0);
            };
            mediaNode.connect(workletNode);
            return;
        }
        const channels = opts.channels ?? 1;
        const processor = audioCtx.createScriptProcessor(opts.bufferSize ?? 2048, channels, channels);
        processor.onaudioprocess = function onAudioProcess(ev) {
            const input = ev.inputBuffer;
            const frames = input.length;
            const buffers = [];
            for (let ch = 0; ch < channels; ch++)
                buffers.push(input.getChannelData(Math.min(ch, input.numberOfChannels - 1)));
            emitPcm(interleaveChannels(buffers, frames, channels), input.sampleRate ?? audioCtx.sampleRate, channels, frames);
            const out = ev.outputBuffer;
            if (out)
                for (let ch = 0; ch < out.numberOfChannels; ch++)
                    out.getChannelData(ch).fill(0);
        };
        mediaNode.connect(processor);
        processor.connect(audioCtx.destination);
        workletNode = processor;
    }
    function startRecord(nextStream) {
        const Recorder = globalThis.MediaRecorder;
        if (!Recorder)
            throw new Error('MediaRecorder is not available');
        const mimeType = opts.recordMimeType ?? 'audio/webm;codecs=opus';
        recorder = new Recorder(nextStream, Recorder.isTypeSupported?.(mimeType) ? { mimeType } : undefined);
        recorder.ondataavailable = async function onRecordChunk(ev) {
            if (!ev.data || ev.data.size == 0)
                return;
            const payload = new Uint8Array(await ev.data.arrayBuffer());
            shell.emitFrame(encodeMediaFrame({
                kind: 'audio-record',
                codec: 'webm-opus',
                seq: ++seq,
                tMono: nowMono(),
            }, payload), seq);
        };
        recorder.start(opts.recordTimesliceMs ?? 1000);
    }
    function stop() {
        recorder?.stop?.();
        recorder = null;
        workletNode?.disconnect?.();
        mediaNode?.disconnect?.();
        audioCtx?.close?.();
        stopTracks(stream);
        stream = null;
        audioCtx = null;
        mediaNode = null;
        workletNode = null;
        shell.setState('idle');
    }
    async function start() {
        try {
            ensureSocketTransport(transport);
            if (!opts.stream && !hasGetUserMedia()) {
                shell.setState('no-device');
                return shell.state;
            }
            stop();
            shell.setState('requesting');
            shell.stats.startedAt = nowMono();
            const constraints = { audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: opts.channels, sampleRate: opts.sampleRate } };
            stream = await resolveMediaStream(opts.stream, () => globalThis.navigator.mediaDevices.getUserMedia(constraints));
            if (opts.mode == 'record')
                startRecord(stream);
            else
                await startPcm(stream);
            shell.setState('live');
            return shell.state;
        }
        catch (e) {
            stopTracks(stream);
            stream = null;
            shell.setState(stateFromMediaError(e), e);
            return shell.state;
        }
    }
    const control = {
        start,
        stop,
        getStats: () => ({ ...shell.stats }),
        setDevice: async (id) => {
            deviceId = id;
            return shell.state == 'live' ? start() : shell.state;
        },
        listDevices: () => listDevices('audio'),
        get state() { return shell.state; },
        sourceId,
        kind: 'audio',
        transport,
    };
    return attachControl([shell.emit, shell.listenApi], control);
}
async function resolveMediaStream(injected, fallback) {
    if (!injected)
        return fallback();
    return typeof injected == 'function' ? await injected() : injected;
}
function videoEncodeWorkerCode() {
    return `
const canvas = new OffscreenCanvas(1, 1)
const ctx = canvas.getContext('2d')
onmessage = async function onEncodeRequest(ev) {
    const req = ev.data
    try {
        const resized = canvas.width != req.w || canvas.height != req.h
        if (canvas.width != req.w) canvas.width = req.w
        if (canvas.height != req.h) canvas.height = req.h
        // Resizing clears the bitmap. Reused canvases need the same semantic
        // reset so transparent PNG/WebP pixels cannot expose the prior frame.
        if (!resized) ctx.clearRect(0, 0, req.w, req.h)
        ctx.drawImage(req.bitmap, 0, 0, req.w, req.h)
        req.bitmap.close()
        const blob = await canvas.convertToBlob({type: req.mime, quality: req.quality})
        const buf = await blob.arrayBuffer()
        postMessage({buf}, [buf])
    } catch (e) {
        postMessage({error: String((e && e.message) || e)})
    }
}
`;
}
function startCaptureTicker(ms, tick, useWorker) {
    const g = globalThis;
    if (useWorker && g.Worker && g.Blob && g.URL) {
        try {
            const blob = new g.Blob([`setInterval(function () { postMessage(0) }, ${ms})`], { type: 'text/javascript' });
            const url = g.URL.createObjectURL(blob);
            const worker = new g.Worker(url);
            worker.onmessage = function onCaptureTick() { tick(); };
            return function stopWorkerTicker() {
                worker.terminate();
                g.URL.revokeObjectURL(url);
            };
        }
        catch {
        }
    }
    const timer = setInterval(tick, ms);
    return function stopIntervalTicker() { clearInterval(timer); };
}
function startCapturePump(tick, useWorker) {
    const g = globalThis;
    let stopped = false;
    if (useWorker && g.Worker && g.Blob && g.URL) {
        try {
            const blob = new g.Blob(['onmessage = function () { postMessage(0) }'], { type: 'text/javascript' });
            const url = g.URL.createObjectURL(blob);
            const worker = new g.Worker(url);
            g.URL.revokeObjectURL(url);
            worker.onmessage = async function onCapturePumpTick() {
                const next = await tick();
                if (!stopped && next)
                    worker.postMessage(0);
            };
            worker.postMessage(0);
            return function stopWorkerPump() {
                stopped = true;
                worker.terminate();
            };
        }
        catch {
        }
    }
    let timer = null;
    async function captureNext() {
        const next = await tick();
        if (!stopped && next)
            timer = setTimeout(captureNext, 0);
    }
    void captureNext();
    return function stopTaskPump() {
        stopped = true;
        if (timer != null)
            clearTimeout(timer);
    };
}
function mimeForVideo(codec) {
    if (codec == 'png')
        return 'image/png';
    if (codec == 'webp')
        return 'image/webp';
    return 'image/jpeg';
}
function canvasToBlob(canvas, mime, quality) {
    if (typeof canvas.convertToBlob == 'function')
        return canvas.convertToBlob({ type: mime, quality });
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob != 'function') {
            reject(new Error('canvas.toBlob is not available'));
            return;
        }
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null')), mime, quality);
    });
}
function createVideoSource(opts = {}) {
    const sourceId = opts.sourceId ?? 'video';
    const transport = opts.transport ?? 'socket';
    const shell = createSourceShell('video', sourceId, transport, opts.replay);
    let deviceId = opts.deviceId;
    let stream = null;
    let video = opts.video;
    let canvas = opts.canvas;
    let ctx = null;
    let stopTicker = null;
    let imageCapture = null;
    let encodeWorker = null;
    let rejectEncode = null;
    let captureTask = null;
    let generation = 0;
    let seq = 0;
    async function grabBitmap() {
        if (imageCapture) {
            try {
                return await imageCapture.grabFrame();
            }
            catch { }
        }
        return null;
    }
    function emitVideoFrame(payload, codec, w, h) {
        shell.emitFrame(encodeMediaFrame({
            kind: 'video-frame',
            codec,
            seq: ++seq,
            tMono: nowMono(),
            width: w,
            height: h,
        }, payload), seq);
    }
    function encodeInWorker(bitmap, w, h, mime, quality) {
        const worker = encodeWorker;
        if (!worker)
            return Promise.reject(new Error('video encode worker is not available'));
        return new Promise(function encodeRoundtrip(resolve, reject) {
            let settled = false;
            function finish(error, value) {
                if (settled)
                    return;
                settled = true;
                if (rejectEncode == failEncode)
                    rejectEncode = null;
                worker.onmessage = null;
                worker.onerror = null;
                if (error)
                    reject(error);
                else
                    resolve(value);
            }
            function failEncode(error) {
                finish(error);
            }
            rejectEncode = failEncode;
            worker.onmessage = function encodedVideoFrame(ev) {
                if (ev.data?.error)
                    finish(new Error(ev.data.error));
                else
                    finish(undefined, ev.data.buf);
            };
            worker.onerror = function videoWorkerFailed(e) {
                finish(new Error(String(e?.message ?? 'video encode worker error')));
            };
            try {
                worker.postMessage({ bitmap, w, h, mime, quality }, [bitmap]);
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    async function captureFrame(run) {
        let bitmap = null;
        try {
            bitmap = await grabBitmap();
            if (run != generation || shell.state != 'live') {
                bitmap?.close?.();
                return false;
            }
            const srcW = (bitmap ? bitmap.width : video.videoWidth ?? video.width) ?? 0;
            const srcH = (bitmap ? bitmap.height : video.videoHeight ?? video.height) ?? 0;
            let w = opts.width ?? srcW;
            let h = opts.height ?? srcH;
            if (srcW && srcH) {
                if (opts.width && opts.height == undefined) {
                    w = Math.min(opts.width, srcW);
                    h = Math.round(w * srcH / srcW);
                }
                else if (opts.height && opts.width == undefined) {
                    h = Math.min(opts.height, srcH);
                    w = Math.round(h * srcW / srcH);
                }
            }
            if (!w || !h) {
                bitmap?.close?.();
                return true;
            }
            const codec = opts.codec ?? 'jpeg';
            const quality = opts.quality ?? 0.82;
            if (encodeWorker && bitmap) {
                const pending = encodeInWorker(bitmap, w, h, mimeForVideo(codec), quality);
                bitmap = null;
                const buf = await pending;
                if (run != generation || shell.state != 'live')
                    return false;
                emitVideoFrame(new Uint8Array(buf), codec, w, h);
            }
            else {
                if (canvas.width != w)
                    canvas.width = w;
                if (canvas.height != h)
                    canvas.height = h;
                ctx.drawImage(bitmap ?? video, 0, 0, w, h);
                bitmap?.close?.();
                bitmap = null;
                const blob = await canvasToBlob(canvas, mimeForVideo(codec), quality);
                const buf = await blob.arrayBuffer();
                if (run != generation || shell.state != 'live')
                    return false;
                emitVideoFrame(new Uint8Array(buf), codec, w, h);
            }
            return true;
        }
        catch (e) {
            try {
                bitmap?.close?.();
            }
            catch { }
            if (run == generation && shell.state == 'live') {
                generation++;
                releaseCaptureResources();
                shell.setState('error', e);
            }
            return false;
        }
    }
    function captureOne(run = generation) {
        if (captureTask || run != generation || shell.state != 'live') {
            if (run == generation && shell.state == 'live')
                shell.stats.dropped++;
            return Promise.resolve(false);
        }
        let task;
        task = captureFrame(run).finally(function captureSettled() {
            if (captureTask == task)
                captureTask = null;
        });
        captureTask = task;
        return task;
    }
    function releaseCaptureResources() {
        stopTicker?.();
        stopTicker = null;
        imageCapture = null;
        rejectEncode?.(new Error('video capture stopped'));
        rejectEncode = null;
        encodeWorker?.terminate?.();
        encodeWorker = null;
        stopTracks(stream);
        stream = null;
        if (!opts.video && video) {
            try {
                video.srcObject = null;
            }
            catch { }
        }
    }
    function stop() {
        generation++;
        releaseCaptureResources();
        shell.setState('idle');
    }
    async function start() {
        let nextStream = null;
        let run = generation;
        try {
            ensureSocketTransport(transport);
            if (!opts.stream && !hasGetUserMedia()) {
                shell.setState('no-device');
                return shell.state;
            }
            const doc = globalThis.document;
            if (!video && !doc?.createElement) {
                shell.setState('error', 'document.createElement is not available');
                return shell.state;
            }
            stop();
            run = generation;
            const previousCapture = captureTask;
            if (previousCapture)
                await previousCapture;
            if (run != generation)
                return shell.state;
            shell.setState('requesting');
            shell.stats.startedAt = nowMono();
            nextStream = await resolveMediaStream(opts.stream, () => globalThis.navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    width: opts.width,
                    height: opts.height,
                },
            }));
            if (run != generation) {
                stopTracks(nextStream);
                return shell.state;
            }
            stream = nextStream;
            video = video ?? doc.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.srcObject = stream;
            await video.play?.();
            if (run != generation) {
                stopTracks(nextStream);
                if (stream == nextStream)
                    stream = null;
                return shell.state;
            }
            const track = stream?.getVideoTracks?.()?.[0];
            const ImageCaptureCtor = globalThis.ImageCapture;
            try {
                imageCapture = track && typeof ImageCaptureCtor == 'function' ? new ImageCaptureCtor(track) : null;
            }
            catch {
                imageCapture = null;
            }
            const g = globalThis;
            if (opts.worker != false && imageCapture && g.Worker && g.Blob && g.URL && g.OffscreenCanvas) {
                try {
                    const blob = new g.Blob([videoEncodeWorkerCode()], { type: 'text/javascript' });
                    const url = g.URL.createObjectURL(blob);
                    encodeWorker = new g.Worker(url);
                    g.URL.revokeObjectURL(url);
                }
                catch {
                    encodeWorker = null;
                }
            }
            const OffscreenCanvasCtor = g.OffscreenCanvas;
            canvas = canvas ?? (OffscreenCanvasCtor ? new OffscreenCanvasCtor(1, 1) : doc.createElement('canvas'));
            ctx = canvas.getContext('2d');
            if (!ctx)
                throw new Error('2d canvas context is not available');
            shell.setState('live');
            await captureOne(run);
            if (run == generation && shell.state == 'live') {
                if (opts.fps == 0) {
                    stopTicker = startCapturePump(function captureUnpacedFrame() { return captureOne(run); }, opts.worker != false);
                }
                else {
                    stopTicker = startCaptureTicker(Math.max(1, Math.round(1000 / (opts.fps ?? 3))), function captureScheduledFrame() { void captureOne(run); }, opts.worker != false);
                }
            }
            return shell.state;
        }
        catch (e) {
            if (run == generation) {
                stop();
                shell.setState(stateFromMediaError(e), e);
            }
            else
                stopTracks(nextStream);
            return shell.state;
        }
    }
    const control = {
        start,
        stop,
        getStats: () => ({ ...shell.stats }),
        setDevice: async (id) => {
            deviceId = id;
            return shell.state == 'live' ? start() : shell.state;
        },
        listDevices: () => listDevices('video'),
        get state() { return shell.state; },
        sourceId,
        kind: 'video',
        transport,
    };
    return attachControl([shell.emit, shell.listenApi], control);
}
