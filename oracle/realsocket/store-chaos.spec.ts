// REAL-SOCKET chaos oracle: a seeded random schedule of writes, edge-mirror
// bounces (disconnect + reconnect with since) and a mid-cascade leader kill +
// promote over leader → follower → edge. Invariants: the edge converges to the
// authority model, delivered seq stays monotonic, epoch grows exactly once and
// the follower line survives the role change. Deterministic PRNG (mulberry32),
// small journal (history: 16) so bounces exercise both tail and keyframe paths.
// Ports 3167/3168 (3100+ range).
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createStore, StorePatch} from '../../src/Common/Observe/store'
import {exposeStoreReplay, syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {ReplayRemote} from '../../src/Common/events/replay-wire'

const LEADER_PORT = 3167
const MID_PORT = 3168

function mulberry32(seed: number) {
    let a = seed >>> 0
    return function rand() {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const sortedJson = (o: Record<string, any>) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]))

async function main() {
    const {check, done} = makeChecker('store-chaos')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('store-chaos oracle timed out')
        process.exit(3)
    }, 120000)
    const rand = mulberry32(0xC0FFEE)
    const model: Record<string, any> = {}
    let n = 0

    // ============== leader with a deliberately small journal ==============
    const leaderStore = createStore<Record<string, any>>({}, {drain: 'micro'})
    const leader = exposeStoreReplay(leaderStore, {history: 16})
    const leaderSrv = await startRealServer({port: LEADER_PORT, makeObject: () => ({board: leader.api})})

    // ============== mid: follower of the leader, serving its own cascade ==============
    const up = await startRealClient({port: LEADER_PORT})
    const mid = createStoreFollower<Record<string, any>>({remote: up.api.board.replay as ReplayRemote<[StorePatch]>, initial: {}, epoch: 0})
    await mid.ready
    const midSrv = await startRealServer({port: MID_PORT, makeObject: () => ({board: mid.api})})

    // ============== edge: bounce-able mirror of the cascade ==============
    const edge = createStore<Record<string, any>>({}, {drain: 'micro'})
    const seqs: number[] = []
    let edgeClient = await startRealClient({port: MID_PORT})
    let edgeSub = syncStoreReplay(edge, edgeClient.api.board.replay as ReplayRemote<[StorePatch]>, {onSeq: s => seqs.push(s)})
    await edgeSub.ready

    async function bounceEdge() {
        edgeSub()
        edgeClient.close()
        await delay(15 + Math.floor(rand() * 30))
        edgeClient = await startRealClient({port: MID_PORT})
        const since = seqs.length ? seqs[seqs.length - 1] : -1
        edgeSub = syncStoreReplay(edge, edgeClient.api.board.replay as ReplayRemote<[StorePatch]>, {since, onSeq: s => seqs.push(s)})
        await edgeSub.ready
    }

    // ============== phase 1: random writes + edge bounces under a live leader ==============
    for (let i = 0; i < 60; i++) {
        const r = rand()
        if (r < 0.65) {
            const k = 'k' + Math.floor(rand() * 12)
            const v = {n: ++n}
            leaderStore.state[k] = v
            model[k] = v
        } else if (r < 0.85) {
            await bounceEdge()
        } else {
            await delay(5 + Math.floor(rand() * 15))
        }
    }
    await delay(300)
    await check('phase 1: edge converged through random bounces',
        () => sortedJson(edge.snapshot()) == sortedJson(model), true)
    await check('phase 1: mid mirrors the authority exactly',
        () => sortedJson(mid.store.snapshot()) == sortedJson(model), true)

    // ============== phase 2: kill the leader, promote mid, keep writing ==============
    // Kill ABRUPTLY (transport death, as a dead process): a graceful server close ends
    // the line loudly → follower goes terminal 'closed' and promote() rightly refuses.
    leaderSrv.ioServer.disconnectSockets(true)
    await delay(150)
    await check('follower saw the leader die as transport loss (offline, not closed)',
        () => mid.status.state.upstream, 'offline')
    const promoted = mid.promote()
    await check('promotion bumps the epoch once', () => promoted.epoch, 1)
    up.close()
    await leaderSrv.close()
    await check('follower role is terminal after promote', () => mid.status.state.upstream, 'promoted')

    for (let i = 0; i < 30; i++) {
        const r = rand()
        if (r < 0.7) {
            const k = 'k' + Math.floor(rand() * 12)
            const v = {n: ++n}
            mid.store.state[k] = v
            model[k] = v
        } else if (r < 0.85) {
            await bounceEdge()
        } else {
            await delay(5 + Math.floor(rand() * 15))
        }
    }
    await delay(300)
    await check('phase 2: edge follows the promoted authority (line unbroken)',
        () => sortedJson(edge.snapshot()) == sortedJson(model), true)
    await check('edge seq delivery stayed monotonic across all chaos',
        () => seqs.every((s, i) => i == 0 || s >= seqs[i - 1]), true)
    await check('edge really did progress', () => seqs.length >= 30, true)

    // ============== cleanup ==============
    edgeSub()
    edgeClient.close()
    await midSrv.close()
    mid.close()
    clearTimeout(watchdog)
    process.exit(done() ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
