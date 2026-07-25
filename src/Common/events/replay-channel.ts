// =====================================================================
// Replay wire over a plain message channel (datachannel, worker, pipe)
// =====================================================================
// Same contract as exposeReplay ⇄ replaySubscribe, but transport — any
// ordered message channel: WebRTC datachannel, MessagePort,
// worker, in-proc pipe. RPC core not involved: hello/ready upgrades the tiny
// historical JSON protocol to exact binary values when both ends support bytes.
// Mixed versions stay on JSON because direct channel lives OUTSIDE the main
// rpc connection — that's the whole point of direct routing.
// Closing channel = non-envelope (null) in line — replay subscribers make noise, not silence.

import {ReplayRemote} from './replay-wire'
import {utf8ByteLength} from '../wire-size'
import {getRpcSchemaReady, hasRpcMemberLookup, rpcMemberAvailable} from './transport-lifecycle'
import {createBinaryValueCodec} from './replay-binary-value'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const REPLAY_BYTES = '__wenayReplayBytes'
const REPLAY_LIVE_BATCH = 1
const REPLAY_LIVE_BATCH_MAX_ITEMS = 64
const REPLAY_LIVE_BATCH_MAX_BYTES = 64 * 1024
const REPLAY_LIVE_BATCH_PREFIX = '{"t":"evs","evs":['
const REPLAY_LIVE_BATCH_SUFFIX = ']}'
const REPLAY_LIVE_BATCH_OVERHEAD = utf8ByteLength(REPLAY_LIVE_BATCH_PREFIX + REPLAY_LIVE_BATCH_SUFFIX)
const REPLAY_BINARY_FEATURE = 1
const REPLAY_BINARY_MAGIC = [0x52, 0x43, 0x48] as const
const REPLAY_BINARY_VERSION = 1
const REPLAY_BINARY_MAX_VALUE_BYTES = 8_000_000
const REPLAY_BINARY_MAX_WIRE_BYTES = 16_000_000
const REPLAY_BINARY_DEPTH = 36
const REPLAY_BINARY_MAX_SHAPES = 1_000
const REPLAY_BINARY_MESSAGE = {
    SUB: 0,
    REQ: 1,
    RES_OK: 2,
    RES_ERROR: 3,
    EVENT: 4,
    EVENTS: 5,
} as const
const REPLAY_BINARY_METHOD = {
    since: 0,
    keyframe: 1,
    frame: 2,
} as const

type tReplayBinaryMethod = keyof typeof REPLAY_BINARY_METHOD

function createReplayBinaryCodec(label: string, shapeCache: boolean) {
    return createBinaryValueCodec({
        magic: REPLAY_BINARY_MAGIC,
        version: REPLAY_BINARY_VERSION,
        label,
        // A direct Replay channel has no RPC callback-id resolver. Functions and
        // private callback references therefore keep the legacy JSON fallback.
        callbackRefs: false,
        shapeCache: shapeCache ? {maxEntries: REPLAY_BINARY_MAX_SHAPES} : false,
        maxDepth: REPLAY_BINARY_DEPTH,
        maxBinaryBytes: REPLAY_BINARY_MAX_VALUE_BYTES,
        maxWireBytes: REPLAY_BINARY_MAX_WIRE_BYTES,
    })
}

function binaryChannelAvailable(channel: ReplayMessageChannel) {
    return typeof channel.sendBinary == 'function' && typeof channel.onBinaryMessage == 'function'
}

function binaryMethod(code: unknown): tReplayBinaryMethod | undefined {
    if (code == REPLAY_BINARY_METHOD.since) return 'since'
    if (code == REPLAY_BINARY_METHOD.keyframe) return 'keyframe'
    if (code == REPLAY_BINARY_METHOD.frame) return 'frame'
    return undefined
}

// JSON is still the envelope protocol, but a direct channel must not turn a media
// Uint8Array into an object with numeric keys. Keep bytes explicit and portable:
// this runs in browsers and Node without depending on Buffer or lib.dom types.
function bytesToBase64(bytes: Uint8Array) {
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = bytes[i + 1]
        const c = bytes[i + 2]
        out += BASE64[a >> 2]
        out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]
        out += b == null ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]
        out += c == null ? '=' : BASE64[c & 63]
    }
    return out
}

function base64ToBytes(text: string) {
    const clean = text.replace(/=+$/, '')
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
    let bits = 0
    let nBits = 0
    let at = 0
    for (const char of clean) {
        const n = BASE64.indexOf(char)
        if (n < 0) throw new Error('replay channel: invalid binary payload')
        bits = (bits << 6) | n
        nBits += 6
        if (nBits < 8) continue
        nBits -= 8
        out[at++] = (bits >> nBits) & 255
    }
    return out
}

