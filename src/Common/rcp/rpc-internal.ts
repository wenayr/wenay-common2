// Internal seams between rpc-server and its wrappers. Deliberately NOT re-exported by
// rpc-index, so nothing here is part of the public surface — a WeakMap keyed by the core
// server's return object lets a wrapper reach the core's teardown without widening that object.

// How to tear ONE core server down (auth timers, flow gates, onDispose) — the same path a
// server replacement takes, made reachable on transport disconnect.
const coreDetachRegistry = new WeakMap<object, () => void>()

/** rpc-server records its detach against the object it returns. */
export function registerCoreDetach(server: object, detach: () => void) {
    coreDetachRegistry.set(server, detach)
}

/** A wrapper (createRpcServerAuto) fetches it to release the core when the transport drops. */
export function coreDetachOf(server: object) {
    return coreDetachRegistry.get(server)
}

// A wire callback wrapper → the id it was created for. Kept here (not on the public rpc-walk
// surface) so a subscription host can address ONE subscriber by callback id.
const cbIdRegistry = new WeakMap<Function, number>()

/** rpc-walk records the id every callback wrapper was created for. */
export function setRpcCallbackId(fn: Function, id: number) {
    cbIdRegistry.set(fn, id)
}

/** The wire callback id a wrapper was created for, or undefined for a plain function. */
export function rpcCallbackId(fn: Function): number | undefined {
    return cbIdRegistry.get(fn)
}
