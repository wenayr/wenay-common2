// =====================================================================
// File-backed ReplayStorage — reference durability adapter (node-only)
// =====================================================================
// JSONL append-log: {"t":"e"|"k","v":ReplayEvent} per line. The whole file is
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
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue
            const rec = codec.parse(line)
            if (rec?.t == 'e') mem.putEvent(rec.v as ReplayEvent<Z>)
            else if (rec?.t == 'k') mem.putKeyframe(rec.v as ReplayEvent<Z>)
        }
    }
    function append(t: 'e' | 'k', v: ReplayEvent<Z>) {
        fs.appendFileSync(file, codec.stringify({t, v}) + '\n')
    }
    return {
        putEvent: (ev: ReplayEvent<Z>) => { mem.putEvent(ev); append('e', ev) },
        putKeyframe: (kf: ReplayEvent<Z>) => { mem.putKeyframe(kf); append('k', kf) },
        getKeyframe: (at?: {seq?: number, ts?: number}) => mem.getKeyframe(at),
        getEvents: (from: number, to: number) => mem.getEvents(from, to),
        /** Rewrite the log as [latest keyframe + events after it] — atomic (tmp + rename). */
        compact: () => {
            const kf = mem.getKeyframe()
            if (!kf) return
            const tail = mem.getEvents(kf.seq, Infinity)
            const tmp = file + '.tmp'
            const lines = [codec.stringify({t: 'k', v: kf}), ...tail.map(ev => codec.stringify({t: 'e', v: ev}))]
            fs.writeFileSync(tmp, lines.join('\n') + '\n')
            fs.renameSync(tmp, file)
            const next = createMemoryReplayStorage<Z>()
            next.putKeyframe(kf)
            for (const ev of tail) next.putEvent(ev)
            mem = next
        },
        /** Introspection for metrics/tests. */
        size: () => mem.size(),
    } satisfies ReplayStorage<Z> & {compact: () => void, size: () => {events: number, keyframes: number}}
}
export type FsReplayStorage = ReturnType<typeof openFsReplayStorage>
