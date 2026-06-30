// ============================================================
//  wire.ts — network protocol (numeric op/command codes) + a
//  client-side mirror, both built on the transport store.
//
//  Split by layer (CLAUDE.md):
//   • protocol    — numeric CMD/OP codes + frame types (gRPC-friendly:
//                   no string tags on the wire, just small ints).
//   • server      — encodeSnapshot (chunked) + streamDeltas (live).
//   • client      — createMirror: applies frames into its own store,
//                   buffering live deltas that race ahead of the
//                   snapshot so a late snapshot chunk can't clobber them.
//
//  The store already exposes everything we need: flatten() gives the
//  [path,value] leaf deltas for a chunked snapshot, and at(path).deep()
//  is the live change stream. The wire is a thin transport over those.
// ============================================================

import {createTransportStore, flatten, tPath, TransportStore} from './store'
import {encodeValue, decodeValue} from './codec'

// ===== protocol =====
// Numeric codes only — small ints serialize compactly and map
// cleanly onto a gRPC oneof / enum without string interning.
export const CMD = {sub: 1, unsub: 2, snapshot: 3, delta: 4} as const
// set = a value (incl. encoded rich types); del = key removed;
// undef = a leaf deliberately set to the VALUE undefined (NOT a delete) —
// the tombstone that keeps "unset" distinct from "deleted" on the wire.
export const OP = {set: 1, del: 2, undef: 3} as const

// A set op carries the codec-encoded value and, optionally, `mapSegs`:
// the prefix-depths along the path whose node is a Map (so the mirror can
// rebuild Map-vs-object — a flattened [path,value] frame loses container kind).
type tSetOp = [typeof OP.set, tPath, any] | [typeof OP.set, tPath, any, number[]]
type tDelOp = [typeof OP.del, tPath]
type tUndefOp = [typeof OP.undef, tPath]

export type SnapshotFrame = {c: typeof CMD.snapshot, seq: number, done: boolean, ops: tSetOp[]}
export type DeltaFrame = {c: typeof CMD.delta, ops: Array<tSetOp | tDelOp | tUndefOp>}
export type Frame = SnapshotFrame | DeltaFrame

// the wire reads/writes a transport-store facade (server side reads, mirror writes)
type tStoreNode = TransportStore

// The Map-ancestor depths of `path`: prefix-length `d` (0..len-1) whose node
// is a Map. The mirror replays these via setContainerKind before the leaf set.
function mapSegs(store: tStoreNode, path: tPath) {
    const segs: number[] = []
    for (let d = 0; d < path.length; d++) {
        if (store.at(path.slice(0, d)).containerKind() == 'map') segs.push(d)
    }
    return segs
}
// build a set op, appending mapSegs only when non-empty (keeps the common
// all-objects frame as a 3-tuple)
function setOp(store: tStoreNode, p: tPath, v: any): tSetOp {
    const segs = mapSegs(store, p)
    const ev = encodeValue(v)
    return segs.length ? [OP.set, p, ev, segs] : [OP.set, p, ev]
}

// ===== server =====

// Flatten the subtree at `path` and cut it into fixed-size snapshot
// frames; only the last frame is marked done.
export function encodeSnapshot(store: tStoreNode, path: tPath, chunkSize = 100) {
    // Drop "empty" leaves so an absent/unset node never materializes a key on
    // the mirror: a value of `undefined`, or an EMPTY container. (The store now
    // snapshots an emptied Map/object to an empty Map/{} rather than undefined,
    // so flatten() surfaces it as a leaf carrying no real data — we skip it.)
    const leaves = flatten(store as any, path).filter(function carriesData([, v]) {
        if (v === undefined) return false
        if (v instanceof Map) return v.size > 0
        if (v && typeof v == 'object' && (v.constructor == Object || v.constructor == undefined)) return Object.keys(v).length > 0
        return true
    })
    const frames: SnapshotFrame[] = []
    // always emit at least one (done) frame, even for an empty subtree,
    // so the client can flip to ready().
    const total = Math.max(1, Math.ceil(leaves.length / chunkSize))
    for (let seq = 0; seq < total; seq++) {
        const slice = leaves.slice(seq * chunkSize, (seq + 1) * chunkSize)
        const ops: tSetOp[] = slice.map(function toSetOp([p, v]) { return setOp(store, p, v) })
        frames.push({c: CMD.snapshot, seq, done: seq == total - 1, ops})
    }
    return frames
}

