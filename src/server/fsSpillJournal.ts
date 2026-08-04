// =====================================================================
// File-backed spill journal — RAM-first replay window, disk on eviction
// =====================================================================
// The third retention mode, between "bounded RAM ring" and "always-on durable
// journal" (fsReplayStorage): recent history lives in a RAM ring exactly as the
// line's internal journal would keep it, and the disk is written ONLY when the
// ring evicts — the spilled prefix extends "how long can a client be away and
// still get its exact tail" without paying steady-state SSD writes. In the
// common case (every consumer within the RAM window) the disk is never touched.
//
// What this mode deliberately does NOT promise:
//   * restart durability — a previous process's spill has an unfillable gap
//     (its RAM suffix died with it), so open() starts a FRESH lifetime and
//     removes leftovers. Restart-safe lines are createDurableStoreReplay's job.
//   * per-event durability — spilling is best-effort: if the disk write fails,
//     the evicted window is simply lost and an old reader gets the keyframe
//     reset it would have gotten without a spill at all. Errors are counted,
//     never thrown into the producer's emit.
//
// Disk shape: JSONL, one line per evicted batch, two segments rotated at
// maxBytes/2 (append-only, prune = drop the older segment — no rewrites, so a
// 1 GiB budget never costs a 1 GiB copy). Nothing on disk is mirrored in RAM
// beyond a tiny per-batch index; reads open the file only on a cache-miss
// getSince — the rare "client back from the elevator" moment.

import * as fs from 'fs'
import * as path from 'path'
import {ReplayEvent} from '../Common/events/replay-listen'
import {positiveIntegerOption} from '../Common/positive-integer-option'

export type FsSpillJournalOpts = {
    /** RAM ring cap in events — the spill boundary. Consumers within it never cost disk IO. */
    history: number
    /** Total disk budget in bytes (both segments). Oldest spilled batches fall off beyond it. */
    maxBytes: number
    /** Envelope codec (default JSON.stringify/parse) — swap for rich types. */
    codec?: {stringify: (v: any) => string, parse: (line: string) => any}
}

type tSpillRecord = {first: number, last: number, offset: number, bytes: number}
type tSpillSegment = {file: string, records: tSpillRecord[], bytes: number}

