// ============================================================
//  media-view.ts — the consumer side of media lines
//
//  A media line is any Listen of binary frames (local pair or an
//  RPC-exposed surface). These helpers hide the viewer plumbing:
//  frame decode, canvas rendering, PCM playback, publish piping.
// ============================================================
import {decodeMediaFrame, toBytes} from './media-source'

type tMediaLine = {on(cb: (frame: any, sentAt?: number) => void): any}

// A LOCAL line returns the off function synchronously (and MUST be detached
// synchronously — no frame may slip through after off()); an RPC deep proxy
// returns a Promise of a callable subscription handle. Normalize so viewer.off()
// detaches either kind — otherwise tearing down a remote viewer would throw.
// Order matters: a callable handle may ALSO be thenable (await = stream end),
// so the function check must run before the promise check.
function makeOff(raw: any) {
    function unsubscribe(h: any) {
        if (typeof h == 'function') h()
        else h?.off?.()
    }
    return function off() {
        if (typeof raw == 'function') { raw(); return }
        if (raw != null && typeof raw.then == 'function') { void raw.then(unsubscribe); return }
        unsubscribe(raw)
    }
}

function mimeForCodec(codec: string) {
    if (codec == 'png') return 'image/png'
    if (codec == 'webp') return 'image/webp'
    return 'image/jpeg'
}

// smoothed publish->consume age; sentAt is a wall-clock stamp (see pipeMediaPublish)
function createAgeMeter() {
    let ageMs = 0
    return {
        note(sentAt: unknown) {
            if (typeof sentAt != 'number') return
            const age = Date.now() - sentAt
            ageMs = ageMs ? Math.round(ageMs * 0.8 + age * 0.2) : age
        },
        get ageMs() { return ageMs },
    }
}

// frames observed within the last rolling second
function createRateMeter() {
    let windowStart = 0
    let windowCount = 0
    let perSec = 0
    return {
        note() {
            const now = Date.now()
            if (now - windowStart >= 1000) {
                perSec = windowStart ? windowCount : 0
                windowStart = now
                windowCount = 0
            }
            windowCount++
        },
        get perSec() { return perSec },
    }
}

// ============== video line -> canvas ==============

export type AttachVideoCanvasOpts = {
    /** bring your own bitmap decoder (tests, custom pipelines); default createImageBitmap */
    createBitmap?: (blob: any) => Promise<any>
    onError?: (e: unknown) => void
}

/**
 * Renders a video media line onto a canvas: per-frame codec comes from the frame
 * header, sizing follows the frames, decoding overload is busy-skipped (keep-latest).
 */
export function attachVideoCanvas(line: tMediaLine, canvas: any, opts: AttachVideoCanvasOpts = {}) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas context is not available')
    const makeBitmap = opts.createBitmap ?? function defaultBitmap(blob: any) {
        const create = (globalThis as any).createImageBitmap
        if (typeof create != 'function') throw new Error('createImageBitmap is not available')
        return create(blob)
    }
    const age = createAgeMeter()
    const rate = createRateMeter()
    let frames = 0
    let drawn = 0
    let width = 0
    let height = 0
    let busy = false
    let closed = false
    let bitmap: any = null

    const detach = makeOff(line.on(async function onVideoFrame(raw: any, sentAt?: number) {
        frames++
        age.note(sentAt)
        rate.note()
        if (busy) return
        busy = true
        try {
            const f = decodeMediaFrame(toBytes(raw))
            if (f.kind != 'video-frame' || !f.width || !f.height) return
            // Blob snapshots the supplied view, including its byte offset/length.
            // A preceding slice only duplicates every ordinary compressed video
            // payload; retain the copy only for SharedArrayBuffer-backed input.
            const blobPayload = f.payload.buffer instanceof ArrayBuffer
                ? f.payload as Uint8Array<ArrayBuffer>
                : f.payload.slice()
            bitmap = await makeBitmap(new Blob([blobPayload as any], {type: mimeForCodec(f.codec)}))
            if (closed) return
            if (canvas.width != f.width) canvas.width = f.width
            if (canvas.height != f.height) canvas.height = f.height
            ctx.drawImage(bitmap, 0, 0)
            width = f.width
            height = f.height
            drawn++
        } catch (e) {
            opts.onError?.(e)
        } finally {
            try {
                bitmap?.close?.()
            } catch (e) {
                opts.onError?.(e)
            }
            bitmap = null
            busy = false
        }
    }))

    function off() {
        if (closed) return
        closed = true
        detach()
    }

    return {
        stats: () => ({frames, drawn, perSec: rate.perSec, ageMs: age.ageMs, width, height}),
        off,
    }
}

