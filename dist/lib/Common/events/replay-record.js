"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJsonlReplayWriter = createJsonlReplayWriter;
exports.loadJsonlReplay = loadJsonlReplay;
const replay_history_1 = require("./replay-history");
const JSON_CODEC = { stringify: JSON.stringify, parse: JSON.parse };
function createJsonlReplayWriter(write, codec = JSON_CODEC) {
    return {
        putEvent: ev => write(codec.stringify({ t: 'e', v: ev })),
        putKeyframe: kf => write(codec.stringify({ t: 'k', v: kf })),
        getKeyframe: () => undefined,
        getEvents: () => [],
    };
}
function loadJsonlReplay(lines, codec = JSON_CODEC) {
    const storage = (0, replay_history_1.createMemoryReplayStorage)();
    const list = typeof lines == 'string' ? lines.split(/\r?\n/) : lines;
    for (const line of list) {
        if (!line || !line.trim())
            continue;
        const rec = codec.parse(line);
        if (rec?.t == 'e')
            storage.putEvent(rec.v);
        else if (rec?.t == 'k')
            storage.putKeyframe(rec.v);
    }
    return storage;
}