function stringifyMessage(value: unknown) {
    return JSON.stringify(value, function encodeReplayBytes(_key, item) {
        if (item instanceof Uint8Array) return {[REPLAY_BYTES]: bytesToBase64(item)}
        return item
    })
}

function parseMessage(raw: string) {
    return JSON.parse(raw, function decodeReplayBytes(_key, item) {
        if (item != null && typeof item == 'object' && Object.keys(item).length == 1 && typeof item[REPLAY_BYTES] == 'string') {
            return base64ToBytes(item[REPLAY_BYTES])
        }
        return item
    })
}

/** Minimal ordered string channel — shape of datachannel/MessagePort/pipe. */
export type ReplayMessageChannel = {
    send: (data: string) => void
    onMessage: (cb: (data: string) => void) => (() => void) | void
    sendBinary?: (data: Uint8Array) => void
    onBinaryMessage?: (cb: (data: Uint8Array) => void) => (() => void) | void
    onClose?: (cb: () => void) => (() => void) | void
    close?: () => void
}

// unsubscribe handle can be a function (Listen) or object (SubscriptionHandle of wire)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Server side: serve replay-line (shape exposeReplay/ReplayRemote)
 * over channel. Line subscribes lazily — on first consumer {t:'sub'}.
 * Returns close() (unsubscribe from line and stop responding).
 */
