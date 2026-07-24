import {Pkt} from './rpc-protocol'
import type {RpcOpt} from './rpc-caps'
import {jsonUtf8ByteLength, utf8ByteLength} from '../wire-size'

// ============================================================
// Lossless physical batching for server -> client callback packets
// ============================================================

const DEFAULT_MAX_ITEMS = 64
const DEFAULT_MAX_BYTES = 64 * 1024
const MAX_ITEMS = 1024
const MAX_BYTES = 8 * 1024 * 1024
const BATCH_WIRE_OVERHEAD = utf8ByteLength(JSON.stringify([Pkt.CB_BATCH, []]))

type tCallbackPacket = any[]

type CallbackPacketBatcherDeps = {
    send: (packet: any[]) => void
    opt?: RpcOpt['callbackBatch']
    /** The outer transport frame owns binary leaves, so they stay batchable. */
    acceptBinary?: boolean
    /** Non-mutating encoded-size estimate for an outer binary frame. */
    measure?: (packet: any[]) => number
}

function resolveCallbackBatchLimits(opt?: RpcOpt['callbackBatch']) {
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

export function callbackBatchDirectBinaryOversize(
    values: readonly unknown[],
    opt?: RpcOpt['callbackBatch'],
) {
    const maximumLeafBytes = resolveCallbackBatchLimits(opt).maxBytes - BATCH_WIRE_OVERHEAD
    for (const value of values) {
        if (value instanceof ArrayBuffer && value.byteLength > maximumLeafBytes) return true
        if (ArrayBuffer.isView(value) && value.byteLength > maximumLeafBytes) return true
    }
    return false
}

function packetBytes(packet: tCallbackPacket) {
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
    acceptBinary = false,
    measure,
}: CallbackPacketBatcherDeps) {
    const limits = resolveCallbackBatchLimits(opt)
    let packets: tCallbackPacket[] = []
    let bytes = BATCH_WIRE_OVERHEAD
    let scheduled = false
    let scheduleVersion = 0

    function flush() {
        scheduleVersion++
        scheduled = false
        if (packets.length == 0) return
        const ready = packets
        packets = []
        bytes = BATCH_WIRE_OVERHEAD
        // A one-item wrapper costs bytes without saving a transport send.
        send(ready.length == 1 ? ready[0] : [Pkt.CB_BATCH, ready])
    }

    function scheduleFlush() {
        if (scheduled) return
        scheduled = true
        const version = ++scheduleVersion
        queueMicrotask(function flushCallbackPackets() {
            if (version != scheduleVersion) return
            flush()
        })
    }

    function enqueue(packet: tCallbackPacket) {
        if (!acceptBinary && containsBinary(packet)) {
            // Socket.IO represents every binary leaf as a separate attachment. Keeping
            // binary callbacks direct avoids huge multi-attachment parser frames.
            flush()
            send(packet)
            return
        }
        const size = measure ? measure(packet) : packetBytes(packet)
        const previousSeparator = packets.length == 0 ? 0 : 1
        if (packets.length > 0 && (packets.length >= limits.maxItems || bytes + previousSeparator + size > limits.maxBytes)) flush()
        if (size + BATCH_WIRE_OVERHEAD > limits.maxBytes) {
            // Oversize callbacks keep legacy one-packet semantics and cannot be overtaken
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

    return {enqueue, flush}
}
