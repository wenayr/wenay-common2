"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNodeIdMinter = exports.createIdPool = void 0;
const createIdPool = () => {
    const s = [];
    const free = new Set();
    let n = 0;
    return {
        next: () => {
            const id = s.length > 0 ? s.pop() : ++n;
            free.delete(id);
            return id;
        },
        release(id) {
            if (id < 1 || id > n || free.has(id))
                return;
            free.add(id);
            s.push(id);
        }
    };
};
exports.createIdPool = createIdPool;
const createNodeIdMinter = (opts) => {
    const { node } = opts;
    if (node.includes('-'))
        throw new Error('createNodeIdMinter: node must not contain "-"');
    let n = opts.start ?? 0;
    return {
        node,
        next: (kind = 'id') => `${kind}-${node}-${++n}`,
        adopt(ids) {
            let seen = 0;
            for (const id of ids) {
                const m = /^(.+)-([^-]+)-(\d+)$/.exec(id);
                if (!m || m[2] != node)
                    continue;
                seen++;
                const num = Number(m[3]);
                if (num > n)
                    n = num;
            }
            return seen;
        },
        current: () => n,
    };
};
exports.createNodeIdMinter = createNodeIdMinter;
