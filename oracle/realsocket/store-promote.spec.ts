// REAL-SOCKET failover oracle (phase 4 of mirror plan). Hard leader loss →
// manual follower promotion: authority is built OVER mirror store (workboard
// host with deps.store), cascading journal continues to live — client subscription
// survives role change WITHOUT disruption and without re-keyframe. Epoch grows
// by 1 (fork-choice «larger epoch wins»). Split-brain tail of old
// leader is handled by diffKeyedState: non-overlapping is re-conducted with ordinary
// commands (analogous to returning orphaned branch transactions to mempool),
// conflicting pairs are saved for the application. Ports 3164/3165 (3100+).
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createWorkboardHost, WorkboardHost} from '../../demo/workboard-host'
import {createStoreFollower, diffKeyedState} from '../../src/Common/Observe/store-follower'
import {createStore, StorePatch} from '../../src/Common/Observe/store'
import {syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {ReplayRemote} from '../../src/Common/events/replay-wire'
import {WorkboardState} from '../../demo/workboard-contract'

const LEADER_PORT = 3164
const FOLLOWER_PORT = 3165
const WAIT_MS = 8000

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try { if (predicate()) return } catch {}
        await delay(10)
    }
    throw new Error('timeout waiting for ' + name)
}

async function rejectionText(work: () => Promise<any>) {
    try {
        await work()
        return null
    } catch (error: any) {
        return typeof error?.message == 'string' ? error.message : String(error)
    }
}

