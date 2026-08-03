// =====================================================================
// File-backed ReplayStorage — reference durability adapter (node-only)
// =====================================================================
// JSONL append-log: event/keyframe records plus atomic multi-event batch records. The whole file is
// loaded at open into the in-memory reference storage (which stays the seek
// index); every put appends one line synchronously. This is the REFERENCE
// implementation: honest, restart-safe and simple — swap in a DB/batched
// adapter through the same ReplayStorage port when volume demands it.
// Values must survive the codec (default JSON): plain data only.
//
// Retention is OPT-IN and belongs to the adapter, not the port: without
// `maxBytes` nothing is ever deleted. With it, the log is kept near the budget
// by cutting at a KEYFRAME boundary — the suffix always hydrates exactly, and
// the cut chosen is the oldest keyframe whose suffix still fits, so the budget
// buys the LONGEST provable history, not the shortest. The lossless floor is
// [latest keyframe + tail]; when even that exceeds the budget the adapter
// reports `overBudget` instead of deleting data hydration needs.

import * as fs from 'fs'
import * as path from 'path'
import {ReplayEvent} from '../Common/events/replay-listen'
import {ReplayStorage, createMemoryReplayStorage} from '../Common/events/replay-history'
import {positiveIntegerOption} from '../Common/positive-integer-option'

export type FsReplayStorageOpts = {
    /** Envelope codec (default JSON.stringify/parse) — swap for rich types. */
    codec?: {stringify: (v: any) => string, parse: (line: string) => any}
    /**
     * OPT-IN disk budget in bytes. Absent = today's behaviour: append-only, nothing
     * deleted. Present = when the file exceeds it, the oldest records are dropped at a
     * keyframe boundary down to ~3/4 of the budget (headroom, so steady-state writing
     * does not rewrite the file per append). A reader older than the cut gets a
     * keyframe reset — the semantics the wire already has for an evicted seq.
     */
    maxBytes?: number
}

/** One committed JSONL line: kept verbatim as parsed value + its byte cost. */
type tFsRecord = {t: 'e' | 'b' | 'k', v: any, bytes: number}

