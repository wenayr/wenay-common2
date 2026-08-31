// =====================================================================
// Store external — the {subscribe, getSnapshot} contract of React's
// useSyncExternalStore, with zero React dependency
// =====================================================================
// A Store node (or the Store root — anything with on() + snapshot()) becomes
// the exact tuple React 18+ expects:
//     const value = useSyncExternalStore(ext.subscribe, ext.getSnapshot)
// getSnapshot is identity-stable between changes (React requires it: an
// unstable snapshot identity forces an infinite re-render loop), and the
// snapshot is recomputed lazily on the first read after a change fact.
// The same tuple also fits any framework with an external-store hook —
// the library stays framework-free, the adapter is this one seam.

type StoreExternalSource<T> = {
    /** Future change facts; the default (no {current}) is exactly what subscribe needs. */
    on(cb: (value: T, ctx?: any) => void, opts?: any): () => void
    /** Detached snapshot with Store value semantics (rich values, cycles, binary). */
    snapshot(): T
}

export function storeExternal<T>(source: StoreExternalSource<T>) {
    let cached: T
    let fresh = false
    return {
        subscribe(onChange: () => void) {
            // a change may land in the render→subscribe gap, before any listener
            // exists — React's post-subscribe re-read of getSnapshot is how it is
            // caught, so subscribing itself must invalidate the cache
            fresh = false
            const off = source.on(function invalidateStoreExternal() {
                fresh = false
                onChange()
            })
            return off
        },
        getSnapshot() {
            if (!fresh) {
                cached = source.snapshot()
                fresh = true
            }
            return cached
        },
    }
}

export type StoreExternal<T> = ReturnType<typeof storeExternal<T>>
