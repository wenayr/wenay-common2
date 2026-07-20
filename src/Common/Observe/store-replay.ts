// =====================================================================
// store ⇄ replay — patch journal with seq, keyframe = root-patch
// =====================================================================
// All logic is in withReplayListen; store adds exactly "patch as event type".
// Keyframe — StorePatch with path: [] (replaceRoot): mirror applies ONE mechanism
// applyStorePatch for both snapshot and deltas. Reconnect stops costing a full
// snapshot when the journal tail is enough.

import {Store, StorePatch, StoreDrain, StoreEachCtx, applyStorePatch, createStore, exposeStore} from './store'
import {replayListen, ReplayListenOptions, ReplayEvent} from '../events/replay-listen'
import {exposeReplay, replaySubscribe, ReplayRemote, ReplaySubscribeOpts} from '../events/replay-wire'
import {replayRouteSubscribe, ReplayRouteSubscribeOpts} from '../events/replay-route'
import {openHistory, ReplayStorage} from '../events/replay-history'

export type StoreReplayOpts = Pick<ReplayListenOptions<[StorePatch]>, 'history' | 'getSince' | 'onJournal' | 'now' | 'firstSeq'> & {
    /** Static source descriptor served to clients as replay.describe(): schema/originId/... (JSON-able). */
    describe?: Record<string, any>
}

/**
 * keyOf for patch line (conflateReplay): collapse by exact path.
 * Patch is absolute by its path, and the order of last touches = order by seq,
 * so "last patch of each path" gives the same state as the entire line —
 * including ancestor/descendant overlaps (ancestor patch carries the entire subtree).
 * In the new path (frame on line) — internal detail of condensePatchTail below.
 */
export function storePatchKey(patch: StorePatch) {
    // symbol in JSON.stringify would become null → collisions; such patch is not collapsed
    for (const k of patch.path) if (typeof k == 'symbol') return null
    return JSON.stringify(patch.path)
}

// Compressor of patch-line frame (frame-lambda for replayListen): last patch
// of each exact path, order of last touches = order by seq (delete+re-insert).
// Non-collapsible patch (symbol in path) → honest full tail, without partial magic.
function condensePatchTail(tail: ReplayEvent<[StorePatch]>[]) {
    const held = new Map<string, ReplayEvent<[StorePatch]>>()
    for (const ev of tail) {
        const k = storePatchKey(ev.event[0])
        if (k == null) return tail
        held.delete(k)
        held.set(k, ev)
    }
    return [...held.values()]
}

/**
 * Server side: exposeStore + numbered patch line.
 * Subscription to store is HOT — journal must see every change, even when
 * there are no subscribers, otherwise there are holes in the line. Cost: one listenPaths-listener + ring.
 */
export function exposeStoreReplay<T extends object>(store: Store<T>, opts: StoreReplayOpts = {}) {
    const [emitPatch, lineApi] = replayListen<[StorePatch]>({
        current: () => [{path: [], exists: true, value: store.snapshot()}],
        // store-layer knows the semantics of its events → declares the frame compressor itself:
        // mini-frame (last patch per path) instead of full keyframe, zero configuration
        frame: condensePatchTail,
        history: opts.getSince ? undefined : (opts.history ?? 1024),
        getSince: opts.getSince,
        onJournal: opts.onJournal,
        now: opts.now,
        firstSeq: opts.firstSeq,
    })
    // Store already knows how to build push-patches directly from raw state. Another pass through
    // store.node.at(path) would permanently leave in node-cache every temporary id of order/task.
    const {patches, changedData: _changedData, ...storeApi} = exposeStore(store, {push: true})
    const offStore = patches!.on(function journalStoreChange(patch: StorePatch) {
        emitPatch(patch)
    })
    return {
        /** Wire facade: pass to RPC server (object: api). Compatible with regular exposeStore. */
        api: {...storeApi, replay: opts.describe ? {...exposeReplay(lineApi), describe: () => ({...opts.describe})} : exposeReplay(lineApi)},
        /** Local replay-line — in-proc consumers, introspection (head/getSince). */
        replay: lineApi,
        close: () => { offStore() },
    }
}

/**
 * Client side: mirror over line. keyframe/tail/live — by one mechanism
 * applyStorePatch. Reconnect: syncStoreReplay(store, remote, {since: prev.seq()}).
 */
export function syncStoreReplay<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts: ReplaySubscribeOpts = {}) {
    return replaySubscribe<[StorePatch]>(remote, function applyLine(patch) { applyStorePatch(store, patch) }, opts)
}

/**
 * Route-switching store mirror: keep the old route alive, catch up the replacement
 * route from the last delivered seq, then close the old one. Use for relay <-> direct
 * promotion/re-interposition when the authority/replay line stays semantically the same.
 */
export function syncStoreReplayRoute<T extends object>(store: Store<T>, remote: ReplayRemote<[StorePatch]>, opts: ReplayRouteSubscribeOpts = {}) {
    return replayRouteSubscribe<[StorePatch]>(remote, function applyRoutePatch(patch) { applyStorePatch(store, patch) }, opts)
}

/**
 * One-line remote-fold: mirror over line → callback per CHANGED top-key
 * (createStore + syncStoreReplay + store.each().on in one call). Keyframe at start
 * is expanded by keys, key deletion = (key, undefined), value = store.state[key]
 * at flush time. All ReplaySubscribeOpts pass straight through (since/policy/staleMs/onError...).
 * Return — composite off (removes both each subscription and wire subscription) with mirror
 * for direct reads (off.store.state.BTCUSDT) and ready/seq/isStale/lastTs of wire.
 */
export function syncStoreReplayEach<T extends object>(
    remote: ReplayRemote<[StorePatch]>,
    cb: (key: string, value: T[keyof T] | undefined, ctx: StoreEachCtx) => void,
    opts: ReplaySubscribeOpts & {drain?: StoreDrain, initial?: T} = {},
) {
    const {drain, initial, ...wireOpts} = opts
    const store = createStore<T>((initial ?? {}) as T, drain !== undefined ? {drain} : {})
    // each BEFORE wire: first catch-up keyframe must be expanded into callbacks
    const offEach = store.each().on(cb)
    const sub = syncStoreReplay(store, remote, wireOpts)
    function off() { offEach(); sub() }
    return Object.assign(off, {
        /** Mirror — for direct reads and additional subscriptions. */
        store,
        ready: sub.ready,
        seq: sub.seq,
        isStale: sub.isStale,
        lastTs: sub.lastTs,
    })
}

/**
 * Time machine over patch archive (archiveReplay + ReplayStorage): snapshot
 * of state at the moment at (seq/ts; no at — last archived). Keyframe
 * and deltas are applied by ONE mechanism applyStorePatch. undefined = archive is empty.
 */
export function storeReplayAt<T extends object>(storage: ReplayStorage<[StorePatch]>, at: {seq?: number, ts?: number} = {}) {
    const envelopes = openHistory(storage).at(at)
    if (!envelopes) return undefined
    const scratch = createStore<any>({})
    for (const ev of envelopes) applyStorePatch(scratch, ev.event[0])
    return scratch.snapshot() as T
}
