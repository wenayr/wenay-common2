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
exports.openFsSpillJournal = openFsSpillJournal;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const positive_integer_option_1 = require("../Common/positive-integer-option");
function openFsSpillJournal(file, opts) {
    const history = (0, positive_integer_option_1.positiveIntegerOption)(opts.history, 1, 'openFsSpillJournal: history');
    const maxBytes = (0, positive_integer_option_1.positiveIntegerOption)(opts.maxBytes, 2, 'openFsSpillJournal: maxBytes');
    const codec = opts.codec ?? { stringify: JSON.stringify, parse: JSON.parse };
    const segmentBytes = Math.max(1, maxBytes >> 1);
    const prevFile = file + '.1';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const leftover of [file, prevFile])
        fs.rmSync(leftover, { force: true });
    let prev = null;
    let curr = { file, records: [], bytes: 0 };
    let closed = false;
    let spillErrors = 0;
    let entries = [];
    let start = 0;
    let head = 0;
    function ramCount() {
        return entries.length - start;
    }
    function ramOldestSeq() {
        return ramCount() > 0 ? entries[start].seq : null;
    }
    function compactRam() {
        if (start > 64 && start * 2 > entries.length) {
            entries = entries.slice(start);
            start = 0;
        }
    }
    function dropDiskWindow() {
        spillErrors++;
        prev = null;
        curr = { file, records: [], bytes: 0 };
        for (const stale of [file, prevFile]) {
            try {
                fs.rmSync(stale, { force: true });
            }
            catch { }
        }
    }
    function rotateSegments() {
        try {
            fs.rmSync(prevFile, { force: true });
            fs.renameSync(file, prevFile);
        }
        catch {
            dropDiskWindow();
            return;
        }
        prev = { file: prevFile, records: curr.records, bytes: curr.bytes };
        curr = { file, records: [], bytes: 0 };
    }
    function spill(evicted) {
        const line = codec.stringify(evicted) + '\n';
        const bytes = Buffer.byteLength(line, 'utf8');
        try {
            fs.appendFileSync(file, line);
        }
        catch {
            dropDiskWindow();
            return;
        }
        curr.records.push({ first: evicted[0].seq, last: evicted[evicted.length - 1].seq, offset: curr.bytes, bytes });
        curr.bytes += bytes;
        if (curr.bytes >= segmentBytes)
            rotateSegments();
    }
    function evictOverflow() {
        if (ramCount() <= history)
            return;
        const overflow = [];
        while (ramCount() > history) {
            overflow.push(entries[start]);
            entries[start] = undefined;
            start++;
        }
        compactRam();
        if (!closed)
            spill(overflow);
    }
    function onJournal(ev) {
        if (closed)
            return;
        entries.push(ev);
        head = ev.seq;
        evictOverflow();
    }
    function oldestSeq() {
        if (prev && prev.records.length)
            return prev.records[0].first;
        if (curr.records.length)
            return curr.records[0].first;
        return ramOldestSeq();
    }
    function readSegment(segment, sinceSeq, out) {
        const needed = segment.records.filter(record => record.last > sinceSeq);
        if (needed.length == 0)
            return true;
        let fd;
        try {
            fd = fs.openSync(segment.file, 'r');
        }
        catch {
            return false;
        }
        try {
            for (const record of needed) {
                const buf = Buffer.alloc(record.bytes);
                const read = fs.readSync(fd, buf, 0, record.bytes, record.offset);
                if (read != record.bytes)
                    return false;
                const batch = codec.parse(buf.toString('utf8').trim());
                for (const ev of batch)
                    if (ev.seq > sinceSeq)
                        out.push(ev);
            }
            return true;
        }
        catch {
            return false;
        }
        finally {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
    function getSince(seq) {
        if (seq > head)
            return undefined;
        if (seq == head)
            return [];
        const provable = oldestSeq();
        if (provable == null || seq + 1 < provable)
            return undefined;
        const out = [];
        const ramOldest = ramOldestSeq();
        if (ramOldest == null || seq + 1 < ramOldest) {
            if (prev && !readSegment(prev, seq, out))
                return undefined;
            if (!readSegment(curr, seq, out))
                return undefined;
        }
        for (let index = start; index < entries.length; index++) {
            const ev = entries[index];
            if (ev.seq > seq)
                out.push(ev);
        }
        let expected = seq + 1;
        for (const ev of out) {
            if (ev.seq != expected)
                return undefined;
            expected++;
        }
        return out;
    }
    function size() {
        const segments = [prev, curr].filter(Boolean);
        let diskEvents = 0;
        let diskBytes = 0;
        for (const segment of segments) {
            diskBytes += segment.bytes;
            for (const record of segment.records)
                diskEvents += record.last - record.first + 1;
        }
        return {
            ramEvents: ramCount(),
            diskEvents,
            diskBytes,
            oldestSeq: oldestSeq(),
            head,
            spillErrors,
        };
    }
    function close() {
        if (closed)
            return;
        closed = true;
        entries = [];
        start = 0;
        prev = null;
        curr = { file, records: [], bytes: 0 };
        for (const owned of [file, prevFile]) {
            try {
                fs.rmSync(owned, { force: true });
            }
            catch { }
        }
    }
    return {
        line: { getSince, onJournal },
        size,
        close,
    };
}
