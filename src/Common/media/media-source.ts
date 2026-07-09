import {Listener, ListenApi, listen} from '../events/Listen'
import {ListenReplayApi, ReplayListenUseOptions, replayListen} from '../events/replay-listen'

export type MediaSourceKind = 'audio' | 'video'
export type MediaSourceState = 'idle' | 'requesting' | 'live' | 'denied' | 'no-device' | 'error'
export type MediaFrameKind = 'audio-pcm' | 'audio-record' | 'video-frame'
export type MediaFrameCodec = 'pcm16' | 'float32' | 'jpeg' | 'png' | 'webp' | 'webm-opus'
export type MediaTransportMode = 'socket' | 'webrtc'

export type MediaSourceDevice = {
    deviceId: string
    label: string
    kind: string
}

export type MediaReplayOpts = true | ReplayListenUseOptions<[Uint8Array]>

export type AudioSourceOpts = {
    sourceId?: string
    deviceId?: string
    /** Bring your own MediaStream (or a factory): skips getUserMedia — tab audio, mixed streams, tests. */
    stream?: any
    mode?: 'pcm' | 'record'
    format?: 'int16' | 'float32'
    channels?: number
    sampleRate?: number
    worklet?: boolean
    bufferSize?: number
    recordMimeType?: string
    recordTimesliceMs?: number
    transport?: MediaTransportMode
    replay?: MediaReplayOpts
}

export type VideoSourceOpts = {
    sourceId?: string
    deviceId?: string
    /** Bring your own MediaStream (or a factory): skips getUserMedia — screen share (getDisplayMedia), canvas capture, tests. */
    stream?: any
    fps?: number
    width?: number
    height?: number
    codec?: 'jpeg' | 'png' | 'webp'
    quality?: number
    video?: any
    canvas?: any
    worker?: false | {transferable?: true}
    transport?: MediaTransportMode
    replay?: MediaReplayOpts
}

export type MediaStats = {
    sourceId: string
    kind: MediaSourceKind
    state: MediaSourceState
    seq: number
    frames: number
    bytes: number
    dropped: number
    startedAt: number
    lastAt: number
    fps: number
    rms?: number
    error?: string
}

export type MediaSourceControl = {
    start(): Promise<MediaSourceState>
    stop(): void
    getStats(): MediaStats
    setDevice(id: string): Promise<MediaSourceState>
    listDevices(): Promise<MediaSourceDevice[]>
    readonly state: MediaSourceState
    readonly sourceId: string
    readonly kind: MediaSourceKind
    readonly transport: MediaTransportMode
}

export type MediaListen = ListenApi<[Uint8Array]>
export type MediaReplayListen = ListenReplayApi<[Uint8Array]>
export type MediaAnyListen = MediaListen | MediaReplayListen
export type MediaEmit = Listener<[Uint8Array]>
export type MediaSource = readonly [MediaEmit, MediaAnyListen] & MediaSourceControl

export type MediaFrameMeta = {
    kind: MediaFrameKind
    codec: MediaFrameCodec
    seq: number
    tMono: number
    sampleRate?: number
    channels?: number
    nSamples?: number
    width?: number
    height?: number
}

export type DecodedMediaFrame = MediaFrameMeta & {
    payload: Uint8Array
}

export const MEDIA_FRAME_MAGIC = 0x57434d32
export const MEDIA_FRAME_VERSION = 1
export const MEDIA_FRAME_HEADER_BYTES = 40

const KIND_TO_CODE: Record<MediaFrameKind, number> = {
    'audio-pcm': 1,
    'audio-record': 2,
    'video-frame': 3,
}

const CODE_TO_KIND: Record<number, MediaFrameKind> = {
    1: 'audio-pcm',
    2: 'audio-record',
    3: 'video-frame',
}

const CODEC_TO_CODE: Record<MediaFrameCodec, number> = {
    pcm16: 1,
    float32: 2,
    jpeg: 10,
    png: 11,
    webp: 12,
    'webm-opus': 20,
}

const CODE_TO_CODEC: Record<number, MediaFrameCodec> = {
    1: 'pcm16',
    2: 'float32',
    10: 'jpeg',
    11: 'png',
    12: 'webp',
    20: 'webm-opus',
}

function nowMono() {
    const perf = (globalThis as any).performance
    return typeof perf?.now == 'function' ? perf.now() : Date.now()
}

function toBytes(data: ArrayBuffer | ArrayBufferView) {
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return new Uint8Array(data)
}

