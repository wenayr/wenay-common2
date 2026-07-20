// =====================================================================
// Flight recorder — line ⇄ JSONL: record any replay line, lift it back
// =====================================================================
// Recording IS archiveReplay with a write-only storage:
//     const rec = archiveReplay(replay, {storage: createJsonlReplayWriter(line => sink(line))})
// [baseline keyframe + every envelope + cadence keyframes] stream into the sink
// (file append, network, plain array). loadJsonlReplay lifts the lines back into
// the in-memory ReplayStorage — everything that reads the port (openHistory,
// storeReplayAt, playbackStoreReplay) works on a recording exactly as on a live
// archive. Store-flavored playback lives in Observe/store-playback (store
// integration stays next to the store by design).

import {ReplayEvent} from './replay-listen'
import {ReplayStorage, createMemoryReplayStorage} from './replay-history'

export type ReplayRecordCodec = {stringify: (v: any) => string, parse: (line: string) => any}
const JSON_CODEC: ReplayRecordCodec = {stringify: JSON.stringify, parse: JSON.parse}

/** Write-only ReplayStorage: every put becomes one JSONL line in the sink. Getters honestly refuse. */
export function createJsonlReplayWriter<Z extends any[] = any[]>(write: (line: string) => void, codec: ReplayRecordCodec = JSON_CODEC): ReplayStorage<Z> {
    return {
        putEvent: ev => write(codec.stringify({t: 'e', v: ev})),
        putKeyframe: kf => write(codec.stringify({t: 'k', v: kf})),
        getKeyframe: () => undefined,   // write-only: a recording sink, not an archive
        getEvents: () => [],
    }
}

/** Lift recorded JSONL lines back into a seekable in-memory ReplayStorage. */
export function loadJsonlReplay<Z extends any[] = any[]>(lines: Iterable<string> | string, codec: ReplayRecordCodec = JSON_CODEC) {
    const storage = createMemoryReplayStorage<Z>()
    const list = typeof lines == 'string' ? lines.split(/\r?\n/) : lines
    for (const line of list) {
        if (!line || !line.trim()) continue
        const rec = codec.parse(line)
        if (rec?.t == 'e') storage.putEvent(rec.v as ReplayEvent<Z>)
        else if (rec?.t == 'k') storage.putKeyframe(rec.v as ReplayEvent<Z>)
    }
    return storage
}
