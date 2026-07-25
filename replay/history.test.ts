// ============================================================
//  replay/history.test.ts
//
//  Layer C: archiver (keyframe cadence) + history reader.
//  Part 1 — seek by seq/ts, part 2 — playback and archive gap,
//  part 3 — handover archive → live log → live, part 4 —
//  "rewind to 12:00" with seamless catchup to live,
//  part 5 — time machine for store, part 6 — file
//  storage (jsonl) as proof "lambdas = anything".
//  Run:
//      npx ts-node replay/history.test.ts
// ============================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {applyStorePatch, applyStorePatches, createStore, StorePatch} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {replayListen, ReplayEvent} from '../src/Common/events/replay-index'
import {archiveReplay, createMemoryReplayStorage, openHistory, ReplayStorage} from '../src/Common/events/replay-index'
import {exposeStoreReplay, storeReplayAt} from '../src/Common/Observe/store-replay'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const json = (v: any) => JSON.stringify(v)
const ascendingUnique = (seqs: number[]) => seqs.every((s, i) => i == 0 || s > seqs[i - 1])

type World = {
    units: Record<string, {hp: number, x: number}>
    tick: number
}

// counter-line with injectable clock: event n = absolute value n,
// ts of event n = 1000 + 1000*n → latest envelope = state
function makeCounterLine(storage: ReplayStorage<[number]>, everyEvents: number, useAsJournal = false) {
    let clock = 1000
    let value = 0
    const [emit, replay] = replayListen<[number]>({
        current: () => [value],
        // "memory outside": live log = same archive → playback→live without jump
        ...(useAsJournal
            ? {getSince: (s: number) => storage.getEvents(s, Infinity)}
            : {history: 5}),
        now: () => clock,
    })
    const arch = archiveReplay(replay, {storage, everyEvents})
    const push = (n: number) => { value = n; clock = 1000 + 1000 * n; emit(n) }
    return {replay, arch, push}
}
const lastValue = (envs: ReplayEvent<[number]>[] | undefined) => envs ? envs[envs.length - 1].event[0] : undefined