function clonePayload(data: ArrayBuffer | ArrayBufferView) {
    const src = toBytes(data)
    const out = new Uint8Array(src.byteLength)
    out.set(src)
    return out
}

function writeU32(view: DataView, offset: number, value: number | undefined) {
    view.setUint32(offset, Math.max(0, Math.min(0xffffffff, Math.floor(value ?? 0))), true)
}

function readPayload(frame: Uint8Array, headerBytes: number) {
    return frame.subarray(headerBytes)
}

export function encodeMediaFrame(meta: MediaFrameMeta, payload: ArrayBuffer | ArrayBufferView) {
    const body = toBytes(payload)
    const out = new Uint8Array(MEDIA_FRAME_HEADER_BYTES + body.byteLength)
    const view = new DataView(out.buffer, out.byteOffset, MEDIA_FRAME_HEADER_BYTES)
    view.setUint32(0, MEDIA_FRAME_MAGIC, true)
    view.setUint8(4, MEDIA_FRAME_VERSION)
    view.setUint8(5, KIND_TO_CODE[meta.kind])
    view.setUint8(6, CODEC_TO_CODE[meta.codec])
    view.setUint8(7, 0)
    view.setUint16(8, MEDIA_FRAME_HEADER_BYTES, true)
    view.setUint16(10, 0, true)
    writeU32(view, 12, meta.seq)
    view.setFloat64(16, meta.tMono, true)
    if (meta.kind == 'video-frame') {
        writeU32(view, 24, meta.width)
        writeU32(view, 28, meta.height)
    } else {
        writeU32(view, 24, meta.sampleRate)
        writeU32(view, 28, meta.channels)
        writeU32(view, 32, meta.nSamples)
    }
    writeU32(view, 36, body.byteLength)
    out.set(body, MEDIA_FRAME_HEADER_BYTES)
    return out
}

export function decodeMediaFrame(frameLike: ArrayBuffer | ArrayBufferView): DecodedMediaFrame {
    const frame = toBytes(frameLike)
    if (frame.byteLength < MEDIA_FRAME_HEADER_BYTES) throw new Error('media frame too short')
    const view = new DataView(frame.buffer, frame.byteOffset, MEDIA_FRAME_HEADER_BYTES)
    if (view.getUint32(0, true) != MEDIA_FRAME_MAGIC) throw new Error('media frame magic mismatch')
    const version = view.getUint8(4)
    if (version != MEDIA_FRAME_VERSION) throw new Error(`media frame version ${version} is not supported`)
    const kind = CODE_TO_KIND[view.getUint8(5)]
    const codec = CODE_TO_CODEC[view.getUint8(6)]
    if (!kind || !codec) throw new Error('media frame kind/codec is not supported')
    const headerBytes = view.getUint16(8, true)
    if (headerBytes < MEDIA_FRAME_HEADER_BYTES || headerBytes > frame.byteLength) throw new Error('media frame header size is invalid')
    const payloadBytes = view.getUint32(36, true)
    const payload = readPayload(frame, headerBytes)
    if (payload.byteLength != payloadBytes) throw new Error('media frame payload size mismatch')
    const base = {
        kind,
        codec,
        seq: view.getUint32(12, true),
        tMono: view.getFloat64(16, true),
        payload,
    }
    if (kind == 'video-frame') {
        return {
            ...base,
            width: view.getUint32(24, true),
            height: view.getUint32(28, true),
        }
    }
    return {
        ...base,
        sampleRate: view.getUint32(24, true),
        channels: view.getUint32(28, true),
        nSamples: view.getUint32(32, true),
    }
}

function createStats(sourceId: string, kind: MediaSourceKind): MediaStats {
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
    }
}

function hasGetUserMedia() {
    const nav = (globalThis as any).navigator
    return typeof nav?.mediaDevices?.getUserMedia == 'function'
}

async function listDevices(kind: MediaSourceKind): Promise<MediaSourceDevice[]> {
    const nav = (globalThis as any).navigator
    if (typeof nav?.mediaDevices?.enumerateDevices != 'function') return []
    const devices = await nav.mediaDevices.enumerateDevices()
    const prefix = kind == 'audio' ? 'audioinput' : 'videoinput'
    return (devices as any[])
        .filter(d => d?.kind == prefix)
        .map(d => ({deviceId: String(d.deviceId ?? ''), label: String(d.label ?? ''), kind: String(d.kind ?? '')}))
}

