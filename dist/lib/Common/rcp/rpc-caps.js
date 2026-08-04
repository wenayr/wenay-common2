"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCap = exports.CAPS_ALL = exports.Caps = void 0;
exports.optToCaps = optToCaps;
exports.Caps = {
    COMPACT: 1 << 0,
    CB_BATCH: 1 << 1,
    AUTH_STATE: 1 << 2,
    HELLO_ID: 1 << 3,
    REQ_BATCH: 1 << 4,
    ROWS: 1 << 5,
    CB_FLOW: 1 << 6,
};
exports.CAPS_ALL = exports.Caps.COMPACT
    | exports.Caps.CB_BATCH
    | exports.Caps.AUTH_STATE
    | exports.Caps.HELLO_ID
    | exports.Caps.REQ_BATCH
    | exports.Caps.ROWS
    | exports.Caps.CB_FLOW;
const hasCap = (caps, c) => (caps & c) === c;
exports.hasCap = hasCap;
function optToCaps(opt) {
    let c = exports.Caps.COMPACT | exports.Caps.CB_BATCH | exports.Caps.AUTH_STATE | exports.Caps.HELLO_ID | exports.Caps.ROWS | exports.Caps.CB_FLOW;
    if (opt?.compact === false)
        c &= ~exports.Caps.COMPACT;
    if (opt?.callbackBatch === false)
        c &= ~exports.Caps.CB_BATCH;
    if (opt?.authState === false)
        c &= ~exports.Caps.AUTH_STATE;
    if (opt?.helloId === false)
        c &= ~exports.Caps.HELLO_ID;
    if (opt?.flowCallback === false)
        c &= ~exports.Caps.CB_FLOW;
    if (opt?.requestBatch)
        c |= exports.Caps.REQ_BATCH;
    if (opt?.compactRows === false)
        c &= ~exports.Caps.ROWS;
    return c;
}