export function serveReplayChannel<Z extends any[]>(source: ReplayRemote<Z>, channel: ReplayMessageChannel) {
    let lineOff: any = null
    let closed = false
    let batchLive = false
    let liveScheduled = false
    const binaryCapable = binaryChannelAvailable(channel)
    const binaryEncoder = binaryCapable
        ? createReplayBinaryCodec('replay channel server encode', true)
        : null
    const binaryDecoder = binaryCapable
        ? createReplayBinaryCodec('replay channel server decode', true)
        : null
    const snapshotEncoder = binaryCapable
        ? createReplayBinaryCodec('replay channel live snapshot encode', false)
        : null
    const snapshotDecoder = binaryCapable
        ? createReplayBinaryCodec('replay channel live snapshot decode', false)
        : null
    let binaryEnabled = false
    type LiveItem = {
        binary: boolean
        value?: any
        encoded?: string
        bytes: number
    }
    let liveQueue: LiveItem[] = []
    let liveQueueBytes = REPLAY_LIVE_BATCH_OVERHEAD

    function encodedLiveItem(item: LiveItem) {
        if (item.encoded != null) return item.encoded
        return stringifyMessage(item.value) ?? 'null'
    }

    function sendJsonLive(items: LiveItem[]) {
        let encoded: string[] = []
        let bytes = REPLAY_LIVE_BATCH_OVERHEAD

        function flushJsonBatch() {
            if (!encoded.length) return
            channel.send(REPLAY_LIVE_BATCH_PREFIX + encoded.join(',') + REPLAY_LIVE_BATCH_SUFFIX)
            encoded = []
            bytes = REPLAY_LIVE_BATCH_OVERHEAD
        }

        for (const item of items) {
            const value = encodedLiveItem(item)
            const valueBytes = item.encoded != null ? item.bytes : utf8ByteLength(value)
            const separator = encoded.length ? 1 : 0
            if (encoded.length && (encoded.length >= REPLAY_LIVE_BATCH_MAX_ITEMS ||
                bytes + separator + valueBytes > REPLAY_LIVE_BATCH_MAX_BYTES)) flushJsonBatch()
            encoded.push(value)
            bytes += (encoded.length > 1 ? 1 : 0) + valueBytes
            if (encoded.length >= REPLAY_LIVE_BATCH_MAX_ITEMS || bytes >= REPLAY_LIVE_BATCH_MAX_BYTES) {
                flushJsonBatch()
            }
        }
        flushJsonBatch()
    }

    function sendPreparedBinary(prepared: ReturnType<NonNullable<typeof binaryEncoder>['prepareEncode']>) {
        try {
            channel.sendBinary!(prepared.wire)
            prepared.commit()
        } catch (error) {
            prepared.rollback()
            throw error
        }
    }

    function prepareBinary(packet: any[]) {
        if (!binaryEnabled || !binaryEncoder) return null
        try {
            return binaryEncoder.prepareEncode(packet)
        } catch {
            return null
        }
    }

    function sendProtocolMessage(packet: any[], message: unknown) {
        const prepared = prepareBinary(packet)
        if (prepared) {
            sendPreparedBinary(prepared)
            return
        }
        channel.send(stringifyMessage(message))
    }

    function sendBinaryLive(items: LiveItem[]) {
        const packet = [
            REPLAY_BINARY_MESSAGE.EVENTS,
            items.map(item => item.value),
        ]
        const prepared = prepareBinary(packet)
        if (!prepared) {
            if (items.length > 1) {
                const middle = Math.ceil(items.length / 2)
                sendBinaryLive(items.slice(0, middle))
                sendBinaryLive(items.slice(middle))
                return
            }
            sendJsonLive(items)
            return
        }
        if (prepared.wire.byteLength > REPLAY_LIVE_BATCH_MAX_BYTES && items.length > 1) {
            prepared.rollback()
            const middle = Math.ceil(items.length / 2)
            sendBinaryLive(items.slice(0, middle))
            sendBinaryLive(items.slice(middle))
            return
        }
        sendPreparedBinary(prepared)
    }

    function flushLiveQueue() {
        if (closed || !liveQueue.length) return
        const queue = liveQueue
        liveQueue = []
        liveQueueBytes = REPLAY_LIVE_BATCH_OVERHEAD
        let at = 0
        while (at < queue.length) {
            const binary = queue[at].binary
            let end = at + 1
            while (end < queue.length && queue[end].binary == binary) end++
            const items = queue.slice(at, end)
            if (binary) sendBinaryLive(items)
            else sendJsonLive(items)
            at = end
        }
    }

    function createLiveItem(ev: any): LiveItem {
        if (binaryEnabled && snapshotEncoder && snapshotDecoder) {
            try {
                const wire = snapshotEncoder.encode(ev)
                return {
                    binary: true,
                    value: snapshotDecoder.decode(wire),
                    bytes: wire.byteLength,
                }
            } catch {
                // Unsupported binary values retain the exact legacy JSON behavior.
            }
        }
        const encoded = stringifyMessage(ev) ?? 'null'
        return {binary: false, encoded, bytes: utf8ByteLength(encoded)}
    }

    function forwardEnvelope(ev: any) {
        if (closed) return
        if (!batchLive) {
            sendProtocolMessage(
                [REPLAY_BINARY_MESSAGE.EVENT, ev],
                {t: 'ev', ev},
            )
            return
        }
        const item = createLiveItem(ev)
        const separator = liveQueue.length ? 1 : 0
        if (liveQueue.length && (liveQueue.length >= REPLAY_LIVE_BATCH_MAX_ITEMS ||
            liveQueueBytes + separator + item.bytes > REPLAY_LIVE_BATCH_MAX_BYTES)) flushLiveQueue()
        const nextSeparator = liveQueue.length ? 1 : 0
        liveQueue.push(item)
        liveQueueBytes += nextSeparator + item.bytes
        if (liveQueue.length >= REPLAY_LIVE_BATCH_MAX_ITEMS || liveQueueBytes >= REPLAY_LIVE_BATCH_MAX_BYTES) {
            flushLiveQueue()
            return
        }
        if (liveScheduled) return
        liveScheduled = true
        queueMicrotask(function flushReplayChannelMicroBatch() {
            liveScheduled = false
            flushLiveQueue()
        })
    }

    async function readFrame(seq: number, hint: unknown) {
        await getRpcSchemaReady(source)?.()
        const frameAvailable = hasRpcMemberLookup(source)
            ? rpcMemberAvailable(source, 'frame')
            : source.frame != null
        return frameAvailable ? source.frame!(seq, hint) : null
    }

    async function handleRequest(msg: {id: number, m: string, a: any[]}) {
        try {
            const v = msg.m == 'since' ? await source.since(msg.a[0])
                : msg.m == 'keyframe' ? await source.keyframe()
                : msg.m == 'frame' ? await readFrame(msg.a[0], msg.a[1])
                : undefined
            if (!closed) {
                flushLiveQueue()
                sendProtocolMessage(
                    [REPLAY_BINARY_MESSAGE.RES_OK, msg.id, v ?? null],
                    {t: 'res', id: msg.id, ok: true, v: v ?? null},
                )
            }
        } catch (e) {
            // the sacred line and other throws reach the consumer loudly, same as in the rpc projection
            if (!closed) {
                flushLiveQueue()
                sendProtocolMessage(
                    [REPLAY_BINARY_MESSAGE.RES_ERROR, msg.id, String(e)],
                    {t: 'res', id: msg.id, ok: false, e: String(e)},
                )
            }
        }
    }

    function subscribe(batch: unknown) {
        if (lineOff) return
        batchLive = batch == REPLAY_LIVE_BATCH
        lineOff = source.line.on(forwardEnvelope)
    }

    function handleBinaryMessage(raw: Uint8Array) {
        if (closed || !binaryEnabled || !binaryDecoder) return
        let packet: any
        try { packet = binaryDecoder.decode(raw) } catch { return }
        if (!Array.isArray(packet)) return
        if (packet[0] == REPLAY_BINARY_MESSAGE.SUB) {
            subscribe(packet[1])
            return
        }
        if (packet[0] != REPLAY_BINARY_MESSAGE.REQ) return
        const method = binaryMethod(packet[2])
        if (!method || !Array.isArray(packet[3])) return
        void handleRequest({id: packet[1], m: method, a: packet[3]})
    }

    const offBinary = channel.onBinaryMessage?.(handleBinaryMessage)
    const offMsg = channel.onMessage(function onReplayChannelMessage(raw) {
        if (closed) return
        let msg: any
        try { msg = parseMessage(raw) } catch { return }
        if (msg?.t == 'hello' && msg.binary == REPLAY_BINARY_FEATURE && binaryCapable) {
            if (binaryEnabled) return
            flushLiveQueue()
            binaryEnabled = true
            try {
                channel.send(JSON.stringify({t: 'ready', binary: REPLAY_BINARY_FEATURE}))
            } catch (error) {
                binaryEnabled = false
                throw error
            }
            return
        }
        if (msg?.t == 'sub') {
            subscribe(msg.batch)
            return
        }
        if (msg?.t == 'req') void handleRequest(msg)
    })

    let offClose: (() => void) | void
    function close(flush = true) {
        if (closed) return
        let failed = false
        let failure: unknown
        function capture(action: () => void) {
            try { action() }
            catch (error) {
                if (!failed) {
                    failed = true
                    failure = error
                }
            }
        }
        if (flush) capture(flushLiveQueue)
        closed = true
        liveQueue = []
        liveQueueBytes = REPLAY_LIVE_BATCH_OVERHEAD
        const activeLine = lineOff
        lineOff = null
        capture(function unsubscribeReplaySource() { unsubscribeHandle(activeLine) })
        if (typeof offMsg == 'function') capture(offMsg)
        if (typeof offBinary == 'function') capture(offBinary)
        if (typeof offClose == 'function') capture(offClose)
        if (failed) throw failure
    }
    offClose = channel.onClose?.(function closeDeadReplayChannel() { close(false) })
    return function closeReplayChannel() { close(true) }
}