function stopTracks(stream: any) {
    const tracks = typeof stream?.getTracks == 'function' ? stream.getTracks() : []
    for (const track of tracks) track.stop?.()
}

function stateFromMediaError(e: any): MediaSourceState {
    const name = String(e?.name ?? '')
    if (name == 'NotAllowedError' || name == 'SecurityError' || name == 'PermissionDeniedError') return 'denied'
    if (name == 'NotFoundError' || name == 'DevicesNotFoundError') return 'no-device'
    return 'error'
}

function defaultReplayOptions(kind: MediaSourceKind): ReplayListenUseOptions<[Uint8Array]> {
    if (kind == 'video') {
        return {
            history: 256,
            current: 'last',
            frame: tail => tail.length ? [tail[tail.length - 1]] : [],
        }
    }
    return {history: 1024}
}

function createSourceShell(kind: MediaSourceKind, sourceId: string, transport: MediaTransportMode, replay?: MediaReplayOpts) {
    const replayOpts = replay == true ? defaultReplayOptions(kind) : replay
    const [emit, listenApi] = replayOpts ? replayListen<[Uint8Array]>(replayOpts) : listen<[Uint8Array]>()
    const stats = createStats(sourceId, kind)
    let state: MediaSourceState = 'idle'
    let error: string | undefined

    function setState(next: MediaSourceState, err?: any) {
        state = next
        stats.state = next
        error = err ? String(err?.message ?? err) : undefined
        stats.error = error
    }

    function emitFrame(frame: Uint8Array, seq: number) {
        stats.seq = seq
        stats.frames++
        stats.bytes += frame.byteLength
        stats.lastAt = nowMono()
        const age = Math.max(1, stats.lastAt - (stats.startedAt || stats.lastAt))
        stats.fps = Math.round((stats.frames * 10000) / age) / 10
        emit(frame)
    }

    return {emit, listenApi, stats, get state() { return state }, get error() { return error }, setState, emitFrame}
}

function attachControl(
    pair: readonly [MediaEmit, MediaAnyListen],
    control: MediaSourceControl,
): MediaSource {
    return Object.assign(pair, control) as MediaSource
}

function ensureSocketTransport(mode: MediaTransportMode | undefined) {
    if (mode == 'webrtc') {
        throw new Error('WebRTC media transport is reserved for a future opt-in SFU/signaling adapter; use transport:"socket" today')
    }
}

function int16PcmFromFloat(input: Float32Array) {
    const out = new Int16Array(input.length)
    for (let i = 0; i < input.length; i++) {
        const x = Math.max(-1, Math.min(1, input[i]))
        out[i] = x < 0 ? x * 0x8000 : x * 0x7fff
    }
    return new Uint8Array(out.buffer)
}

function interleaveChannels(buffers: Float32Array[], frames: number, channels: number) {
    const out = new Float32Array(frames * channels)
    for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < channels; ch++) out[i * channels + ch] = buffers[ch]?.[i] ?? 0
    }
    return out
}

