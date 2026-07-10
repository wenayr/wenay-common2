"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCap = exports.CAPS_ALL = exports.Caps = void 0;
exports.optToCaps = optToCaps;
exports.Caps = {
    COMPACT: 1 << 0,
};
exports.CAPS_ALL = exports.Caps.COMPACT;
const hasCap = (caps, c) => (caps & c) === c;
exports.hasCap = hasCap;
function optToCaps(opt) {
    let c = exports.CAPS_ALL;
    if (opt?.compact === false)
        c &= ~exports.Caps.COMPACT;
    return c;
}
