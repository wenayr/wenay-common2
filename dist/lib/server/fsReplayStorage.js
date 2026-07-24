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
function openFsReplayStorage(file, opts = {}) {
    const codec = opts.codec ?? { stringify: JSON.stringify, parse: JSON.parse };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let mem = (0, replay_history_1.createMemoryReplayStorage)();
    if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);
        const committedBytes = bytes.lastIndexOf(10) + 1;
        if (committedBytes != bytes.byteLength)
            fs.truncateSync(file, committedBytes);
        for (const line of bytes.subarray(0, committedBytes).toString('utf8').split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const rec = codec.parse(line);
            if (rec?.t == 'e')
                mem.putEvent(rec.v);
            else if (rec?.t == 'b')
                mem.putEvents(rec.v);
            else if (rec?.t == 'k')
                mem.putKeyframe(rec.v);
        }
    }
    function appendRecord(record) {
        const line = codec.stringify(record) + '\n';
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
    }
    function append(t, v) {
        appendRecord({ t, v });
    }
    function putEvents(events) {
        if (events.length == 0)
            return;
        const record = events.length == 1 ? { t: 'e', v: events[0] } : { t: 'b', v: events };
        appendRecord(record);
        mem.putEvents(events);
    }
    function putEvent(event) {
        putEvents([event]);
    }
    function putKeyframe(keyframe) {
        append('k', keyframe);
        mem.putKeyframe(keyframe);
    }
    function getKeyframe(at) {
        return mem.getKeyframe(at);
    }
    function getEvents(from, to) {
        return mem.getEvents(from, to);
    }
    function compact() {
        const keyframe = mem.getKeyframe();
        if (!keyframe)
            return;
        const tail = mem.getEvents(keyframe.seq, Infinity);
        const tmp = file + '.tmp';
        const lines = [codec.stringify({ t: 'k', v: keyframe }), ...tail.map(function encodeTailEvent(event) {
                return codec.stringify({ t: 'e', v: event });
            })];
        fs.writeFileSync(tmp, lines.join('\n') + '\n');
        fs.renameSync(tmp, file);
        const next = (0, replay_history_1.createMemoryReplayStorage)();
        next.putKeyframe(keyframe);
        for (const event of tail)
            next.putEvent(event);
        mem = next;
    }
    function size() {
        return mem.size();
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