function rmsOf(input: Float32Array) {
    if (input.length == 0) return 0
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    return Math.sqrt(sum / input.length)
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
`
}

export function createAudioSource(opts: AudioSourceOpts = {}): MediaSource {
    const sourceId = opts.sourceId ?? 'audio'
    const transport = opts.transport ?? 'socket'
    const shell = createSourceShell('audio', sourceId, transport, opts.replay)
    let deviceId = opts.deviceId
    let stream: any = null
    let audioCtx: any = null
    let mediaNode: any = null
    let workletNode: any = null
    let recorder: any = null
    let seq = 0

    function emitPcm(samples: Float32Array, sampleRate: number, channels: number, frames: number) {
        const codec = opts.format == 'float32' ? 'float32' : 'pcm16'
        const payload = codec == 'float32' ? new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength) : int16PcmFromFloat(samples)
        shell.stats.rms = rmsOf(samples)
        shell.emitFrame(encodeMediaFrame({
            kind: 'audio-pcm',
            codec,
            seq: ++seq,
            tMono: nowMono(),
            sampleRate,
            channels,
            nSamples: frames,
        }, payload), seq)
    }

    async function startPcm(nextStream: any) {
        const AudioContextCtor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
        if (!AudioContextCtor) throw new Error('AudioContext is not available')
        audioCtx = new AudioContextCtor(opts.sampleRate ? {sampleRate: opts.sampleRate} : undefined)
        mediaNode = audioCtx.createMediaStreamSource(nextStream)
        if (opts.worklet != false && audioCtx.audioWorklet && (globalThis as any).Blob && (globalThis as any).URL) {
            const blob = new (globalThis as any).Blob([audioWorkletCode()], {type: 'text/javascript'})
            const url = (globalThis as any).URL.createObjectURL(blob)
            try {
                await audioCtx.audioWorklet.addModule(url)
            } finally {
                (globalThis as any).URL.revokeObjectURL(url)
            }
            const AudioWorkletNodeCtor = (globalThis as any).AudioWorkletNode
            workletNode = new AudioWorkletNodeCtor(audioCtx, 'wenay-common2-pcm', {
                numberOfInputs: 1,
                numberOfOutputs: 0,
                channelCount: opts.channels ?? 1,
            })
            workletNode.port.onmessage = function onWorkletSamples(ev: any) {
                const data = ev.data ?? {}
                emitPcm(data.samples as Float32Array, data.sampleRate ?? audioCtx.sampleRate, data.channels ?? 1, data.frames ?? 0)
            }
            mediaNode.connect(workletNode)
            return
        }
        const channels = opts.channels ?? 1
        const processor = audioCtx.createScriptProcessor(opts.bufferSize ?? 2048, channels, channels)
        processor.onaudioprocess = function onAudioProcess(ev: any) {
            const input = ev.inputBuffer
            const frames = input.length
            const buffers: Float32Array[] = []
            for (let ch = 0; ch < channels; ch++) buffers.push(input.getChannelData(Math.min(ch, input.numberOfChannels - 1)))
            emitPcm(interleaveChannels(buffers, frames, channels), input.sampleRate ?? audioCtx.sampleRate, channels, frames)
            const out = ev.outputBuffer
            if (out) for (let ch = 0; ch < out.numberOfChannels; ch++) out.getChannelData(ch).fill(0)
        }
        mediaNode.connect(processor)
        processor.connect(audioCtx.destination)
        workletNode = processor
    }

    function startRecord(nextStream: any) {
        const Recorder = (globalThis as any).MediaRecorder
        if (!Recorder) throw new Error('MediaRecorder is not available')
        const mimeType = opts.recordMimeType ?? 'audio/webm;codecs=opus'
        recorder = new Recorder(nextStream, Recorder.isTypeSupported?.(mimeType) ? {mimeType} : undefined)
        recorder.ondataavailable = async function onRecordChunk(ev: any) {
            if (!ev.data || ev.data.size == 0) return
            const payload = new Uint8Array(await ev.data.arrayBuffer())
            shell.emitFrame(encodeMediaFrame({
                kind: 'audio-record',
                codec: 'webm-opus',
                seq: ++seq,
                tMono: nowMono(),
            }, payload), seq)
        }
        recorder.start(opts.recordTimesliceMs ?? 1000)
    }

    function stop() {
        recorder?.stop?.()
        recorder = null
        workletNode?.disconnect?.()
        mediaNode?.disconnect?.()
        audioCtx?.close?.()
        stopTracks(stream)
        stream = null
        audioCtx = null
        mediaNode = null
        workletNode = null
        shell.setState('idle')
    }

    async function start() {
        try {
            ensureSocketTransport(transport)
            if (!opts.stream && !hasGetUserMedia()) {
                shell.setState('no-device')
                return shell.state
            }
            stop()
            shell.setState('requesting')
            shell.stats.startedAt = nowMono()
            const constraints: any = {audio: {deviceId: deviceId ? {exact: deviceId} : undefined, channelCount: opts.channels, sampleRate: opts.sampleRate}}
            stream = await resolveMediaStream(opts.stream, () => (globalThis as any).navigator.mediaDevices.getUserMedia(constraints))
            if (opts.mode == 'record') startRecord(stream)
            else await startPcm(stream)
            shell.setState('live')
            return shell.state
        } catch (e) {
            stopTracks(stream)
            stream = null
            shell.setState(stateFromMediaError(e), e)
            return shell.state
        }
    }

    const control: MediaSourceControl = {
        start,
        stop,
        getStats: () => ({...shell.stats}),
        setDevice: async (id: string) => {
            deviceId = id
            return shell.state == 'live' ? start() : shell.state
        },
        listDevices: () => listDevices('audio'),
        get state() { return shell.state },
        sourceId,
        kind: 'audio',
        transport,
    }
    return attachControl([shell.emit, shell.listenApi] as const, control)
}

// Injected MediaStream (or a factory returning one) vs the default getUserMedia path.
async function resolveMediaStream(injected: any, fallback: () => Promise<any>) {
    if (!injected) return fallback()
    return typeof injected == 'function' ? await injected() : injected
}

function mimeForVideo(codec: VideoSourceOpts['codec']) {
    if (codec == 'png') return 'image/png'
    if (codec == 'webp') return 'image/webp'
    return 'image/jpeg'
}

function canvasToBlob(canvas: any, mime: string, quality: number | undefined): Promise<any> {
    if (typeof canvas.convertToBlob == 'function') return canvas.convertToBlob({type: mime, quality})
    return new Promise((resolve, reject) => {
        if (typeof canvas.toBlob != 'function') {
            reject(new Error('canvas.toBlob is not available'))
            return
        }
        canvas.toBlob((blob: any) => blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null')), mime, quality)
    })
}

export function createVideoSource(opts: VideoSourceOpts = {}): MediaSource {
    const sourceId = opts.sourceId ?? 'video'
    const transport = opts.transport ?? 'socket'
    const shell = createSourceShell('video', sourceId, transport, opts.replay)
    let deviceId = opts.deviceId
    let stream: any = null
    let video = opts.video
    let canvas = opts.canvas
    let ctx: any = null
    let timer: any = null
    let busy = false
    let seq = 0

    async function captureOne() {
        if (busy || shell.state != 'live') {
            shell.stats.dropped++
            return
        }
        busy = true
        try {
            const w = opts.width ?? video.videoWidth ?? video.width ?? 0
            const h = opts.height ?? video.videoHeight ?? video.height ?? 0
            if (!w || !h) return
            if (canvas.width != w) canvas.width = w
            if (canvas.height != h) canvas.height = h
            ctx.drawImage(video, 0, 0, w, h)
            const codec = opts.codec ?? 'jpeg'
            const blob = await canvasToBlob(canvas, mimeForVideo(codec), opts.quality ?? 0.82)
            const payload = new Uint8Array(await blob.arrayBuffer())
            shell.emitFrame(encodeMediaFrame({
                kind: 'video-frame',
                codec,
                seq: ++seq,
                tMono: nowMono(),
                width: w,
                height: h,
            }, payload), seq)
        } catch (e) {
            shell.setState('error', e)
        } finally {
            busy = false
        }
    }

    function stop() {
        if (timer) {
            clearInterval(timer)
            timer = null
        }
        stopTracks(stream)
        stream = null
        if (!opts.video && video) {
            try { video.srcObject = null } catch {}
        }
        shell.setState('idle')
    }

    async function start() {
        try {
            ensureSocketTransport(transport)
            if (!opts.stream && !hasGetUserMedia()) {
                shell.setState('no-device')
                return shell.state
            }
            const doc = (globalThis as any).document
            if (!video && !doc?.createElement) {
                shell.setState('error', 'document.createElement is not available')
                return shell.state
            }
            stop()
            shell.setState('requesting')
            shell.stats.startedAt = nowMono()
            stream = await resolveMediaStream(opts.stream, () => (globalThis as any).navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: deviceId ? {exact: deviceId} : undefined,
                    width: opts.width,
                    height: opts.height,
                },
            }))
            video = video ?? doc.createElement('video')
            video.muted = true
            video.playsInline = true
            video.srcObject = stream
            await video.play?.()
            canvas = canvas ?? doc.createElement('canvas')
            ctx = canvas.getContext('2d')
            if (!ctx) throw new Error('2d canvas context is not available')
            shell.setState('live')
            const ms = Math.max(1, Math.round(1000 / (opts.fps ?? 3)))
            await captureOne()
            timer = setInterval(captureOne, ms)
            return shell.state
        } catch (e) {
            stopTracks(stream)
            stream = null
            shell.setState(stateFromMediaError(e), e)
            return shell.state
        }
    }

    const control: MediaSourceControl = {
        start,
        stop,
        getStats: () => ({...shell.stats}),
        setDevice: async (id: string) => {
            deviceId = id
            return shell.state == 'live' ? start() : shell.state
        },
        listDevices: () => listDevices('video'),
        get state() { return shell.state },
        sourceId,
        kind: 'video',
        transport,
    }
    return attachControl([shell.emit, shell.listenApi] as const, control)
}