export function openFsReplayStorage<Z extends any[] = any[]>(file: string, opts: FsReplayStorageOpts = {}) {
    const codec = opts.codec ?? {stringify: JSON.stringify, parse: JSON.parse}
    const maxBytes = opts.maxBytes == null ? null : positiveIntegerOption(opts.maxBytes, 1, 'openFsReplayStorage: maxBytes')
    // Prune to 3/4 of the budget, and never re-attempt before the file grows again:
    // a floor above the budget must not degrade into a full rewrite per append.
    const pruneTarget = maxBytes == null ? null : Math.max(1, (maxBytes >> 2) * 3)
    const pruneRegrowth = maxBytes == null ? 0 : Math.max(1, maxBytes >> 4)

    fs.mkdirSync(path.dirname(file), {recursive: true})
    let mem = createMemoryReplayStorage<Z>()
    let records: tFsRecord[] = []
    let totalBytes = 0
    let lastPruneBytes: number | null = null

    function applyToMem(record: tFsRecord) {
        if (record.t == 'e') mem.putEvent(record.v as ReplayEvent<Z>)
        else if (record.t == 'b') mem.putEvents(record.v as ReplayEvent<Z>[])
        else mem.putKeyframe(record.v as ReplayEvent<Z>)
    }

    if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file)
        const committedBytes = bytes.lastIndexOf(10) + 1
        // A bulk is one newline-terminated record. A torn final append has no
        // terminator, so it is uncommitted and must not poison the next append.
        if (committedBytes != bytes.byteLength) fs.truncateSync(file, committedBytes)
        for (const line of bytes.subarray(0, committedBytes).toString('utf8').split(/\r?\n/)) {
            if (!line.trim()) continue
            const rec = codec.parse(line)
            if (rec?.t != 'e' && rec?.t != 'b' && rec?.t != 'k') continue
            const record: tFsRecord = {t: rec.t, v: rec.v, bytes: Buffer.byteLength(line, 'utf8') + 1}
            records.push(record)
            totalBytes += record.bytes
            applyToMem(record)
        }
    }

    function appendRecord(t: tFsRecord['t'], v: any) {
        const line = codec.stringify({t, v}) + '\n'
        const start = fs.existsSync(file) ? fs.statSync(file).size : 0
        try { fs.appendFileSync(file, line) }
        catch (error) {
            // Roll back a partial append while the process is alive. After a
            // crash, the open-time newline check performs the same recovery.
            try { if (fs.existsSync(file)) fs.truncateSync(file, start) } catch {}
            throw error
        }
        const record: tFsRecord = {t, v, bytes: Buffer.byteLength(line, 'utf8')}
        records.push(record)
        totalBytes += record.bytes
    }

    // === Retention (opt-in) ===
    // A cut is only ever a keyframe boundary: the surviving suffix must hydrate
    // exactly. rewriteFrom is also what the manual compact() rides on.

    function rewriteFrom(cut: number) {
        const kept = records.slice(cut)
        const tmp = file + '.tmp'
        fs.writeFileSync(tmp, kept.map(function encodeKeptRecord(record) {
            return codec.stringify({t: record.t, v: record.v}) + '\n'
        }).join(''))
        fs.renameSync(tmp, file)
        records = kept
        totalBytes = 0
        mem = createMemoryReplayStorage<Z>()
        for (const record of records) {
            totalBytes += record.bytes
            applyToMem(record)
        }
    }

    function keyframeIndexes() {
        const indexes: number[] = []
        for (let index = 0; index < records.length; index++) {
            if (records[index].t == 'k') indexes.push(index)
        }
        return indexes
    }

    function maybePrune() {
        if (maxBytes == null || totalBytes <= maxBytes) return
        // Hysteresis for the over-budget floor: if the last prune could not get under
        // the budget, do not rewrite the whole file again until it has grown anyway.
        if (lastPruneBytes != null && totalBytes - lastPruneBytes < pruneRegrowth) return
        const keyframes = keyframeIndexes()
        if (keyframes.length == 0) { lastPruneBytes = totalBytes; return }

        // Suffix byte sums, computed once per prune.
        const suffix = new Array<number>(records.length + 1)
        suffix[records.length] = 0
        for (let index = records.length - 1; index >= 0; index--) {
            suffix[index] = suffix[index + 1] + records[index].bytes
        }

        // Oldest keyframe whose suffix fits the headroom target — the longest history
        // the budget can hold. Fall back to fitting the hard budget, then to the
        // lossless floor (latest keyframe), which may stay over budget and says so.
        let cut = -1
        for (const index of keyframes) {
            if (suffix[index] <= pruneTarget!) { cut = index; break }
        }
        if (cut < 0) for (const index of keyframes) {
            if (suffix[index] <= maxBytes) { cut = index; break }
        }
        if (cut < 0) cut = keyframes[keyframes.length - 1]
        if (cut > 0) rewriteFrom(cut)
        lastPruneBytes = totalBytes
    }

    // === ReplayStorage port ===

    function putEvents(events: readonly ReplayEvent<Z>[]) {
        if (events.length == 0) return
        if (events.length == 1) appendRecord('e', events[0])
        else appendRecord('b', events)
        mem.putEvents(events)
        maybePrune()
    }
    function putEvent(event: ReplayEvent<Z>) {
        putEvents([event])
    }
    function putKeyframe(keyframe: ReplayEvent<Z>) {
        appendRecord('k', keyframe)
        mem.putKeyframe(keyframe)
        maybePrune()
    }
    function getKeyframe(at?: {seq?: number, ts?: number}) {
        return mem.getKeyframe(at)
    }
    function getEvents(from: number, to: number) {
        return mem.getEvents(from, to)
    }
    function compact() {
        const keyframes = keyframeIndexes()
        if (keyframes.length == 0) return
        rewriteFrom(keyframes[keyframes.length - 1])
    }
    function size() {
        return {
            ...mem.size(),
            bytes: totalBytes,
            /** Only meaningful with maxBytes: the lossless floor itself exceeds the budget. */
            overBudget: maxBytes != null && totalBytes > maxBytes,
        }
    }
    return {
        putEvent,
        putEvents,
        putKeyframe,
        getKeyframe,
        getEvents,
        /** Rewrite the log as [latest keyframe + events after it] — atomic (tmp + rename). */
        compact,
        /** Introspection for metrics/tests. */
        size,
    } satisfies ReplayStorage<Z> & {compact: () => void, size: () => {events: number, keyframes: number, bytes: number, overBudget: boolean}}
}
export type FsReplayStorage = ReturnType<typeof openFsReplayStorage>
