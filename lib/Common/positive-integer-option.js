"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.positiveIntegerOption = positiveIntegerOption;
function positiveIntegerOption(value, fallback, label) {
    const next = Math.floor(value ?? fallback);
    if (!Number.isFinite(next) || next <= 0)
        throw new RangeError(`${label} must be > 0`);
    return next;
}