// Subscribe to live changes under `path`. The store's deep stream emits
// `undefined` for BOTH a deletion and a leaf set to the value `undefined`,
// but the store STATE differs: after a delete the key is gone, after a
// set-to-undefined the key is still present. So we disambiguate by probing
// `has()` (accurate because the store updates state before bubbling the
// deep event) → real delete becomes OP.del, deliberate undefined becomes the
// OP.undef tombstone. No store-signature change needed.
export function streamDeltas(store: tStoreNode, path: tPath, onFrame: (f: DeltaFrame) => void) {
    return store.at(path).deep(function onDeep(p, v) {
        let op: tSetOp | tDelOp | tUndefOp
        if (v === undefined) {
            const key = p[p.length - 1]
            const present = p.length > 0 && store.at(p.slice(0, -1)).has(key)
            op = present ? [OP.undef, p] : [OP.del, p]
        } else {
            op = setOp(store, p, v)
        }
        onFrame({c: CMD.delta, ops: [op]})
    })
}

// ===== client =====

// Holds its own transport store and replays the protocol into it.
// Live deltas arriving before the snapshot completes are buffered and
// flushed after the final (done) snapshot frame — otherwise a snapshot
// chunk delivered late could overwrite a fresher live value.
export function createMirror() {
    const store = createTransportStore()
    let synced = false
    let dead = false
    let resolveReady: (() => void) | null = null
    let rejectReady: ((e: any) => void) | null = null
    const readyPromise = new Promise<void>(function (res, rej) { resolveReady = res; rejectReady = rej })
    const buffered: DeltaFrame[] = []

    function applyOp(op: tSetOp | tDelOp | tUndefOp) {
        if (op[0] == OP.set) {
            const segs = op[3]
            // restore Map-vs-object: tag each Map ancestor before writing the leaf
            if (segs) for (const d of segs) store.at(op[1].slice(0, d)).setContainerKind('map')
            store.setIn(op[1], decodeValue(op[2]))
            return
        }
        // OP.undef: a leaf deliberately set to the VALUE undefined — keep the
        // key PRESENT (mirrors the server), distinct from a delete below.
        if (op[0] == OP.undef) { store.setIn(op[1], undefined); return }
        // OP.del: remove the leaf key from its parent so it vanishes from
        // snapshot()/has() — setIn(undefined) would leave a dangling child.
        const path = op[1]
        if (path.length == 0) return
        store.at(path.slice(0, -1)).delete(path[path.length - 1])
    }

    function applyDelta(frame: DeltaFrame) {
        for (const op of frame.ops) applyOp(op)
    }

    function applyFrame(frame: Frame) {
        // after close() the mirror is inert — late frames (e.g. a final
        // snapshot chunk arriving after teardown) are silently ignored.
        if (dead) return
        if (frame.c == CMD.snapshot) {
            // Resync is a non-goal for now: a snapshot that arrives once we're
            // already synced could only half-apply against live state, so we
            // drop it wholesale rather than partially clobber the mirror.
            if (synced) return
            for (const op of frame.ops) applyOp(op)
            if (frame.done) {
                synced = true
                // replay races that arrived mid-snapshot, in arrival order
                for (const d of buffered) applyDelta(d)
                buffered.length = 0
                if (resolveReady) resolveReady()
            }
            return
        }
        // live delta: buffer until the snapshot is whole, then apply directly
        if (!synced) buffered.push(frame)
        else applyDelta(frame)
    }

    // Tear down the mirror. If we never synced, settle the pending ready()
    // so awaiters can't hang forever waiting on a 'done' frame that won't
    // come — reject so they learn the sync failed. Marks the mirror dead so
    // any late applyFrame() calls become no-ops.
    function close() {
        if (dead) return
        dead = true
        buffered.length = 0
        if (!synced && rejectReady) rejectReady(new Error('mirror closed before sync completed'))
    }

    function ready() { return readyPromise }
    function isReady() { return synced }

    return {store, applyFrame, ready, isReady, close}
}
export type Mirror = ReturnType<typeof createMirror>