export function openFsSpillJournal<Z extends any[] = any[]>(file: string, opts: FsSpillJournalOpts) {
    const history = positiveIntegerOption(opts.history, 1, 'openFsSpillJournal: history')
    const maxBytes = positiveIntegerOption(opts.maxBytes, 2, 'openFsSpillJournal: maxBytes')
    const codec = opts.codec ?? {stringify: JSON.stringify, parse: JSON.parse}
    const segmentBytes = Math.max(1, maxBytes >> 1)
    const prevFile = file + '.1'

    fs.mkdirSync(path.dirname(file), {recursive: true})
    // Fresh lifetime by construction — see the header for why leftovers cannot serve.
    for (const leftover of [file, prevFile]) fs.rmSync(leftover, {force: true})

    let prev: tSpillSegment | null = null
    let curr: tSpillSegment = {file, records: [], bytes: 0}
    let closed = false
    let spillErrors = 0

    // RAM ring: head/tail window, the same discipline as the line's internal journal
    // (evicted slots are nulled immediately, the empty prefix is reclaimed when it dominates).
    let entries: (ReplayEvent<Z> | undefined)[] = []
    let start = 0
    let head = 0

    function ramCount() {
        return entries.length - start
    }
    function ramOldestSeq() {
        return ramCount() > 0 ? entries[start]!.seq : null
    }
    function compactRam() {
        if (start > 64 && start * 2 > entries.length) {
            entries = entries.slice(start)
            start = 0
        }
    }

    // A failed spill (append or rotate) degrades to "no disk window": indexes drop,
    // files are removed best-effort, readers older than RAM get a keyframe reset.
    function dropDiskWindow() {
        spillErrors++
        prev = null
        curr = {file, records: [], bytes: 0}
        for (const stale of [file, prevFile]) {
            try { fs.rmSync(stale, {force: true}) } catch {}
        }
    }

    function rotateSegments() {
        try {
            fs.rmSync(prevFile, {force: true})
            fs.renameSync(file, prevFile)
        } catch {
            dropDiskWindow()
            return
        }
        prev = {file: prevFile, records: curr.records, bytes: curr.bytes}
        curr = {file, records: [], bytes: 0}
    }

    function spill(evicted: ReplayEvent<Z>[]) {
        const line = codec.stringify(evicted) + '\n'
        const bytes = Buffer.byteLength(line, 'utf8')
        try { fs.appendFileSync(file, line) }
        catch { dropDiskWindow(); return }
        curr.records.push({first: evicted[0].seq, last: evicted[evicted.length - 1].seq, offset: curr.bytes, bytes})
        curr.bytes += bytes
        if (curr.bytes >= segmentBytes) rotateSegments()
    }

    function evictOverflow() {
        if (ramCount() <= history) return
        const overflow: ReplayEvent<Z>[] = []
        while (ramCount() > history) {
            overflow.push(entries[start]!)
            entries[start] = undefined
            start++
        }
        compactRam()
        if (!closed) spill(overflow)
    }

    function onJournal(ev: ReplayEvent<Z>) {
        if (closed) return
        entries.push(ev)
        head = ev.seq
        evictOverflow()
    }

    /** Oldest seq the journal can still prove contiguously (disk prefix + RAM). */
    function oldestSeq() {
        if (prev && prev.records.length) return prev.records[0].first
        if (curr.records.length) return curr.records[0].first
        return ramOldestSeq()
    }

    function readSegment(segment: tSpillSegment, sinceSeq: number, out: ReplayEvent<Z>[]) {
        const needed = segment.records.filter(record => record.last > sinceSeq)
        if (needed.length == 0) return true
        let fd: number
        try { fd = fs.openSync(segment.file, 'r') }
        catch { return false }
        try {
            for (const record of needed) {
                const buf = Buffer.alloc(record.bytes)
                const read = fs.readSync(fd, buf, 0, record.bytes, record.offset)
                if (read != record.bytes) return false
                const batch = codec.parse(buf.toString('utf8').trim()) as ReplayEvent<Z>[]
                for (const ev of batch) if (ev.seq > sinceSeq) out.push(ev)
            }
            return true
        } catch { return false }
        finally { try { fs.closeSync(fd) } catch {} }
    }

    function getSince(seq: number): ReplayEvent<Z>[] | undefined {
        if (seq > head) return undefined // foreign lifetime → keyframe reset
        if (seq == head) return []
        const provable = oldestSeq()
        if (provable == null || seq + 1 < provable) return undefined
        const out: ReplayEvent<Z>[] = []
        const ramOldest = ramOldestSeq()
        if (ramOldest == null || seq + 1 < ramOldest) {
            if (prev && !readSegment(prev, seq, out)) return undefined
            if (!readSegment(curr, seq, out)) return undefined
        }
        for (let index = start; index < entries.length; index++) {
            const ev = entries[index]!
            if (ev.seq > seq) out.push(ev)
        }
        // The tail must be provable, not merely plausible: any gap (torn read, prune
        // race, codec surprise) degrades to the keyframe reset the wire already knows.
        let expected = seq + 1
        for (const ev of out) {
            if (ev.seq != expected) return undefined
            expected++
        }
        return out
    }

    function size() {
        const segments = [prev, curr].filter(Boolean) as tSpillSegment[]
        let diskEvents = 0
        let diskBytes = 0
        for (const segment of segments) {
            diskBytes += segment.bytes
            for (const record of segment.records) diskEvents += record.last - record.first + 1
        }
        return {
            ramEvents: ramCount(),
            diskEvents,
            diskBytes,
            oldestSeq: oldestSeq(),
            head,
            /** Failed spills so far: each one shrank the provable window to RAM. */
            spillErrors,
        }
    }

    function close() {
        if (closed) return
        closed = true
        entries = []
        start = 0
        prev = null
        curr = {file, records: [], bytes: 0}
        for (const owned of [file, prevFile]) {
            try { fs.rmSync(owned, {force: true}) } catch {}
        }
    }

    return {
        /** Wire into the line: exposeStoreReplay(store, {...spill.line}) or
         *  replayListen(base, {current, ...spill.line}). getSince replaces the line's
         *  internal ring, so the RAM window lives here exactly once. */
        line: {getSince, onJournal},
        /** Introspection for metrics/tests. */
        size,
        /** Stop journaling and remove the spill files — they cannot serve a next lifetime. */
        close,
    }
}
export type FsSpillJournal = ReturnType<typeof openFsSpillJournal>
