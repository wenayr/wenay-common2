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
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const rec = codec.parse(line);
            if (rec?.t == 'e')
                mem.putEvent(rec.v);
            else if (rec?.t == 'k')
                mem.putKeyframe(rec.v);
        }
    }
    function append(t, v) {
        fs.appendFileSync(file, codec.stringify({ t, v }) + '\n');
    }
    return {
        putEvent: (ev) => { mem.putEvent(ev); append('e', ev); },
        putKeyframe: (kf) => { mem.putKeyframe(kf); append('k', kf); },
        getKeyframe: (at) => mem.getKeyframe(at),
        getEvents: (from, to) => mem.getEvents(from, to),
        compact: () => {
            const kf = mem.getKeyframe();
            if (!kf)
                return;
            const tail = mem.getEvents(kf.seq, Infinity);
            const tmp = file + '.tmp';
            const lines = [codec.stringify({ t: 'k', v: kf }), ...tail.map(ev => codec.stringify({ t: 'e', v: ev }))];
            fs.writeFileSync(tmp, lines.join('\n') + '\n');
            fs.renameSync(tmp, file);
            const next = (0, replay_history_1.createMemoryReplayStorage)();
            next.putKeyframe(kf);
            for (const ev of tail)
                next.putEvent(ev);
            mem = next;
        },
        size: () => mem.size(),
    };
}
