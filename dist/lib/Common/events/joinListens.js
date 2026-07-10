"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinListens = joinListens;
const Listen_1 = require("./Listen");
function joinListens(listens, keyExtractor) {
    const isArray = Array.isArray(listens);
    const map = isArray
        ? Object.fromEntries(listens.map((l, i) => [String(i), l]))
        : listens;
    const [set, out] = (0, Listen_1.listen)();
    const keys = Object.keys(map);
    const buckets = new Map();
    const getKey = (data) => keyExtractor?.(data) ?? "_";
    const tryFire = (tid) => {
        const bucket = buckets.get(tid);
        if (bucket.size < keys.length)
            return;
        const result = isArray
            ? keys.map(k => bucket.get(k))
            : Object.fromEntries(bucket);
        buckets.delete(tid);
        set(result, tid);
    };
    const unsubs = [];
    const bindPort = (portId, listener) => {
        const cb = (...data) => {
            const tid = getKey(data[0]);
            if (!buckets.has(tid))
                buckets.set(tid, new Map());
            buckets.get(tid).set(portId, data.length <= 1 ? data[0] : data);
            tryFire(tid);
        };
        unsubs.push(listener.on(cb));
    };
    for (const portId of keys) {
        bindPort(portId, map[portId]);
    }
    function add(listener, key) {
        const portId = isArray ? String(keys.length) : (key ?? String(keys.length));
        if (map[portId])
            return;
        map[portId] = listener;
        keys.push(portId);
        bindPort(portId, listener);
    }
    return {
        listen: out,
        pending: buckets,
        clear: (tid) => {
            tid ? buckets.delete(tid) : buckets.clear();
        },
        destroy: () => {
            for (const u of unsubs)
                u();
            unsubs.length = 0;
            buckets.clear();
        },
        add
    };
}
