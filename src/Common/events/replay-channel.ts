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
    let binaryEnabled = false

    // ============================================================
    // protocol messages: responses and unbatched live events
    // ============================================================

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

    // ============================================================
    // live micro-batch
    // ============================================================
    // Pending live traffic, oldest first: a run of legacy JSON items, then at most
    // one open binary frame. A binary event is encoded into the frame when it is
    // emitted, so those bytes are its snapshot and nothing encodes it again. A
    // JSON item sends the open frame before it is queued, so the order holds.
    type tJsonLiveItem = {encoded: string, bytes: number}
    let liveQueue: tJsonLiveItem[] = []
    let liveQueueBytes = REPLAY_LIVE_BATCH_OVERHEAD
    let liveFrame: ReturnType<NonNullable<typeof binaryEncoder>['openBatch']> | null = null

    // A packet the transport refuses is recorded in failures and skipped: the rest
    // of the micro-batch still goes out.
    function sendJsonLive(items: tJsonLiveItem[], failures: unknown[]) {
        let encoded: string[] = []
        let bytes = REPLAY_LIVE_BATCH_OVERHEAD

        function flushJsonBatch() {
            if (!encoded.length) return
            const batch = REPLAY_LIVE_BATCH_PREFIX + encoded.join(',') + REPLAY_LIVE_BATCH_SUFFIX
            encoded = []
            bytes = REPLAY_LIVE_BATCH_OVERHEAD
            try { channel.send(batch) }
            catch (error) { failures.push(error) }
        }

        for (const item of items) {
            const separator = encoded.length ? 1 : 0
            if (encoded.length && (encoded.length >= REPLAY_LIVE_BATCH_MAX_ITEMS ||
                bytes + separator + item.bytes > REPLAY_LIVE_BATCH_MAX_BYTES)) flushJsonBatch()
            encoded.push(item.encoded)
            bytes += (encoded.length > 1 ? 1 : 0) + item.bytes
            if (encoded.length >= REPLAY_LIVE_BATCH_MAX_ITEMS || bytes >= REPLAY_LIVE_BATCH_MAX_BYTES) {
                flushJsonBatch()
            }
        }
        flushJsonBatch()
    }

    function sendLiveFrame(failures: unknown[]) {
        const frame = liveFrame
        if (!frame) return
        liveFrame = null
        try { sendPreparedBinary(frame.finish()) }
        catch (error) { failures.push(error) }
    }

    function drainLiveQueue(failures: unknown[]) {
        if (closed) return
        if (liveQueue.length) {
            const queue = liveQueue
            liveQueue = []
            liveQueueBytes = REPLAY_LIVE_BATCH_OVERHEAD
            sendJsonLive(queue, failures)
        }
        sendLiveFrame(failures)
    }

    function liveFailure(failures: unknown[]) {
        return failures.length == 1
            ? failures[0]
            : new AggregateError(failures, 'Multiple replay channel live sends failed')
    }

    function addToFreshFrame(ev: any) {
        const frame = binaryEncoder!.openBatch([REPLAY_BINARY_MESSAGE.EVENTS], REPLAY_LIVE_BATCH_MAX_ITEMS)
        try { frame.add(ev) }
        catch {
            frame.rollback()
            return false
        }
        liveFrame = frame
        return true
    }

    // false: the codec refuses the event even in a frame of its own, i.e. inside
    // [EVENTS, [ev]], the packet 3.0.1 snapshotted it in.
    function addLiveBinary(ev: any, failures: unknown[]) {
        if (!binaryEnabled || !binaryEncoder) return false
        const frame = liveFrame
        if (!frame) return addToFreshFrame(ev)
        try {
            frame.add(ev)
        } catch {
            // One work and byte budget spans the frame: its predecessors go out
            // and the event is tried alone before it counts as refused.
            drainLiveQueue(failures)
            return !closed && addToFreshFrame(ev)
        }
        if (frame.byteLength() > REPLAY_LIVE_BATCH_MAX_BYTES && frame.count() > 1) {
            // It does not fit behind its predecessors: send them, then encode it again
            // at the head of a fresh frame. Still inside emit, so still the emitted value.
            frame.rewindLast()
            drainLiveQueue(failures)
            return !closed && addToFreshFrame(ev)
        }
        return true
    }

    function queueJsonLive(item: tJsonLiveItem, failures: unknown[]) {
        if (liveFrame) drainLiveQueue(failures)
        if (closed) return
        const separator = liveQueue.length ? 1 : 0
        if (liveQueue.length && (liveQueue.length >= REPLAY_LIVE_BATCH_MAX_ITEMS ||
            liveQueueBytes + separator + item.bytes > REPLAY_LIVE_BATCH_MAX_BYTES)) drainLiveQueue(failures)
        const nextSeparator = liveQueue.length ? 1 : 0
        liveQueue.push(item)
        liveQueueBytes += nextSeparator + item.bytes
        if (liveQueue.length >= REPLAY_LIVE_BATCH_MAX_ITEMS || liveQueueBytes >= REPLAY_LIVE_BATCH_MAX_BYTES) {
            drainLiveQueue(failures)
        } else {
            scheduleLiveFlush()
        }
    }

    function placeLiveEvent(ev: any, failures: unknown[]) {
        if (closed) return
        if (addLiveBinary(ev, failures)) {
            const frame = liveFrame!
            if (frame.count() >= REPLAY_LIVE_BATCH_MAX_ITEMS || frame.byteLength() >= REPLAY_LIVE_BATCH_MAX_BYTES) {
                drainLiveQueue(failures)
            } else {
                scheduleLiveFlush()
            }
            return
        }
        if (closed) return
        // Unsupported binary values retain the exact legacy JSON behavior. One JSON
        // refuses too is reported to the emitter, after the flushes above.
        let encoded: string
        try { encoded = stringifyMessage(ev) ?? 'null' }
        catch (error) {
            failures.push(error)
            return
        }
        queueJsonLive({encoded, bytes: utf8ByteLength(encoded)}, failures)
    }

    // ============================================================
    // live events emitted while the live path is encoding or sending
    // ============================================================
    // A synchronous transport can deliver a frame to a consumer that emits again
    // before the send returns. The encoder still belongs to that frame, so the
    // event is snapshotted on its own now (bytes of [EVENTS, [ev]], as in 3.0.1)
    // and placed, in order, once the operation in progress is over.
    type tDeferredLive = {binary: true, value: unknown} | {binary: false, item: tJsonLiveItem}
    let liveBusy = false
    let deferred: tDeferredLive[] = []
    let deferredCodec: ReturnType<typeof createReplayBinaryCodec> | null = null

    function deferLiveEvent(ev: any) {
        if (binaryEnabled) {
            try {
                deferredCodec ??= createReplayBinaryCodec('replay channel deferred live snapshot', false)
                const wire = deferredCodec.encode([REPLAY_BINARY_MESSAGE.EVENTS, [ev]])
                // Our own bytes that crossed no boundary: the trusted decode is enough.
                deferred.push({binary: true, value: (deferredCodec.decodeTrusted(wire) as [number, [unknown]])[1][0]})
                scheduleLiveFlush()
                return
            } catch {
                // Unsupported binary values retain the exact legacy JSON behavior.
            }
        }
        const encoded = stringifyMessage(ev) ?? 'null'
        deferred.push({binary: false, item: {encoded, bytes: utf8ByteLength(encoded)}})
        scheduleLiveFlush()
    }

    // Takes only what is deferred now: events deferred while these are placed are
    // newer and wait for the next flush, so a feedback loop cannot spin in here.
    function placeDeferred(failures: unknown[]) {
        if (!deferred.length) return
        const events = deferred
        deferred = []
        for (const next of events) {
            if (closed) return
            if (next.binary) placeLiveEvent(next.value, failures)
            else queueJsonLive(next.item, failures)
        }
    }

    function scheduleLiveFlush() {
        if (liveScheduled) return
        liveScheduled = true
        queueMicrotask(function flushReplayChannelMicroBatch() {
            liveScheduled = false
            const late: unknown[] = []
            flushLive(late)
            if (!late.length) return
            // No emitter is on the stack any more: rethrow on a timer, as the replay line does.
            const failure = liveFailure(late)
            setTimeout(function rethrowReplayChannelLiveFailure() { throw failure }, 0)
        })
    }

    /** Places deferred events and sends everything pending, in order. */
    function flushLive(failures: unknown[]) {
        if (closed || liveBusy) return
        liveBusy = true
        try {
            placeDeferred(failures)
            drainLiveQueue(failures)
        } finally {
            liveBusy = false
        }
        if (deferred.length) scheduleLiveFlush()
    }

    /** Attempts every pending item, then throws whatever failed. */
    function flushLiveQueue() {
        const failures: unknown[] = []
        flushLive(failures)
        if (failures.length) throw liveFailure(failures)
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
        if (liveBusy) {
            deferLiveEvent(ev)
            return
        }
        // The emitter is on the stack: failures of a flush this event triggers reach
        // it as in the unbatched path, but only after the event itself is placed.
        const failures: unknown[] = []
        liveBusy = true
        try {
            placeDeferred(failures)
            placeLiveEvent(ev, failures)
        } finally {
            liveBusy = false
        }
        if (deferred.length) scheduleLiveFlush()
        if (failures.length) throw liveFailure(failures)
    }

    // A response follows every live event queued before it. Its prepared encode
    // owns the encoder while it is sent, so an emit that send provokes is deferred.
    function respond(packet: any[], message: unknown) {
        flushLiveQueue()
        const wasBusy = liveBusy
        liveBusy = true
        try {
            sendProtocolMessage(packet, message)
        } finally {
            liveBusy = wasBusy
        }
        if (deferred.length) scheduleLiveFlush()
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
                respond(
                    [REPLAY_BINARY_MESSAGE.RES_OK, msg.id, v ?? null],
                    {t: 'res', id: msg.id, ok: true, v: v ?? null},
                )
            }
        } catch (e) {
            // the sacred line and other throws reach the consumer loudly, same as in the rpc projection
            if (!closed) {
                respond(
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
        deferred = []
        // A frame no flush sent (close without flush, or one asked for mid-send)
        // still owns the encoder.
        const abandoned = liveFrame
        liveFrame = null
        if (abandoned) capture(function abandonLiveFrame() { abandoned.rollback() })
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