/**
 * Client side: ReplayRemote over channel — fed to any
 * replaySubscribe / replayRouteSubscribe / syncStoreReplay as a normal remote.
 */
export function channelReplayRemote<Z extends any[]>(channel: ReplayMessageChannel): ReplayRemote<Z> {
    let nextId = 1
    let subscribed = false
    let closed = false
    const binaryCapable = binaryChannelAvailable(channel)
    const binaryEncoder = binaryCapable
        ? createReplayBinaryCodec('replay channel client encode', true)
        : null
    const binaryDecoder = binaryCapable
        ? createReplayBinaryCodec('replay channel client decode', true)
        : null
    let binaryEnabled = false
    const pending = new Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>()
    const lineCbs = new Set<(ev: any) => void>()

    function deliverEnvelope(ev: any) {
        const errors: any[] = []
        for (const cb of Array.from(lineCbs)) {
            try { cb(ev) }
            catch (error) { errors.push(error) }
        }
        return errors
    }

    function rethrowDeliveryErrors(errors: any[]) {
        if (errors.length == 0) return
        const error = errors.length == 1 ? errors[0] : new AggregateError(errors, 'Multiple replay channel consumers failed')
        setTimeout(function rethrowReplayChannelConsumerErrors() { throw error }, 0)
    }

    function handleResponse(id: unknown, ok: boolean, value: any) {
        if (typeof id != 'number') return
        const p = pending.get(id)
        pending.delete(id)
        if (!p) return
        if (ok) p.resolve(value)
        else p.reject(new Error(value ?? 'replay channel request failed'))
    }

    function handleBinaryMessage(raw: Uint8Array) {
        if (closed || !binaryEnabled || !binaryDecoder) return
        let packet: any
        try { packet = binaryDecoder.decode(raw) } catch { return }
        if (!Array.isArray(packet)) return
        if (packet[0] == REPLAY_BINARY_MESSAGE.EVENT) {
            rethrowDeliveryErrors(deliverEnvelope(packet[1]))
            return
        }
        if (packet[0] == REPLAY_BINARY_MESSAGE.EVENTS && Array.isArray(packet[1])) {
            const errors: any[] = []
            for (const ev of packet[1]) errors.push(...deliverEnvelope(ev))
            rethrowDeliveryErrors(errors)
            return
        }
        if (packet[0] == REPLAY_BINARY_MESSAGE.RES_OK) {
            handleResponse(packet[1], true, packet[2])
            return
        }
        if (packet[0] == REPLAY_BINARY_MESSAGE.RES_ERROR) {
            handleResponse(packet[1], false, packet[2])
        }
    }

    const offBinary = channel.onBinaryMessage?.(handleBinaryMessage)
    const offMessage = channel.onMessage(function onRemoteChannelMessage(raw) {
        let msg: any
        try { msg = parseMessage(raw) } catch { return }
        if (msg?.t == 'ready' && msg.binary == REPLAY_BINARY_FEATURE && binaryCapable) {
            binaryEnabled = true
            return
        }
        if (msg?.t == 'ev') {
            rethrowDeliveryErrors(deliverEnvelope(msg.ev))
            return
        }
        if (msg?.t == 'evs' && Array.isArray(msg.evs)) {
            const errors: any[] = []
            for (const ev of msg.evs) {
                errors.push(...deliverEnvelope(ev))
            }
            rethrowDeliveryErrors(errors)
            return
        }
        if (msg?.t == 'res') handleResponse(msg.id, msg.ok == true, msg.ok ? msg.v : msg.e)
    })

    let offClose: (() => void) | void
    offClose = channel.onClose?.(function onRemoteChannelClosed() {
        if (closed) return
        closed = true
        for (const [, p] of pending) p.reject(new Error('replay channel closed'))
        pending.clear()
        // non-envelope = end of line: replayRouteSubscribe/replaySubscribe report onError
        const errors = deliverEnvelope(null)
        lineCbs.clear()
        if (typeof offMessage == 'function') offMessage()
        if (typeof offBinary == 'function') offBinary()
        if (typeof offClose == 'function') offClose()
        rethrowDeliveryErrors(errors)
    })

    function sendPreparedBinary(prepared: ReturnType<NonNullable<typeof binaryEncoder>['prepareEncode']>) {
        try {
            channel.sendBinary!(prepared.wire)
            prepared.commit()
        } catch (error) {
            prepared.rollback()
            throw error
        }
    }

    function sendProtocolMessage(packet: any[] | null, message: unknown) {
        if (binaryEnabled && binaryEncoder && packet) {
            let prepared: ReturnType<typeof binaryEncoder.prepareEncode> | null = null
            try { prepared = binaryEncoder.prepareEncode(packet) } catch {}
            if (prepared) {
                sendPreparedBinary(prepared)
                return
            }
        }
        channel.send(stringifyMessage(message))
    }

    function req(m: tReplayBinaryMethod, a: any[]) {
        if (closed) return Promise.reject(new Error('replay channel closed'))
        return new Promise<any>((resolve, reject) => {
            const id = nextId++
            pending.set(id, {resolve, reject})
            try {
                sendProtocolMessage(
                    [REPLAY_BINARY_MESSAGE.REQ, id, REPLAY_BINARY_METHOD[m], a],
                    {t: 'req', id, m, a},
                )
            } catch (error) {
                pending.delete(id)
                reject(error)
            }
        })
    }

    if (binaryCapable) {
        channel.send(JSON.stringify({t: 'hello', binary: REPLAY_BINARY_FEATURE}))
    }

    return {
        line: {
            on(cb: (ev: any) => void) {
                lineCbs.add(cb)
                if (!subscribed && !closed) {
                    subscribed = true
                    try {
                        sendProtocolMessage(
                            [REPLAY_BINARY_MESSAGE.SUB, REPLAY_LIVE_BATCH],
                            {t: 'sub', batch: REPLAY_LIVE_BATCH},
                        )
                    } catch (error) {
                        subscribed = false
                        lineCbs.delete(cb)
                        throw error
                    }
                }
                return function offChannelLine() { lineCbs.delete(cb) }
            },
        },
        since: seq => req('since', [seq]),
        keyframe: () => req('keyframe', []),
        frame: (seq, hint) => req('frame', [seq, hint]),
    }
}
