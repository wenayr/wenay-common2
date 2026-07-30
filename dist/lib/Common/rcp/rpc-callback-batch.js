"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BATCH_ITEMS = void 0;
exports.createCallbackPacketBatcher = createCallbackPacketBatcher;
const rpc_protocol_1 = require("./rpc-protocol");
const wire_size_1 = require("../wire-size");
const DEFAULT_MAX_ITEMS = 64;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 1024;
const MAX_BYTES = 8 * 1024 * 1024;
exports.MAX_BATCH_ITEMS = MAX_ITEMS;
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
function createCallbackPacketBatcher({ send, opt, envelope = rpc_protocol_1.Pkt.CB_BATCH, }) {
    const limits = resolveCallbackBatchLimits(opt);
    const wireOverhead = (0, wire_size_1.utf8ByteLength)(JSON.stringify([envelope, []]));
    let lone = null;
    let packets = [];
    let bytes = wireOverhead;
    let scheduled = false;
    let scheduleVersion = 0;
    function flush() {
        scheduleVersion++;
        scheduled = false;
        if (lone != null) {
            const single = lone;
            lone = null;
            send(single);
            return;
        }
        if (packets.length == 0)
            return;
        const ready = packets;
        packets = [];
        bytes = wireOverhead;
        send(ready.length == 1 ? ready[0] : [envelope, ready]);
    }
    function scheduleFlush() {
        if (scheduled)
            return;
        scheduled = true;
        const version = ++scheduleVersion;
        queueMicrotask(function flushBatchedPackets() {
            if (version != scheduleVersion)
                return;
            flush();
        });
    }
    function admit(packet) {
        if (containsBinary(packet)) {
            flush();
            send(packet);
            return;
        }
        const size = packetBytes(packet);
        const previousSeparator = packets.length == 0 ? 0 : 1;
        if (packets.length > 0 && (packets.length >= limits.maxItems || bytes + previousSeparator + size > limits.maxBytes))
            flush();
        if (size + wireOverhead > limits.maxBytes) {
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
    function enqueue(packet) {
        if (lone != null) {
            const first = lone;
            lone = null;
            admit(first);
        }
        if (packets.length == 0) {
            lone = packet;
            scheduleFlush();
            return;
        }
        admit(packet);
    }
    return { enqueue, flush };
}
