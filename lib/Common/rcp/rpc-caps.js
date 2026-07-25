"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCap = exports.CAPS_ALL = exports.Caps = void 0;
exports.optToCaps = optToCaps;
exports.Caps = {
    COMPACT: 1 << 0,
    CB_BATCH: 1 << 1,
};
exports.CAPS_ALL = exports.Caps.COMPACT
    | exports.Caps.CB_BATCH;
const hasCap = (caps, c) => (caps & c) === c;
exports.hasCap = hasCap;
function optToCaps(opt) {
    let c = exports.Caps.COMPACT | exports.Caps.CB_BATCH;
    if (opt?.compact === false)
        c &= ~exports.Caps.COMPACT;
    if (opt?.callbackBatch === false)
        c &= ~exports.Caps.CB_BATCH;
    return c;
}
