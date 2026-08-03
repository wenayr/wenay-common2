"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.openFsReplayStorage = openFsReplayStorage;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const replay_history_1 = require("../Common/events/replay-history");
const positive_integer_option_1 = require("../Common/positive-integer-option");
function openFsReplayStorage(file, opts = {}) {
    const codec = opts.codec ?? { stringify: JSON.stringify, parse: JSON.parse };
    const maxBytes = opts.maxBytes == null ? null : (0, positive_integer_option_1.positiveIntegerOption)(opts.maxBytes, 1, 'openFsReplayStorage: maxBytes');
    const pruneTarget = maxBytes == null ? null : Math.max(1, (maxBytes >> 2) * 3);
    const pruneRegrowth = maxBytes == null ? 0 : Math.max(1, maxBytes >> 4);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mem = (0, replay_history_1.createMemoryReplayStorage)();
    let records = [];
    let totalBytes = 0;
    let lastPruneBytes = null;
    function applyToMem(record) {
        if (record.t == 'e')
            mem.putEvent(record.v);
        else if (record.t == 'b')
            mem.putEvents(record.v);
        else
            mem.putKeyframe(record.v);
    }
    if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);
        const committedBytes = bytes.lastIndexOf(10) + 1;
        if (committedBytes != bytes.byteLength)
            fs.truncateSync(file, committedBytes);
        for (const line of bytes.subarray(0, committedBytes).toString('utf8').split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const rec = codec.parse(line);
            if (rec?.t != 'e' && rec?.t != 'b' && rec?.t != 'k')
                continue;
            const record = { t: rec.t, v: rec.v, bytes: Buffer.byteLength(line, 'utf8') + 1 };
            records.push(record);
            totalBytes += record.bytes;
            applyToMem(record);
        }
    }
    function appendRecord(t, v) {
        const line = codec.stringify({ t, v }) + '\n';
        const start = fs.existsSync(file) ? fs.statSync(file).size : 0;
        try {
            fs.appendFileSync(file, line);
        }
        catch (error) {
            try {
                if (fs.existsSync(file))
                    fs.truncateSync(file, start);
            }
            catch { }
            throw error;
        }
        const record = { t, v, bytes: Buffer.byteLength(line, 'utf8') };
        records.push(record);
        totalBytes += record.bytes;
    }
    function rewriteFrom(cut) {
        const kept = records.slice(cut);
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, kept.map(function encodeKeptRecord(record) {
            return codec.stringify({ t: record.t, v: record.v }) + '\n';
        }).join(''));
        fs.renameSync(tmp, file);
        records = kept;
        totalBytes = 0;
        mem = (0, replay_history_1.createMemoryReplayStorage)();
        for (const record of records) {
            totalBytes += record.bytes;
            applyToMem(record);
        }
    }
    function keyframeIndexes() {
        const indexes = [];
        for (let index = 0; index < records.length; index++) {
            if (records[index].t == 'k')
                indexes.push(index);
        }
        return indexes;
    }
    function maybePrune() {
        if (maxBytes == null || totalBytes <= maxBytes)
            return;
        if (lastPruneBytes != null && totalBytes - lastPruneBytes < pruneRegrowth)
            return;
        const keyframes = keyframeIndexes();
        if (keyframes.length == 0) {
            lastPruneBytes = totalBytes;
            return;
        }
        const suffix = new Array(records.length + 1);
        suffix[records.length] = 0;
        for (let index = records.length - 1; index >= 0; index--) {
            suffix[index] = suffix[index + 1] + records[index].bytes;
        }
        let cut = -1;
        for (const index of keyframes) {
            if (suffix[index] <= pruneTarget) {
                cut = index;
                break;
            }
        }
        if (cut < 0)
            for (const index of keyframes) {
                if (suffix[index] <= maxBytes) {
                    cut = index;
                    break;
                }
            }
        if (cut < 0)
            cut = keyframes[keyframes.length - 1];
        if (cut > 0)
            rewriteFrom(cut);
        lastPruneBytes = totalBytes;
    }
    function putEvents(events) {
        if (events.length == 0)
            return;
        if (events.length == 1)
            appendRecord('e', events[0]);
        else
            appendRecord('b', events);
        mem.putEvents(events);
        maybePrune();
    }
    function putEvent(event) {
        putEvents([event]);
    }
    function putKeyframe(keyframe) {
        appendRecord('k', keyframe);
        mem.putKeyframe(keyframe);
        maybePrune();
    }
    function getKeyframe(at) {
        return mem.getKeyframe(at);
    }
    function getEvents(from, to) {
        return mem.getEvents(from, to);
    }
    function compact() {
        const keyframes = keyframeIndexes();
        if (keyframes.length == 0)
            return;
        rewriteFrom(keyframes[keyframes.length - 1]);
    }
    function size() {
        return {
            ...mem.size(),
            bytes: totalBytes,
            overBudget: maxBytes != null && totalBytes > maxBytes,
        };
    }
    return {
        putEvent,
        putEvents,
        putKeyframe,
        getKeyframe,
        getEvents,
        compact,
        size,
    };
}