async function main() {
    console.log('\n[history] archiver cadence + seek by seq and ts')
    {
        const storage = createMemoryReplayStorage<[number]>()
        const {arch, push} = makeCounterLine(storage, 10)
        for (let n = 1; n <= 35; n++) push(n)
        ok(storage.size().events == 35, 'every line event landed in the archive')
        ok(storage.size().keyframes == 4, `base + one keyframe per 10 events (got ${storage.size().keyframes})`)

        const h = openHistory(storage)
        const at17 = h.at({seq: 17})
        ok(lastValue(at17) == 17, 'seek by seq: keyframe + deltas reconstruct the state')
        ok(at17![0].seq == 10 && at17!.length == 8, 'reconstruction starts at the NEAREST keyframe, not from zero')
        ok(lastValue(h.at({ts: 1000 + 1000 * 12})) == 12, '«rewind to 12:00»: ts resolves to keyframe <= ts + deltas to ts')
        ok(lastValue(h.at({seq: 3})) == 3, 'before the first cadence frame the base keyframe anchors the replay')
        ok(lastValue(h.at()) == 35, 'no target = latest archived state')
        arch.close()
    }

    console.log('\n[history] time-based cadence (GOP by wall clock)')
    {
        const storage = createMemoryReplayStorage<[number]>()
        let clock = 0
        let value = 0
        const [emit, replay] = replayListen<[number]>({current: () => [value], history: 5, now: () => clock})
        const arch = archiveReplay(replay, {storage, everyEvents: 1000, everyMs: 5000})
        for (let n = 1; n <= 12; n++) { value = n; clock = n * 1000; emit(n) }
        // keyframes at ts 5000 and 10000 (+ base) — few events, time expired
        ok(arch.stats().keyframes == 3, `everyMs cuts keyframes by time when events are sparse (got ${arch.stats().keyframes})`)
        arch.close()
    }

    console.log('\n[history] pure playback + hole in the archive')
    {
        const storage = createMemoryReplayStorage<[number]>()
        const {arch, push} = makeCounterLine(storage, 10)
        for (let n = 1; n <= 35; n++) push(n)
        const h = openHistory(storage)

        const got: number[] = []
        const sub = h.subscribe(n => got.push(n), {since: 30})
        ok(json(got) == json([31, 32, 33, 34, 35]), 'playback from since = pure tail, no keyframe')
        ok(sub.seq() == 35, 'reader reports the reconnect point')
        arch.close()

        // archive with eviction: events 1..25 lost, keyframes intact
        const capped = createMemoryReplayStorage<[number]>({maxEvents: 10})
        const line2 = makeCounterLine(capped, 10)
        for (let n = 1; n <= 35; n++) line2.push(n)
        const got2: number[] = []
        openHistory(capped).subscribe(n => got2.push(n), {since: 5})
        ok(got2[0] == 30, 'hole in the archive → fresh start from the latest keyframe (reset down allowed)')
        ok(json(got2) == json([30, 31, 32, 33, 34, 35]), 'consistent tail after the keyframe, no state hole')
        line2.arch.close()
    }

    console.log('\n[history] bounded memory ring wrap + bulk/keyframe lookup')
    {
        const storage = createMemoryReplayStorage<[number]>({maxEvents: 4, maxKeyframes: 3})
        const events = Array.from({length: 10}, function makeHistoryEvent(_value, index): ReplayEvent<[number]> {
            const seq = index + 1
            return {seq, ts: seq * 100, event: [seq]}
        })
        storage.putEvents!(events)
        for (const seq of [2, 5, 8, 10]) storage.putKeyframe(events[seq - 1])

        ok(json(storage.getEvents(-1, Infinity).map(ev => ev.seq)) == json([7, 8, 9, 10]),
            'bulk append larger than the cap retains the exact newest logical window')
        ok(json(storage.getEvents(7, 9).map(ev => ev.seq)) == json([8, 9]),
            'binary seek across the physical ring wrap preserves from < seq <= to')
        ok(storage.getKeyframe({seq: 7})?.seq == 5,
            'bounded keyframe lookup by seq uses the nearest retained predecessor')
        ok(storage.getKeyframe({ts: 850})?.seq == 8,
            'bounded keyframe lookup by ts stays ordered after wrap')
        ok(storage.size().events == 4 && storage.size().keyframes == 3,
            'bounded introspection reports logical lengths, not physical slots')
    }

    console.log('\n[history] handover: archive replay → live journal → live')
    {
        const storage = createMemoryReplayStorage<[number]>()
        const {replay, arch, push} = makeCounterLine(storage, 10)  // live log: ring of 5
        for (let n = 1; n <= 35; n++) push(n)

        const got: number[] = []
        const seqs: number[] = []
        const h = openHistory(storage, replay)
        const sub = h.subscribe(n => got.push(n), {since: 20, onSeq: s => seqs.push(s)})
        ok(json(got) == json([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]),
            'archive covers what the live ring (5) evicted long ago')
        push(36)
        ok(got[got.length - 1] == 36, 'after catch-up the subscriber is LIVE on the same line')
        ok(ascendingUnique(seqs), `no gap, no dup at the handover boundary: ${seqs.join(',')}`)
        sub()
        push(37)
        ok(got[got.length - 1] == 36, 'off() disconnects the live part too')
        arch.close()
    }

    console.log('\n[history] rewind to a moment, then play forward into live (no jump)')
    {
        const storage = createMemoryReplayStorage<[number]>()
        // getSince of line looks into SAME archive → gap archive→live closed by design
        const {replay, arch, push} = makeCounterLine(storage, 10, true)
        for (let n = 1; n <= 35; n++) push(n)

        const got: number[] = []
        const seqs: number[] = []
        const h = openHistory(storage, replay)
        h.subscribe(n => got.push(n), {ts: 1000 + 1000 * 25, onSeq: s => seqs.push(s)})
        ok(got[0] == 20 && got.includes(25), 'rewind: nearest keyframe <= ts, deltas up to ts')
        ok(json(got.slice(got.indexOf(25))) == json([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]),
            'played CONTINUOUSLY from ts to the head — no keyframe jump')
        push(36)
        ok(got[got.length - 1] == 36, '…and seamlessly into live')
        ok(ascendingUnique(seqs), `seqs strictly ascending through both handovers: ${seqs.join(',')}`)
        arch.close()
    }

    console.log('\n[history] store time machine: snapshot at any seq/ts from the patch archive')
    {
        let clock = 0
        const backend = createStore<World>({units: {a: {hp: 100, x: 0}}, tick: 0}, {drain: 'micro'})
        const exposed = exposeStoreReplay(backend, {history: 8, now: () => clock})
        const storage = createMemoryReplayStorage<[StorePatch]>()
        const arch = archiveReplay(exposed.replay, {storage, everyEvents: 7})

        const snapAt: Record<number, string> = {}
        const seqAt: Record<number, number> = {}
        for (let i = 1; i <= 30; i++) {
            clock = i * 1000
            backend.state.tick = i
            if (i % 10 == 0) backend.state.units['a'].hp = 100 - i
            await flushReactive(backend.state)
            snapAt[i] = json(backend.snapshot())
            seqAt[i] = exposed.replay.head()
        }
        ok(json(storeReplayAt<World>(storage, {seq: seqAt[11]})) == snapAt[11], 'state at seq — bit-exact, though the live ring holds only 8')
        ok(json(storeReplayAt<World>(storage, {ts: 23 * 1000})) == snapAt[23], 'state at ts («what did the world look like at 12:00»)')
        ok(json(storeReplayAt<World>(storage)) == snapAt[30], 'no target = latest archived state')

        // mirror entirely from archive + live tail
        const mirror = createStore<World>({units: {}, tick: -1})
        const h = openHistory(storage, exposed.replay)
        h.subscribe(function applyToMirror(patches) { applyStorePatches(mirror, patches) })
        ok(json(mirror.state) == json(backend.snapshot()), 'mirror rebuilt from the archive matches the backend')
        backend.state.tick = 31
        await flushReactive(backend.state)
        ok(mirror.state.tick == 31, 'and keeps following live')
        arch.close()
        exposed.close()
    }

    console.log('\n[history] file-backed storage: the lambda interface is enough')
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-history-'))
        const evFile = path.join(dir, 'events.jsonl')
        const kfFile = path.join(dir, 'keyframes.jsonl')
        const readAll = (file: string): ReplayEvent<[number]>[] =>
            fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
        // naive jsonl-archive: append on write, full scan on read — enough for oracle
        const fileStorage: ReplayStorage<[number]> = {
            putEvent: ev => fs.appendFileSync(evFile, JSON.stringify(ev) + '\n'),
            putKeyframe: kf => fs.appendFileSync(kfFile, JSON.stringify(kf) + '\n'),
            getKeyframe: (at = {}) => {
                const all = readAll(kfFile)
                const fits = all.filter(kf => at.ts != null ? kf.ts <= at.ts! : kf.seq <= (at.seq ?? Infinity))
                return fits[fits.length - 1]
            },
            getEvents: (from, to) => readAll(evFile).filter(ev => ev.seq > from && ev.seq <= to),
        }
        try {
            const {arch, push} = makeCounterLine(fileStorage, 5)
            for (let n = 1; n <= 12; n++) push(n)
            const h = openHistory(fileStorage)
            ok(lastValue(h.at({seq: 8})) == 8, 'seek works over a file the same as over memory')
            const got: number[] = []
            h.subscribe(n => got.push(n), {since: 3})
            ok(json(got) == json([4, 5, 6, 7, 8, 9, 10, 11, 12]), 'playback works over a file the same as over memory')
            arch.close()
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
