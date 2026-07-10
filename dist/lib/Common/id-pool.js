"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIdPool = void 0;
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