// ===== runnable end-to-end test =====
if (require.main === module) {
    let fails = 0
    const assert = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL:', m) } else console.log('  ok  :', m) }
    // The wire carries [path,value] leaf deltas only, so container *kind*
    // (Map vs object) is not on the protocol — a Map round-trips as an object
    // on the mirror. Normalize both sides to plain objects for deep-equal.
    // NOTE: keys whose value is `undefined` are KEPT (mapped to a sentinel)
    // so a dangling undefined-valued key can't be silently dropped by JSON and
    // hide divergence between the two sides.
    const UNDEF = ' __undefined__'
    function norm(v: any): any {
        if (v === undefined) return UNDEF
        if (v instanceof Map) { const o: any = {}; for (const [k, x] of v) o[k] = norm(x); return o }
        if (v && typeof v == 'object') { const o: any = {}; for (const k of Object.keys(v)) o[k] = norm(v[k]); return o }
        return v
    }
    const J = (v: any) => JSON.stringify(norm(v))

    async function run() {
        // server store: primitives + maps + nesting
        const server = createTransportStore({
            price: 100,
            balances: new Map([['BTC', 1], ['ETH', 10], ['SOL', 3]]),
            account: {leverage: 5, positions: new Map([['BTC', {qty: 0.5}]])},
        })

        console.log('\n[wire] encodeSnapshot chunks (small chunkSize → >1 frame)')
        const frames = encodeSnapshot(server, [], 2)
        assert(frames.length > 1, `snapshot split into ${frames.length} chunks`)
        assert(frames[frames.length - 1].done == true, 'last frame done=true')
        assert(frames.slice(0, -1).every(f => f.done == false), 'earlier frames done=false')
        assert(frames.every((f, i) => f.seq == i), 'seq increments 0..n')
        assert(frames.every(f => f.c == CMD.snapshot), 'all frames are snapshot command')

        const mirror = createMirror()

        // start the live stream INTO an array so we can interleave it
        const live: DeltaFrame[] = []
        const unsub = streamDeltas(server, [], f => live.push(f))

        console.log('\n[wire] feed snapshot, but inject a live delta MID-snapshot (before done)')
        // apply every frame except the last (snapshot not yet done)
        for (const f of frames.slice(0, -1)) mirror.applyFrame(f)
        assert(mirror.isReady() == false, 'mirror not ready until done frame')

        // a live mutation happens on the server WHILE snapshot is mid-flight
        server.set('price', 999)
        const midDelta = live[live.length - 1]
        assert(midDelta && midDelta.ops[0][0] == OP.set, 'server emitted a set delta for price')
        mirror.applyFrame(midDelta)   // arrives before snapshot done → must be buffered
        assert(mirror.store.get('price') != 999, 'mid-snapshot delta is BUFFERED (not applied yet)')

        // now the final snapshot chunk arrives. NOTE: snapshot still carries
        // the OLD price (100). If the delta were lost, price would revert.
        mirror.applyFrame(frames[frames.length - 1])
        assert(mirror.isReady() == true, 'mirror ready after done frame')
        await mirror.ready()
        assert(mirror.store.get('price') == 999, 'buffered delta replayed AFTER snapshot → price=999 not lost')

        console.log('\n[wire] post-sync live mutations mirror through (set + delete)')
        // wire the live stream straight into the mirror now
        const unsub2 = streamDeltas(server, [], f => mirror.applyFrame(f))

        server.setIn(['account', 'positions', 'BTC', 'qty'], 0.7)
        server.set('balances', new Map([['BTC', 1], ['ETH', 10]]))   // SOL deleted via diff
        server.set('newKey', 'hello')

        assert(mirror.store.at(['account', 'positions', 'BTC', 'qty']).get() == 0.7, 'deep set mirrored')
        assert(mirror.store.at('balances').has('SOL') == false, 'OP.del removed SOL key in mirror')
        assert(mirror.store.get('newKey') == 'hello', 'new key mirrored')

        console.log('\n[wire] mirror deep-equals server after sync')
        assert(J(mirror.store.snapshot()) == J(server.snapshot()), 'full snapshot deep-equal: ' + J(mirror.store.snapshot()))

        console.log('\n[wire] container-kind marker: Maps stay Maps on the mirror (not objects)')
        assert(mirror.store.at('balances').snapshot() instanceof Map, 'top-level Map kind preserved over the wire')
        assert(mirror.store.at(['account', 'positions']).snapshot() instanceof Map, 'nested Map kind preserved')
        assert(!(mirror.store.at('account').snapshot() instanceof Map), 'plain-object branch stays an object')

        // explicit delete on server propagates as OP.del
        server.delete('price')
        assert(mirror.store.has('price') == false, 'explicit server delete removed key in mirror')
        assert(J(mirror.store.snapshot()) == J(server.snapshot()), 'snapshots still equal after delete')

        unsub()
        unsub2()

        console.log('\n[wire] tombstone: set-to-undefined (OP.undef) is distinct from delete (OP.del)')
        {
            const srv = createTransportStore({a: 1})
            const mir = createMirror()
            for (const f of encodeSnapshot(srv, [], 100)) mir.applyFrame(f)
            await mir.ready()
            const un = streamDeltas(srv, [], f => mir.applyFrame(f))
            srv.set('a', undefined)                 // deliberate undefined VALUE, not a delete
            assert(mir.store.has('a') == true, 'set-to-undefined keeps the key PRESENT (OP.undef)')
            assert(mir.store.get('a') === undefined, 'mirrored value is undefined')
            srv.delete('a')                         // now an actual delete
            assert(mir.store.has('a') == false, 'delete removes the key (OP.del)')
            un()
        }

        console.log('\n[wire] rich-type values survive the wire (codec wired into the protocol)')
        {
            const when = new Date('2026-06-18T00:00:00.000Z')
            const srv = createTransportStore({when, big: 9007199254740993n, tags: new Set(['x', 'y'])})
            const mir = createMirror()
            for (const f of encodeSnapshot(srv, [], 100)) mir.applyFrame(f)
            await mir.ready()
            const w = mir.store.get('when')
            assert(w instanceof Date && w.valueOf() == when.valueOf(), 'Date leaf round-trips as a Date')
            assert(typeof mir.store.get('big') == 'bigint' && mir.store.get('big') == 9007199254740993n, 'BigInt leaf exact')
            const tags = mir.store.get('tags')
            assert(tags instanceof Set && tags.has('x') && tags.has('y'), 'Set leaf round-trips as a Set')
        }

        console.log('\n[wire] empty container on server does NOT create a dangling key on the mirror')
        // an empty Map snapshots to an empty Map (store.ts), and encodeSnapshot
        // must not emit a key for it — the mirror should simply not have it.
        const srv2 = createTransportStore({kept: 1, empties: new Map()})
        const m2 = createMirror()
        for (const f of encodeSnapshot(srv2, [], 100)) m2.applyFrame(f)
        await m2.ready()
        assert(m2.store.has('empties') == false, 'empty container produced NO key on the mirror')
        assert(m2.store.get('kept') == 1, 'sibling leaf still synced')
        // deep-equal both ways: the server's empty container is also not a leaf,
        // so the normalized snapshots agree (and neither carries an undefined key).
        assert(m2.store.has('kept') == true && m2.store.keys().length == 1, 'mirror has exactly the one real key')

        console.log('\n[wire] mirror.close() before sync settles ready() (no hang) and ignores late frames')
        const m3frames = encodeSnapshot(createTransportStore({a: 1, b: 2}), [], 1)
        assert(m3frames.length > 1, 'snapshot for close-test has >1 chunk so we can close mid-stream')
        const m3 = createMirror()
        m3.applyFrame(m3frames[0])              // partial: not done yet
        assert(m3.isReady() == false, 'mirror not synced mid-snapshot')
        m3.close()                              // close BEFORE the done frame
        // 'settled' records HOW ready() resolved; either outcome proves no hang,
        // but our close() rejects, so we expect 'reject'. Use a string so TS
        // can't narrow a boolean back to its literal initializer across the await.
        let settled = 'pending'
        await m3.ready().then(
            function onResolve() { settled = 'resolve' },
            function onReject() { settled = 'reject' },
        )
        assert(settled == 'reject', 'ready() settled (rejected) after close — did not hang')
        // late frames after close must be no-ops
        m3.applyFrame(m3frames[m3frames.length - 1])
        assert(m3.isReady() == false, 'late done frame ignored after close (mirror stays dead)')
        assert(m3.store.has('a') == true && m3.store.has('b') == false, 'no further state applied after close')
    }

    run().then(() => {
        console.log(`\n${fails == 0 ? 'ALL GREEN ✅' : fails + ' FAILURE(S) ❌'}`)
        process.exit(fails == 0 ? 0 : 1)
    })
}
