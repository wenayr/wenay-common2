// ============================================================
//  observable/index.ts — PUBLIC barrel for the in-house reactive lib
//
//  Curated, ADDITIVE public surface for the observable/ sandbox. Named
//  re-exports (not `export *`) on purpose: a couple of names — notably
//  isListenCallback / isReactiveNode — are intentionally re-exported by
//  more than one module, and `export *` would make those ambiguous and
//  silently drop them. Listing each name keeps the surface explicit,
//  collision-free, and easy to review.
//
//  Layers (see each module header): L0 core + L1 primitives + L2 derived
//  (reactive.ts / autotrack.ts) · L2.5 transit (transit.ts) · batch +
//  effects (batch.ts / schedule.ts) · L4 store (store.ts) · L5 wire
//  (wire.ts / codec.ts) + sync (sync.ts) + rate (rate.ts).
// ============================================================

// ===== L0 core / L1 primitives / L2 derived — reactive.ts =====
export {
    createLazyListen,
    createCell,
    createRObject,
    createRMap,
    combine,
    computed,
    // local-node identity (the unified WeakSet registry) + wire-shape check
    isReactiveNode,
    registerReactiveNode,
    isListenCallback,
} from './reactive'
export type {Source, LazyListen, Cell, RObject, RMap, Computed} from './reactive'

// ===== L2 derived — automatic dependency tracking — autotrack.ts =====
export {computedAuto} from './autotrack'
export type {ComputedAuto} from './autotrack'

// ===== auto-over-node — write-through plain-mutation view — auto.ts =====
// Public auto surface per STORE-PLAN (L47/L285): plain mutation of a store
// category. Was implemented but not wired into the barrel — connected for release.
export {createAutoNode} from './auto'
export type {AutoNode} from './auto'

// ===== L2.5 transit — filter / route / switch / merge — transit.ts =====
export {filter, route, switchOn, merge, isOurTransit} from './transit'
export type {Filter, Route, Merge} from './transit'

// ===== batching — batch.ts =====
export {batch, inBatch, deferring, enqueue} from './batch'

// ===== effects / ownership — schedule.ts =====
export {createEffect, onCleanup, createRoot, getOwner} from './schedule'
export type {Effect} from './schedule'

// ===== L4 store — path-addressed reactive tree — store.ts =====
export {createTransportStore, flatten, deepEqual} from './store'
export type {TransportStore, tKey, tPath, tStoreOpts} from './store'

// ===== native — plain-object skin over the store — native.ts =====
// The headline native API: read/write a reactive tree as a plain object
// at any depth (`p.balances.BTC = 5`, `p.x = {a:{c:5}}`), subscription via
// free functions. Stable Proxy (no identity caveat), lazy twice.
export {
    createReactive, node,
    onValue, onKey, onChange, onDeep, setIn,
    listen as listenReactive, listenValue as listenReactiveValue,
    listenDeep as listenReactiveDeep, snapshot as snapshotReactive,
} from './native'
export type {Reactive} from './native'

// ===== L5 wire — numeric protocol + client mirror — wire.ts =====
export {CMD, OP, encodeSnapshot, streamDeltas, createMirror} from './wire'
export type {Frame, SnapshotFrame, DeltaFrame, Mirror} from './wire'

// ===== codec — rich-value (Date/BigInt/Map/Set/RegExp/binary) — codec.ts =====
export {encodeValue, decodeValue} from './codec'
export type {EncodeValue, DecodeValue} from './codec'

// ===== sync — pending changes / retry / createSync — sync.ts =====
export {createSync, createPendingChanges, createRetry} from './sync'
export type {Sync, PendingChanges, Retry, tDelta, tAck, tRemote, tPersist} from './sync'

// ===== rate — throttle — rate.ts =====
export {throttle} from './rate'
export type {Throttled} from './rate'

// ===== adaptive observation granularity (Mechanism 1) — meter.ts =====
// EWMA rate meter + stat-then-hash dirty trigger + frequency-driven
// promote/demote watch. Rides the store's additive rev()/onRev() hook.
// (tKey is intentionally NOT re-exported here — store.ts already owns
// that public name; meter's local tKey is the same string alias.)
export {createRateMeter, createDirtyTrigger, createAdaptiveWatch} from './meter'
export type {RateMeter, DirtyTrigger, AdaptiveWatch} from './meter'

// ===== adaptive wire encoding (Mechanism 2) — shapewire.ts =====
// learn-shape -> positional+bitmask -> deopt-on-break codec; snapshot vs
// incremental (FIX W/X); rich values ride codec.ts.
export {createShapeCodec} from './shapewire'
export type {ShapeCodec, tShapeFrame, tSelfFrame, tPosFrame, tDictFrame, tDictOp} from './shapewire'