// ============== audio line -> speakers ==============

export type AttachAudioPlayerOpts = {
    /** live policy: drop the backlog once the queue creeps this far ahead (seconds) */
    maxBacklogSec?: number
    /** bring your own AudioContext factory (tests, custom routing) */
    audioContext?: () => any
    onError?: (e: unknown) => void
}

/**
 * Plays a PCM media line (pcm16/float32 frames) through an AudioContext with a
 * sequential playhead. Live by design: a backlog beyond maxBacklogSec is dropped and
 * the playhead rebases near "now" — a lagging stream skips instead of drifting behind.
 * Playback starts on enable() — browsers require a user gesture for audio.
 */
export function attachAudioPlayer(line: tMediaLine, opts: AttachAudioPlayerOpts = {}) {
    const maxBacklogSec = opts.maxBacklogSec ?? 0.35
    const age = createAgeMeter()
    const rate = createRateMeter()
    let audioCtx: any = null
    let playhead = 0
    let frames = 0
    let played = 0
    let dropped = 0

    function makeContext() {
        if (opts.audioContext) return opts.audioContext()
        const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext
        if (!Ctor) throw new Error('AudioContext is not available')
        return new Ctor()
    }

    function toSamples(codec: string, payload: Uint8Array) {
        const copy = payload.slice()                 // own buffer: RPC views may be unaligned
        if (codec == 'float32') return new Float32Array(copy.buffer)
        if (codec != 'pcm16') return null
        const pcm = new Int16Array(copy.buffer)
        const out = new Float32Array(pcm.length)
        for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000
        return out
    }

    function push(raw: any) {
        const f = decodeMediaFrame(toBytes(raw))
        if (f.kind != 'audio-pcm') return
        const samples = toSamples(f.codec, f.payload)
        if (!samples) return
        const channels = f.channels || 1
        const sampleRate = f.sampleRate || 48000
        const nFrames = Math.floor(samples.length / channels)
        if (!nFrames) return
        if (playhead - audioCtx.currentTime > maxBacklogSec) {
            playhead = audioCtx.currentTime + 0.05
            dropped++
        }
        const buf = audioCtx.createBuffer(channels, nFrames, sampleRate)
        for (let ch = 0; ch < channels; ch++) {
            const chan = buf.getChannelData(ch)
            for (let i = 0; i < nFrames; i++) chan[i] = samples[i * channels + ch]
        }
        const node = audioCtx.createBufferSource()
        node.buffer = buf
        node.connect(audioCtx.destination)
        const at = Math.max(audioCtx.currentTime + 0.05, playhead)
        node.start(at)
        playhead = at + nFrames / sampleRate
        played++
    }

    const off = makeOff(line.on(function onAudioFrame(raw: any, sentAt?: number) {
        frames++
        age.note(sentAt)
        rate.note()
        if (!audioCtx) return
        try { push(raw) } catch (e) { opts.onError?.(e) }
    }))

    return {
        enable() {
            audioCtx = audioCtx ?? makeContext()
            playhead = 0
            void audioCtx.resume?.()
        },
        disable() {
            void audioCtx?.close?.()
            audioCtx = null
        },
        get enabled() { return !!audioCtx },
        stats: () => ({frames, played, dropped, perSec: rate.perSec, ageMs: age.ageMs}),
        off,
    }
}

// ============== source -> publish function ==============

export type PipeMediaPublishOpts = {
    /** stamp frames with Date.now() so viewers can show real latency (default true) */
    stamp?: boolean
    onError?: (e: unknown) => void
}

/**
 * Pipes a media source's frames into a publish function (an RPC call, a relay push).
 * Fire-and-forget: publish failures go to onError, never break the capture loop.
 */
export function pipeMediaPublish(
    line: tMediaLine,
    publish: (frame: Uint8Array, sentAt?: number) => unknown,
    opts: PipeMediaPublishOpts = {},
) {
    return line.on(function publishFrame(frame: any) {
        try {
            const result = publish(frame, opts.stamp == false ? undefined : Date.now())
            if (result != null
                && (typeof result == 'object' || typeof result == 'function')
                && typeof (result as any).then == 'function') {
                Promise.resolve(result).catch(function onPublishFail(e) { opts.onError?.(e) })
            }
        } catch (e) {
            opts.onError?.(e)
        }
    })
}
