// REAL-SOCKET store follower oracle. Лидер-инстанс владеет workboard-стором;
// follower-инстанс (createStoreFollower) зеркалит его по replay-линии и раздаёт
// СВОИМ клиентам каскадным exposeStoreReplay; команды форвардятся лидеру со
// сквозным (account, requestId) — квитанции остаются только у лидера.
// Обрыв апстрима — честный Engine.IO close (авто-reconnect того же Socket).
// Порты 3160 (лидер) / 3161 (фолловер) — правило проекта: диапазон 3100+.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createWorkboardHost} from '../../demo/workboard-host'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {createStore, StorePatch} from '../../src/Common/Observe/store'
import {syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {ReplayRemote} from '../../src/Common/events/replay-wire'
import {WorkboardState} from '../../demo/workboard-contract'

const LEADER_PORT = 3160
const FOLLOWER_PORT = 3161
const WAIT_MS = 8000

type tClient = Awaited<ReturnType<typeof startRealClient>>

async function waitFor(name: string, predicate: () => boolean, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs
    let lastError: any = null
    while (Date.now() < deadline) {
        try {
            if (predicate()) return
        } catch (e) {
            lastError = e
        }
        await delay(10)
    }
    const suffix = lastError == null ? '' : ': ' + String(lastError?.message ?? lastError)
    throw new Error('timeout waiting for ' + name + suffix)
}

function errorMessage(error: any) {
    if (typeof error?.message == 'string') return error.message
    if (typeof error?.error?.message == 'string') return error.error.message
    return String(error)
}

async function rejectionText(work: () => Promise<any>) {
    try {
        await work()
        return null
    } catch (error) {
        return errorMessage(error)
    }
}

// Транзиентный сетевой обрыв: Engine.IO close → Socket.IO обязан переподключить
// ТОТ ЖЕ Socket сам (Socket#disconnect() был бы ручным и reconnect не запустил бы).
async function breakTransport(cli: tClient, label: string) {
    const socket = cli.hub.socket as any
    if (!socket?.connected) throw new Error(label + ': socket is not connected')
    const count = cli.hub.connectCount()
    const engine = socket.io?.engine
    if (!engine?.close) throw new Error(label + ': Engine.IO close() is unavailable')
    engine.close()
    await waitFor(label + ' disconnect', () => !socket.connected)
    return {socket, count}
}

async function main() {
    const {check, done} = makeChecker('store-mirror')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('store-mirror oracle timed out')
        process.exit(3)
    }, 120000)

    // ============== лидер: авторитетный workboard + mirror-команды ==============
    const board = createWorkboardHost({initial: [{id: 'seed-1', title: 'Seed card', status: 'new'}]})
    let leaderConn = 0
    const leaderSrv = await startRealServer({
        port: LEADER_PORT,
        makeObject: function makeLeaderConnection() {
            const account = 'person-' + String.fromCharCode(97 + leaderConn++)
            const connection = board.connection(account)
            return {
                whoami: () => account,
                workboard: connection.fragment,
                // Доверенный вход для зеркала: команды с ЯВНЫМ account конечного клиента.
                // Квитанции (account, requestId) продолжают работать сквозь хоп.
                mirror: {
                    workboard: {
                        create: (who: string, input: any) => board.control.create(String(who), input),
                        rename: (who: string, input: any) => board.control.rename(String(who), input),
                        move: (who: string, input: any) => board.control.move(String(who), input),
                        assign: (who: string, input: any) => board.control.assign(String(who), input),
                        remove: (who: string, input: any) => board.control.remove(String(who), input),
                    },
                },
            }
        },
    })

    // ============== follower-инстанс: клиент лидера + сервер для своих ==============
    const upstream = await startRealClient({port: LEADER_PORT})
    const follower = createStoreFollower<WorkboardState>({
        remote: upstream.api.workboard.state as ReplayRemote<[StorePatch]>,
    })
    function forwardCommand(name: 'create' | 'rename' | 'move' | 'assign' | 'remove', who: string) {
        return function forwardToLeader(input: any) {
            if (!(upstream.hub.socket as any)?.connected) throw new Error('leader offline — try again soon')
            return upstream.api.mirror.workboard[name](who, input)
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
                    move: forwardCommand('move', account),
                    assign: forwardCommand('assign', account),
                    remove: forwardCommand('remove', account),
                },
            }
        },
    })

    await follower.ready
    const seqAtReady = follower.status.state.seq
    await check('follower keyframe converges', () => follower.store.snapshot(), board.control.store.snapshot())
    await check('follower upstream is live', () => follower.status.state.upstream, 'live')

    // ============== клиенты на разных инстансах ==============
    const a = await startRealClient({port: LEADER_PORT})
    const b = await startRealClient({port: FOLLOWER_PORT})
    const bStore = createStore<WorkboardState>({})
    const bSync = syncStoreReplay(bStore, b.api.workboard.state as ReplayRemote<[StorePatch]>)
    await bSync.ready
    await check('B (follower client) sees the seed via cascade', () => bStore.snapshot(), board.control.store.snapshot())

    // A (клиент лидера) пишет → реактивно доезжает клиенту B через зеркало
    const fromLeader = await a.api.workboard.create({requestId: 'r-a1', title: 'From leader'})
    await waitFor('follower mirrors the leader write', () => follower.store.state[fromLeader.id] != null)
    await waitFor('B receives it via cascade', () => bStore.state[fromLeader.id] != null)
    await check('mirrored item equals the leader item', () => bStore.state[fromLeader.id], board.control.store.state[fromLeader.id])

    // B (клиент зеркала) пишет → форвард лидеру → реактивно возвращается всем
    const fromFollower = await b.api.workboard.create({requestId: 'r-b1', title: 'From follower'})
    await check('forwarded command keeps the end-client account', () => fromFollower.createdBy, 'person-z1')
    await waitFor('leader applied the forwarded write', () => board.control.store.state[fromFollower.id] != null)
    await waitFor('B sees its own write round-tripped', () => bStore.state[fromFollower.id] != null)

    // Идемпотентность сквозь хоп: тот же requestId → та же квитанция, не второй item
    const duplicate = await b.api.workboard.create({requestId: 'r-b1', title: 'From follower'})
    await check('double-submit through the mirror returns the receipt', () => duplicate.id, fromFollower.id)
    await check('no duplicate item on the leader', () => Object.keys(board.control.store.state).length, 3)

    // Конфликт ревизии сквозь хоп — тот же текст, что и напрямую у лидера
    const directConflict = await rejectionText(() => Promise.resolve(a.api.workboard.rename({
        requestId: 'r-a2', id: fromFollower.id, expectedRevision: 99, title: 'Direct rename',
    })))
    const forwardedConflict = await rejectionText(() => Promise.resolve(b.api.workboard.rename({
        requestId: 'r-b2', id: fromFollower.id, expectedRevision: 99, title: 'Forwarded rename',
    })))
    await check('revision conflict text passes the hop unchanged', () => forwardedConflict, directConflict)

    // ============== потеря лидера: stale-чтение + быстрый отказ + догон ==============
    const broken = await breakTransport(upstream, 'upstream')
    await waitFor('follower reports upstream offline', () => follower.status.state.upstream == 'offline')
    await check('stale reads still serve on the follower', () => follower.store.state[fromLeader.id]?.title, 'From leader')
    await check('commands fail fast while the leader is away',
        () => rejectionText(() => Promise.resolve(b.api.workboard.create({requestId: 'r-b3', title: 'Too early'}))),
        'leader offline — try again soon')

    // Пока зеркало офлайн — лидер живёт дальше (пишет клиент A)
    const whileAway = await a.api.workboard.create({requestId: 'r-a3', title: 'While away'})
    await delay(150)
    await check('follower does NOT see the write yet', () => follower.store.state[whileAway.id] == null, true)

    // Реконнект того же Socket → catch-up хвоста → сходимость без потерь и дублей
    await waitFor('upstream reconnected', () => broken.socket.connected && upstream.hub.connectCount() == broken.count + 1)
    await waitFor('follower caught up after reconnect', () => follower.store.state[whileAway.id] != null)
    await waitFor('follower upstream is live again', () => follower.status.state.upstream == 'live')
    await waitFor('B caught up through the cascade', () => bStore.state[whileAway.id] != null)
    await check('final stores converge (leader == follower)', () => follower.store.snapshot(), board.control.store.snapshot())
    await check('final stores converge (leader == B mirror)', () => bStore.snapshot(), board.control.store.snapshot())
    await check('follower status seq advanced', () => follower.status.state.seq > seqAtReady, true)

    // ============== teardown ==============
    bSync()
    follower.close()
    await check('close is terminal for the status store', () => follower.status.state.upstream, 'closed')
    a.close()
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
