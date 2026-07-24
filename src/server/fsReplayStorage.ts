// =====================================================================
// File-backed ReplayStorage — reference durability adapter (node-only)
// =====================================================================
// JSONL append-log: event/keyframe records plus atomic multi-event batch records. The whole file is
// loaded at open into the in-memory reference storage (which stays the seek
// index); every put appends one line synchronously. This is the REFERENCE
// implementation: honest, restart-safe and simple — swap in a DB/batched
// adapter through the same ReplayStorage port when volume demands it.
// Values must survive the codec (default JSON): plain data only.

import * as fs from 'fs'
import * as path from 'path'
import {ReplayEvent} from '../Common/events/replay-listen'
import {ReplayStorage, createMemoryReplayStorage} from '../Common/events/replay-history'

export type FsReplayStorageOpts = {
    /** Envelope codec (default JSON.stringify/parse) — swap for rich types. */
    codec?: {stringify: (v: any) => string, parse: (line: string) => any}
}

export function openFsReplayStorage<Z extends any[] = any[]>(file: string, opts: FsReplayStorageOpts = {}) {
    const codec = opts.codec ?? {stringify: JSON.stringify, parse: JSON.parse}
    fs.mkdirSync(path.dirname(file), {recursive: true})
    let mem = createMemoryReplayStorage<Z>()
    if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file)
        const committedBytes = bytes.lastIndexOf(10) + 1
        // A bulk is one newline-terminated record. A torn final append has no
        // terminator, so it is uncommitted and must not poison the next append.
        if (committedBytes != bytes.byteLength) fs.truncateSync(file, committedBytes)
        for (const line of bytes.subarray(0, committedBytes).toString('utf8').split(/\r?\n/)) {
            if (!line.trim()) continue
            const rec = codec.parse(line)
            if (rec?.t == 'e') mem.putEvent(rec.v as ReplayEvent<Z>)
            else if (rec?.t == 'b') mem.putEvents(rec.v as ReplayEvent<Z>[])
            else if (rec?.t == 'k') mem.putKeyframe(rec.v as ReplayEvent<Z>)
        }
    }
    function appendRecord(record: any) {
        const line = codec.stringify(record) + '\n'
        const start = fs.existsSync(file) ? fs.statSync(file).size : 0
        try { fs.appendFileSync(file, line) }
        catch (error) {
            // Roll back a partial append while the process is alive. After a
            // crash, the open-time newline check performs the same recovery.
            try { if (fs.existsSync(file)) fs.truncateSync(file, start) } catch {}
            throw error
        }
    }
    function append(t: 'e' | 'k', v: ReplayEvent<Z>) {
        appendRecord({t, v})
    }
    function putEvents(events: readonly ReplayEvent<Z>[]) {
        if (events.length == 0) return
        const record = events.length == 1 ? {t: 'e', v: events[0]} : {t: 'b', v: events}
        appendRecord(record)
        mem.putEvents(events)
    }
    function putEvent(event: ReplayEvent<Z>) {
        putEvents([event])
    }
    function putKeyframe(keyframe: ReplayEvent<Z>) {
        append('k', keyframe)
        mem.putKeyframe(keyframe)
    }
    function getKeyframe(at?: {seq?: number, ts?: number}) {
        return mem.getKeyframe(at)
    }
    function getEvents(from: number, to: number) {
        return mem.getEvents(from, to)
    }
    function compact() {
        const keyframe = mem.getKeyframe()
        if (!keyframe) return
        const tail = mem.getEvents(keyframe.seq, Infinity)
        const tmp = file + '.tmp'
        const lines = [codec.stringify({t: 'k', v: keyframe}), ...tail.map(function encodeTailEvent(event) {
            return codec.stringify({t: 'e', v: event})
        })]
        fs.writeFileSync(tmp, lines.join('\n') + '\n')
        fs.renameSync(tmp, file)
        const next = createMemoryReplayStorage<Z>()
        next.putKeyframe(keyframe)
        for (const event of tail) next.putEvent(event)
        mem = next
    }
    function size() {
        return mem.size()
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
    } satisfies ReplayStorage<Z> & {compact: () => void, size: () => {events: number, keyframes: number}}
}
export type FsReplayStorage = ReturnType<typeof openFsReplayStorage>