async function main() {
    const {check, done} = makeChecker('store-promote')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('store-promote oracle timed out')
        process.exit(3)
    }, 120000)

    // ============== old leader (epoch 1) ==============
    // Own namespace id: after failover both nodes continue their OWN counters, and
    // common prefix of work ('work-N') would collide — diff would catch it as
    // conflict (see check below). Production rule: ids must be unique
    // per node; demo-host scans occupied work-N on store acceptance.
    let oldLeaderIds = 0
    const board = createWorkboardHost({
        initial: [{id: 'seed-1', title: 'Seed card', status: 'new'}],
        makeId: function makeOldLeaderId() { return 'old-' + (++oldLeaderIds) },
    })
    let leaderConn = 0
    const leaderSrv = await startRealServer({
        port: LEADER_PORT,
        makeObject: function makeLeaderConnection() {
            const account = 'person-' + String.fromCharCode(97 + leaderConn++)
            const connection = board.connection(account)
            return {
                epoch: () => 1,
                whoami: () => account,
                workboard: connection.fragment,
                mirror: {
                    workboard: {
                        create: (who: string, input: any) => board.control.create(String(who), input),
                        rename: (who: string, input: any) => board.control.rename(String(who), input),
                    },
                },
            }
        },
    })

    // ============== follower: mirror + dynamic command dispatch ==============
    const upstream = await startRealClient({port: LEADER_PORT})
    const follower = createStoreFollower<WorkboardState>({
        remote: upstream.api.workboard.state as ReplayRemote<[StorePatch]>,
        epoch: 1,
    })
    let promotedHost: WorkboardHost | null = null
    function forwardCommand(name: 'create' | 'rename', account: string) {
        return function forwardToLeader(input: any) {
            if (promotedHost) return (promotedHost.control as any)[name](account, input)
            if (!(upstream.hub.socket as any)?.connected) throw new Error('leader offline — try again soon')
            return upstream.api.mirror.workboard[name](account, input)
        }
    }
    let followerConn = 0
    const followerSrv = await startRealServer({
        port: FOLLOWER_PORT,
        makeObject: function makeFollowerConnection() {
            const account = 'person-z' + (++followerConn)
            return {
                whoami: () => account,
                workboard: {
                    state: follower.api.replay,
                    create: forwardCommand('create', account),
                    rename: forwardCommand('rename', account),
                },
            }
        },
    })

    await follower.ready
    await check('follower starts at the leader epoch', () => follower.status.state.epoch, 1)

    // ============== follower client with live subscription ==============
    const b = await startRealClient({port: FOLLOWER_PORT})
    const bStore = createStore<WorkboardState>({})
    let bSyncErrors = 0
    const bSync = syncStoreReplay(bStore, b.api.workboard.state as ReplayRemote<[StorePatch]>, {
        onError: function bLineFailed() { bSyncErrors++ },
    })
    await bSync.ready

    // Converge before failure: everyone has seed + shared card (future conflict)
    const shared = await b.api.workboard.create({requestId: 'r-shared', title: 'Shared card'})
    await waitFor('everyone converged before the failure', () =>
        bStore.state[shared.id] != null && follower.store.state[shared.id] != null)
    const seqBeforeFailover = bSync.seq()

    // ============== hard leader loss (manual disconnect — no reconnect) ==============
    ;(upstream.hub.socket as any).disconnect()
    await waitFor('follower reports upstream offline', () => follower.status.state.upstream == 'offline')
    await check('commands fail fast before promote',
        () => rejectionText(() => Promise.resolve(b.api.workboard.create({requestId: 'r-early', title: 'Too early'}))),
        'leader offline — try again soon')

    // ============== manual promotion ==============
    const handover = follower.promote()
    promotedHost = createWorkboardHost({store: handover.store as any})
    await check('promote bumps the epoch', () => handover.epoch, 2)
    await check('status is promoted', () => follower.status.state.upstream, 'promoted')
    await check('promote is idempotent', () => follower.promote().epoch, 2)

    // Commands are applied LOCALLY; mirror state revisions are saved
    const afterPromote = await b.api.workboard.create({requestId: 'r-after', title: 'After failover'})
    await check('new leader applies commands locally', () => afterPromote.createdBy, 'person-z1')
    const renamed = await b.api.workboard.rename({
        requestId: 'r-rename', id: shared.id, expectedRevision: shared.revision, title: 'New view',
    })
    await check('adopted revisions survive the takeover', () => renamed.revision, shared.revision + 1)

    // Live client subscription SURVIVED role change: same wire, seq continued
    await waitFor('B receives post-promote items over the SAME line', () =>
        bStore.state[afterPromote.id] != null && bStore.state[shared.id]?.title == 'New view')
    await check('the client line never errored', () => bSyncErrors, 0)
    await check('cascade seq continued (no re-keyframe)', () => bSync.seq() > seqBeforeFailover, true)

    // Duplicate after failover: requestId whose receipt lived on OLD leader, hits
    // into empty receipts of new → second instance. Documented assumption
    // of manual failover (replication lag window); receipts of new hop already work
    // (see idempotency in store-mirror oracle).
    const duplicate = await b.api.workboard.create({requestId: 'r-shared', title: 'Shared card'})
    await check('documented assumption: pre-failover receipts are gone', () => duplicate.id != shared.id, true)

    // ============== split-brain: old leader alive and writes its own ==============
    const divergent = board.control.create('person-a', {requestId: 'r-div', title: 'Divergent card'})
    board.control.rename('person-a', {requestId: 'r-old-rename', id: shared.id, expectedRevision: 1, title: 'Old view'})

    // ============== rejoin: conflict-log + re-conduction ==============
    const diff = diffKeyedState(board.control.store.state, follower.store.state)
    await check('divergent tail is preserved, not dropped', () => diff.localOnly.map(item => item.title), ['Divergent card'])
    await check('both-sides edit of one card is a recorded conflict',
        () => diff.conflicts.length == 1 && diff.conflicts[0].key == shared.id
            && diff.conflicts[0].local.title == 'Old view' && diff.conflicts[0].authority.title == 'New view', true)
    await check('winner items are keyframe material', () => diff.authorityOnly.length >= 2, true)

    // Non-overlapping is re-conducted with ordinary commands of new leader (mempool-analog)
    for (const item of diff.localOnly) {
        promotedHost.control.create('person-a', {requestId: 'replay-' + item.id, title: item.title})
    }
    await check('replayed op landed on the new leader',
        () => Object.values(follower.store.state).some(item => item.title == 'Divergent card'), true)

    // Old node takes on follower role: winner keyframe over its state
    const rejoin = await startRealClient({port: FOLLOWER_PORT})
    const rejoinSync = syncStoreReplay(board.control.store, rejoin.api.workboard.state as ReplayRemote<[StorePatch]>)
    await rejoinSync.ready
    await waitFor('old node converges to the winner', () =>
        JSON.stringify(board.control.store.snapshot()) == JSON.stringify(follower.store.snapshot()))
    await check('old node adopted the winner state (deep-equal)', () => board.control.store.snapshot(), follower.store.snapshot())
    await check('B converged too', () => bStore.snapshot(), follower.store.snapshot())

    // ============== teardown ==============
    rejoinSync()
    bSync()
    follower.close()
    promotedHost.close()
    rejoin.close()
    b.close()
    upstream.close()
    board.close()
    await followerSrv.close()
    await leaderSrv.close()
    clearTimeout(watchdog)
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
