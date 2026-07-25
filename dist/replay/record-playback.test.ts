// ============================================================
//  replay/record-playback.test.ts
//
//  Flight recorder: archiveReplay + createJsonlReplayWriter records a live
//  patch line to JSONL; loadJsonlReplay lifts it back into a ReplayStorage;
//  storeReplayAt gives random access; playbackStoreReplay re-emits the line
//  into a fresh head — instantly (speed: Infinity) or paced — and an ordinary
//  mirror consumes the playback exactly like a live line.
//  Run: npx tsx replay/record-playback.test.ts
// ============================================================

import {createStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {exposeStoreReplay, storeReplayAt, syncStoreReplay} from '../src/Common/Observe/store-replay'
import {playbackStoreReplay} from '../src/Common/Observe/store-playback'
import {archiveReplay} from '../src/Common/events/replay-history'
import {createJsonlReplayWriter, loadJsonlReplay} from '../src/Common/events/replay-record'
import {StoreReplayRemote} from '../src/Common/Observe/store-replay'
import {StorePatch} from '../src/Common/Observe/store'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (v: any) => JSON.stringify(v)

async function main() {
    // === record a live line (deterministic ts through the injected clock) ===
    let t = 1000
    const src = createStore<Record<string, any>>({}, {drain: 'micro'})
    const exposed = exposeStoreReplay(src, {now: () => t})
    const lines: string[] = []
    const rec = archiveReplay(exposed.replay, {storage: createJsonlReplayWriter(line => lines.push(line)), everyEvents: 3})
    for (let i = 1; i <= 7; i++) {
        t += 10
        src.state['k' + i] = {v: i}
        await flushReactive(src.state); await tick()
    }
    rec.close(); exposed.close()
    ok(lines.length >= 8, 'recording carries baseline keyframe + 7 events (+cadence keyframes), got ' + lines.length)
    ok(rec.stats().events == 7, 'archiver counted 7 events')

    // === lift the recording back ===
    const loaded = loadJsonlReplay<[readonly StorePatch[]]>(lines)

    // random access — the existing time machine works on a recording as-is
    const mid = storeReplayAt<Record<string, any>>(loaded, {seq: 3})
    ok(json(mid) == json({k1: {v: 1}, k2: {v: 2}, k3: {v: 3}}), 'storeReplayAt(seq 3) reconstructs the mid state')

    // === instant playback ===
    const instant = playbackStoreReplay<Record<string, any>>(loaded, {speed: Infinity})
    await instant.done
    ok(json(instant.store.snapshot()) == json(src.snapshot()), 'instant playback converges to the source state')
    ok(instant.range.from == 0 && instant.range.to == 7, 'playback range spans the recording, got ' + json(instant.range))
    instant.close()

    // === paced playback consumed by an ordinary mirror ===
    const paced = playbackStoreReplay<Record<string, any>>(loaded, {speed: 1000})
    const mirror = createStore<Record<string, any>>({}, {drain: 'micro'})
    const sub = syncStoreReplay(mirror, paced.api.replay as StoreReplayRemote)
    await sub.ready
    await paced.done
    await flushReactive(paced.store.state); await delay(20)
    ok(json(mirror.snapshot()) == json(src.snapshot()), 'paced playback mirrored like a live line')
    sub(); paced.close()

    console.log(fails ? `record-playback: ${fails} FAILED` : 'record-playback: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
