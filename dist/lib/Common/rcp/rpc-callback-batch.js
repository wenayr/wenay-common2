"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCallbackPacketBatcher = createCallbackPacketBatcher;
const rpc_protocol_1 = require("./rpc-protocol");
const wire_size_1 = require("../wire-size");
const DEFAULT_MAX_ITEMS = 64;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const BATCH_WIRE_OVERHEAD = (0, wire_size_1.utf8ByteLength)(JSON.stringify([rpc_protocol_1.Pkt.CB_BATCH, []]));
function resolveCallbackBatchLimits(opt) {
    const configured = opt && typeof opt == 'object' ? opt : undefined;
    function bounded(value, fallback, min, max) {
        if (typeof value != 'number' || !Number.isFinite(value))
            return fallback;
        return Math.min(max, Math.max(min, Math.floor(value)));
    }
    return {
        maxItems: bounded(configured?.maxItems, DEFAULT_MAX_ITEMS, 2, MAX_ITEMS),
        maxBytes: bounded(configured?.maxBytes, DEFAULT_MAX_BYTES, 256, MAX_BYTES),
    };
}
function packetBytes(packet) {
    return (0, wire_size_1.jsonUtf8ByteLength)(packet);
}
function containsBinary(value, seen = new Set()) {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
        return true;
    if (value == null || typeof value != 'object' || seen.has(value))
        return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
        if (containsBinary(value[key], seen))
            return true;
    }
    return false;
}
function createCallbackPacketBatcher({ send, opt, }) {
    const limits = resolveCallbackBatchLimits(opt);
    let packets = [];
    let bytes = BATCH_WIRE_OVERHEAD;
    let scheduled = false;
    let scheduleVersion = 0;
    function flush() {
        scheduleVersion++;
        scheduled = false;
        if (packets.length == 0)
            return;
        const ready = packets;
        packets = [];
        bytes = BATCH_WIRE_OVERHEAD;
        send(ready.length == 1 ? ready[0] : [rpc_protocol_1.Pkt.CB_BATCH, ready]);
    }
    function scheduleFlush() {
        if (scheduled)
            return;
        scheduled = true;
        const version = ++scheduleVersion;
        queueMicrotask(function flushCallbackPackets() {
            if (version != scheduleVersion)
                return;
            flush();
        });
    }
    function enqueue(packet) {
        if (containsBinary(packet)) {
            flush();
            send(packet);
            return;
        }
        const size = packetBytes(packet);
        const previousSeparator = packets.length == 0 ? 0 : 1;
        if (packets.length > 0 && (packets.length >= limits.maxItems || bytes + previousSeparator + size > limits.maxBytes))
            flush();
        if (size + BATCH_WIRE_OVERHEAD > limits.maxBytes) {
            flush();
            send(packet);
            return;
        }
        const separator = packets.length == 0 ? 0 : 1;
        packets.push(packet);
        bytes += separator + size;
        if (packets.length >= limits.maxItems)
            flush();
        else
            scheduleFlush();
    }
    return { enqueue, flush };
}
