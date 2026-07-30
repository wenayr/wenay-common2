import {Pkt} from './rpc-protocol'
import type {RpcBatchOpt} from './rpc-caps'
import {jsonUtf8ByteLength, utf8ByteLength} from '../wire-size'

// ============================================================
// Lossless physical batching for ordered RPC packets
// ============================================================
// ONE batcher, two envelopes. Pkt.CB_BATCH (Caps.CB_BATCH) carries live server->client
// callback packets; Pkt.BATCH (Caps.REQ_BATCH) carries any ordered application packet in
// either direction. Everything else — microtask flush, the two ceilings, the binary escape
// hatch, the oversize rule and the unwrapped one-item batch — is envelope-independent, so
// the envelope opcode is a dep and not a second implementation.

const DEFAULT_MAX_ITEMS = 64
const DEFAULT_MAX_BYTES = 64 * 1024
const MAX_ITEMS = 1024
const MAX_BYTES = 8 * 1024 * 1024

/** Hard ceiling on items in one envelope — what a receiving validator may trust. */
export const MAX_BATCH_ITEMS = MAX_ITEMS

type tBatchedPacket = any[]

type CallbackPacketBatcherDeps = {
    send: (packet: any[]) => void
    opt?: RpcBatchOpt
    /** Opcode wrapping a multi-item batch. Default Pkt.CB_BATCH — today's callback envelope. */
    envelope?: number
}

function resolveCallbackBatchLimits(opt?: RpcBatchOpt) {
    const configured = opt && typeof opt == 'object' ? opt : undefined
    function bounded(value: number | undefined, fallback: number, min: number, max: number) {
        if (typeof value != 'number' || !Number.isFinite(value)) return fallback
        return Math.min(max, Math.max(min, Math.floor(value)))
    }
    return {
        maxItems: bounded(configured?.maxItems, DEFAULT_MAX_ITEMS, 2, MAX_ITEMS),
        maxBytes: bounded(configured?.maxBytes, DEFAULT_MAX_BYTES, 256, MAX_BYTES),
    }
}

function packetBytes(packet: tBatchedPacket) {
    return jsonUtf8ByteLength(packet)
}

function containsBinary(value: any, seen = new Set<object>()): boolean {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
    if (value == null || typeof value != 'object' || seen.has(value)) return false
    seen.add(value)
    for (const key of Object.keys(value)) {
        if (containsBinary(value[key], seen)) return true
    }
    return false
}

export function createCallbackPacketBatcher({
    send,
    opt,
    envelope = Pkt.CB_BATCH,
}: CallbackPacketBatcherDeps) {
    const limits = resolveCallbackBatchLimits(opt)
    const wireOverhead = utf8ByteLength(JSON.stringify([envelope, []]))
    // A packet ALONE in the queue leaves unwrapped whatever we learn about it, so neither its
    // byte size nor its binary leaves can change the wire. Measuring it would be pure cost on
    // exactly the isolated request/response path this envelope must not slow down: a 128 KB
    // result would pay a whole extra JSON.stringify to discover it is going out by itself
    // anyway. So a packet is inspected only once a second one turns up to share its frame.
    // The wire is identical either way; only an oversize or binary packet now leaves on the
    // same microtask as everything else instead of synchronously inside enqueue().
    let lone: tBatchedPacket | null = null
    let packets: tBatchedPacket[] = []
    let bytes = wireOverhead
    let scheduled = false
    let scheduleVersion = 0

    function flush() {
        scheduleVersion++
        scheduled = false
        if (lone != null) {
            const single = lone
            lone = null
            send(single)
            return
        }
        if (packets.length == 0) return
        const ready = packets
        packets = []
        bytes = wireOverhead
        // A one-item wrapper costs bytes without saving a transport send.
        send(ready.length == 1 ? ready[0] : [envelope, ready])
    }

    function scheduleFlush() {
        if (scheduled) return
        scheduled = true
        const version = ++scheduleVersion
        queueMicrotask(function flushBatchedPackets() {
            if (version != scheduleVersion) return
            flush()
        })
    }

    // Inspection and admission of a packet that has to share its frame with a neighbour.
    function admit(packet: tBatchedPacket) {
        if (containsBinary(packet)) {
            // Socket.IO represents every binary leaf as a separate attachment. Keeping
            // binary packets direct avoids huge multi-attachment parser frames.
            flush()
            send(packet)
            return
        }
        const size = packetBytes(packet)
        const previousSeparator = packets.length == 0 ? 0 : 1
        if (packets.length > 0 && (packets.length >= limits.maxItems || bytes + previousSeparator + size > limits.maxBytes)) flush()
        if (size + wireOverhead > limits.maxBytes) {
            // Oversize packets keep legacy one-packet semantics and cannot be overtaken
            // by CB_END or a response which follows them.
            flush()
            send(packet)
            return
        }
        const separator = packets.length == 0 ? 0 : 1
        packets.push(packet)
        bytes += separator + size
        if (packets.length >= limits.maxItems) flush()
        else scheduleFlush()
    }

    function enqueue(packet: tBatchedPacket) {
        if (lone != null) {
            // Its solitude just ended, so now it is worth measuring.
            const first = lone
            lone = null
            admit(first)
        }
        if (packets.length == 0) {
            lone = packet
            scheduleFlush()
            return
        }
        admit(packet)
    }

    return {enqueue, flush}
}
