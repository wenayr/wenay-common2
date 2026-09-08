const timers = globalThis as typeof globalThis & {
    setImmediate?: (callback: () => void) => unknown
}

/** Yield an I/O turn when available; browsers use the equivalent timer fallback. */
export function deferImmediate(callback: () => void) {
    if (typeof timers.setImmediate == 'function') timers.setImmediate(callback)
    else setTimeout(callback, 0)
}
