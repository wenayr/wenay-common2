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
