"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeExternal = storeExternal;
function storeExternal(source) {
    let cached;
    let fresh = false;
    return {
        subscribe(onChange) {
            fresh = false;
            const off = source.on(function invalidateStoreExternal() {
                fresh = false;
                onChange();
            });
            return off;
        },
        getSnapshot() {
            if (!fresh) {
                cached = source.snapshot();
                fresh = true;
            }
            return cached;
        },
    };
}
