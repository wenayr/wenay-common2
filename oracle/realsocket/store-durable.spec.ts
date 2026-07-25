// REAL-SOCKET durable head oracle: the replay line survives a process restart.
// Lifetime 1 writes through a real socket into a file-journaled head; everything
// is torn down; lifetime 2 reboots from the SAME file — state and seq restored,
// a mirror reconnecting with its old seq gets the exact persisted tail (no
// keyframe reset), new writes continue the seq line, and a compacted archive
// falls back to a loud keyframe. Port 3166 (3100+ range).
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {openFsReplayStorage} from '../../src/server/fsReplayStorage'
import {createDurableStoreReplay} from '../../src/Common/Observe/store-durable'
import {createStore, StorePatch} from '../../src/Common/Observe/store'
import {StoreReplayRemote, syncStoreReplay} from '../../src/Common/Observe/store-replay'

const PORT = 3166

async function main() {
    const {check, done} = makeChecker('store-durable')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('store-durable oracle timed out')
        process.exit(3)
    }, 120000)
    const file = path.join(os.tmpdir(), `wenay-durable-${process.pid}-${Date.now()}.jsonl`)

    // ============== lifetime 1: journaled head + real-socket mirror ==============
    let storage = openFsReplayStorage<[readonly StorePatch[]]>(file)
    let head = createDurableStoreReplay<Record<string, any>>({storage, initial: {}, everyEvents: 4})
    await check('fresh boot restores nothing', () => head.restored, {seq: 0, fromArchive: false})

    let srv = await startRealServer({port: PORT, makeObject: () => ({board: head.api})})
    const c1 = await startRealClient({port: PORT})
    const m1 = createStore<Record<string, any>>({}, {drain: 'micro'})
    const sub1 = syncStoreReplay(m1, c1.api.board.replay as StoreReplayRemote)
    await sub1.ready
    for (let i = 1; i <= 6; i++) head.store.state['item' + i] = {n: i}
    await delay(200)
    await check('mirror followed lifetime 1', () => m1.snapshot(), head.store.snapshot())
    const seqAtDeath = sub1.seq()
    await check('six writes share one V2 drain coordinate', () => seqAtDeath, 1)

    // ============== death: close everything, only the file remains ==============
    sub1(); c1.close()
    await srv.close()
    head.close()

    // ============== lifetime 2: reboot from the same file ==============
    storage = openFsReplayStorage<[readonly StorePatch[]]>(file)
    head = createDurableStoreReplay<Record<string, any>>({storage, initial: {}, everyEvents: 4})
    await check('reboot restored the head coordinate', () => head.restored, {seq: 1, fromArchive: true})
    await check('reboot restored the state', () => head.store.snapshot()['item6'], {n: 6})

    srv = await startRealServer({port: PORT, makeObject: () => ({board: head.api})})
    const c2 = await startRealClient({port: PORT})
    const remote2 = c2.api.board.replay as StoreReplayRemote

    // reconnect with the OLD seq: the persisted journal serves the exact tail
    head.store.state['item7'] = {n: 7}
    await delay(100)
    let rootPatches = 0, deltaPatches = 0
    const probeStore = createStore<Record<string, any>>({})
    const probe = syncStoreReplay(probeStore, remote2, {
        since: seqAtDeath,
        onBatch(patches) {
            for (const patch of patches) {
                if (patch.path.length == 0) rootPatches++
                else deltaPatches++
            }
        },
    })
    await probe.ready
    await check('old-seq reconnect got the exact persisted tail (no keyframe reset)',
        () => ({rootPatches, deltas: deltaPatches >= 1}), {rootPatches: 0, deltas: true})
    probe()

    // a reconnecting mirror carries its pre-death state — that is what since means
    const m2 = createStore<Record<string, any>>(m1.snapshot(), {drain: 'micro'})
    const sub2 = syncStoreReplay(m2, remote2, {since: seqAtDeath})
    await sub2.ready
    await delay(100)
    await check('reconnected mirror converged across the restart', () => m2.snapshot(), head.store.snapshot())
    await check('new writes continue the seq line (no reuse)', () => sub2.seq() > seqAtDeath, true)
    sub2()

    // ============== compaction: pre-compact seq honestly resets by keyframe ==============
    storage.compact()
    let rootAfterCompact = 0
    const compactStore = createStore<Record<string, any>>({})
    const probe2 = syncStoreReplay(compactStore, remote2, {
        since: 0,
        onBatch(patches) {
            for (const patch of patches) if (patch.path.length == 0) rootAfterCompact++
        },
    })
    await probe2.ready
    await check('compacted archive falls back to a loud keyframe', () => rootAfterCompact, 1)
    probe2()

    // ============== cleanup ==============
    c2.close()
    await srv.close()
    head.close()
    fs.rmSync(file, {force: true})
    clearTimeout(watchdog)
    process.exit(done() ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
