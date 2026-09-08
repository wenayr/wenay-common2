// Real-process scaffold regression: one authority, two serving nodes, this consumer.
// Grow while active, rebalance actual reader load, evacuate, crash, and reconnect.
// No authority election is tested. A private IPC wrapper drives the leader's existing drain.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {io} from 'socket.io-client'
import {sleepAsync} from '../../src/Common/core/common'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {followNodeDirectory, type NodeDirectoryView} from '../../src/Common/Observe/node-directory'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {createClusterClient} from '../../src/Common/scale/scale-client'
import {serviceDefinition, type CounterState} from './template/service'
import type {createServiceLeader} from './template/leader'

type Leader = ReturnType<typeof createServiceLeader<typeof serviceDefinition>>
type Browser = ReturnType<Leader['serve']['browserFragment']>
type Reader = Pick<Browser, 'replica'>
type Principal = ReturnType<ReturnType<Leader['serve']['scaleConnection']>['auth']['resolveAuth']>['object']
type Writer = Pick<Principal, 'commands' | 'whoami'>

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await sleepAsync(20)
    }
    throw new Error('timeout waiting for ' + label)
}

function boot(script: 'leader' | 'node', env: Record<string, string>) {
    const entrypoint = path.join(__dirname, 'process-' + script + '.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
        cwd: path.resolve(__dirname, '../..'),
        env: {...process.env, ...env, SERVICE_PRINT_JOIN_ENV: '0'},
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
    })
    let output = ''
    let exited = false
    let spawnError: Error | undefined
    function capture(chunk: unknown) { output = (output + String(chunk)).slice(-12_000) }
    child.stdout!.on('data', capture)
    child.stderr!.on('data', capture)
    child.once('error', function childFailed(error) { spawnError = error })
    child.once('exit', function childExited() { exited = true })
    async function stop() {
        if (exited || spawnError) return
        child.kill('SIGKILL')
        await waitFor('child process exit ' + child.pid, () => exited, 5000)
    }
    return {
        child, stop,
        exited: () => exited,
        output: () => output,
        assertAlive() {
            if (spawnError || exited) throw new Error(`${script} exited before readiness: ${spawnError ?? child.exitCode}\n${output}`)
        },
    }
}

function createNodeHub(url: string) {
    const hub = createRpcClientHub(
        function openNodeSocket() {
            const socket = io(url, {transports: ['websocket'], forceNew: true, reconnection: false, timeout: 1500})
            // A failed dial must settle this offer, so the replica layer can retry a new URL.
            socket.once('connect_error', function dialFailed() { hub.close('node dial failed') })
            return socket
        },
        rpc => ({read: rpc<Record<string, Reader>>('app'), write: rpc<Record<string, Writer>>('scale')}),
    )
    return hub
}

async function main() {
    const processes: ReturnType<typeof boot>[] = []
    const cleanup: (() => void | Promise<void>)[] = []
    let consumerDiagnostic: (() => unknown) | undefined
    const watchdog = setTimeout(function timedOut() {
        for (const entry of processes) entry.child.kill('SIGKILL')
        console.error('scaffold multiprocess check exceeded 100s')
        process.exit(3)
    }, 100_000)
    try {
        const name = serviceDefinition.name
        const secrets = {
            SERVICE_NODE_TOKEN: randomBytes(24).toString('hex'),
            SERVICE_TOKEN_SECRET: randomBytes(32).toString('hex'),
        }
        const leader = boot('leader', {...secrets, SERVICE_PORT: '0'})
        processes.push(leader)
        await waitFor('authority port', function leaderReady() {
            leader.assertAlive()
            return /leader listening on (http:\/\/localhost:\d+)/.test(leader.output())
        })
        const url = /leader listening on (http:\/\/localhost:\d+)/.exec(leader.output())![1]
        const primary = createRpcClientHub(
            () => io(url, {transports: ['websocket'], forceNew: true, auth: {account: 'process-consumer'}}),
            rpc => ({read: rpc<Record<string, Browser>>('app'), write: rpc<Record<string, Writer>>('scale')}),
        )
        cleanup.push(function closePrimary() { primary.close() })
        const primaryApi = await primary.setToken(null)
        await primaryApi.read.readyStrict()
        const minted = await primaryApi.read.func[name].identity.login()
        await primary.reauth(minted.token)
        const roster = followNodeDirectory(primaryApi.read.func[name].roster)
        cleanup.push(roster.close)
        await roster.ready

        function startNode(nodeId: string) {
            const entry = boot('node', {...secrets, SERVICE_PORT: '0', SERVICE_NODE_ID: nodeId, SERVICE_UPSTREAM: url})
            processes.push(entry)
            return entry
        }
        const firstNode = startNode('process-node-1')
        await waitFor('first serving process registration', function nodesReady() {
            firstNode.assertAlive()
            return roster.nodes().some(row => row.nodeId == 'process-node-1' && row.meta?.['pid'] == firstNode.child.pid)
        })

        const sessions = new Map<string, ReturnType<typeof createNodeHub>>()
        let offline = false
        async function connect(view: NodeDirectoryView) {
            if (offline) throw new Error('consumer intentionally offline')
            const hub = createNodeHub(view.url)
            sessions.set(view.nodeId, hub)
            try {
                const api = await hub.setToken(minted.token)
                await Promise.all([api.read.readyStrict(), api.write.readyStrict()])
                return {
                    remote: api.read.func[name].replica,
                    onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
                    close() {
                        if (sessions.get(view.nodeId) == hub) sessions.delete(view.nodeId)
                        hub.close()
                    },
                }
            } catch (error) {
                if (sessions.get(view.nodeId) == hub) sessions.delete(view.nodeId)
                hub.close()
                throw error
            }
        }
        const cluster = createClusterClient<CounterState>({
            line: {storeId: serviceDefinition.storeId, originId: serviceDefinition.originId, nodeId: 'process-consumer', initial: {}},
            roster: primaryApi.read.func[name].roster,
            connect,
            placement: {rng: () => 0, balance: {aboveShare: 1.5, belowShare: 0.6, checkMs: 100, moveChance: 1, cooldownMs: 1000}},
            log() {},
        })
        cleanup.push(function closeCluster() {
            cluster.close()
            for (const hub of [...sessions.values()]) hub.close()
            sessions.clear()
        })
        const store = cluster.store
        const observed: number[] = []
        consumerDiagnostic = () => ({route: cluster.view.route(), status: cluster.status.state, state: store.state, observed})
        cleanup.push(store.node.counter.value.on(function observeValue(value) { if (value != undefined) observed.push(value) }))
        await cluster.ready
        await waitFor('first serving node route', () => cluster.view.route() == 'process-node-1' && store.state.counter?.value == 0)
        async function add(requestId: string, delta: number) {
            const nodeId = cluster.view.route()
            assert(nodeId)
            const hub = sessions.get(nodeId)
            assert(hub)
            const api = await hub.promise
            return api.write.func[name].commands.add(requestId, {delta})
        }
        assert.deepEqual(await add('cross-process-once', 5), {value: 5, by: 'process-consumer'})
        await waitFor('first command in original subscription', () => observed.includes(5))

        // Load is real subscribed mirrors; idle sockets must not count as readers.
        const firstUrl = roster.nodes().find(row => row.nodeId == 'process-node-1')!.url
        const loadReaders: (() => void)[] = []
        for (let index = 0; index < 4; index++) {
            const hub = createNodeHub(firstUrl)
            cleanup.push(function closeLoadHub() { hub.close() })
            const api = await hub.setToken(minted.token)
            await api.read.readyStrict()
            const follower = createStoreFollower({remote: api.read.func[name].replica.replay})
            function closeLoadReader() { follower.close(); hub.close() }
            loadReaders.push(closeLoadReader)
            cleanup.push(closeLoadReader)
            await follower.ready
        }
        await waitFor('published real reader load', () => Number(roster.nodes().find(row => row.nodeId == 'process-node-1')?.meta?.['readers']) >= 5)
        const loadBefore = roster.nodes().map(row => ({node: row.nodeId, readers: row.meta?.['readers'], weight: row.weight}))
        const growthAt = Date.now()
        const secondNode = startNode('process-node-2')
        await waitFor('extra serving process registration', function secondReady() {
            secondNode.assertAlive()
            return roster.nodes().some(row => row.nodeId == 'process-node-2' && row.meta?.['pid'] == secondNode.child.pid)
        })
        const pids = [process.pid, leader.child.pid, firstNode.child.pid, secondNode.child.pid]
        assert.equal(new Set(pids).size, 4, 'consumer, authority and serving nodes are different OS processes')
        await waitFor('live balance onto extra capacity', () => cluster.view.route() == 'process-node-2')
        const growthMs = Date.now() - growthAt
        assert.equal(cluster.store, store)
        assert.deepEqual(await add('cross-process-once', 999), {value: 5, by: 'process-consumer'})
        assert.deepEqual(await add('after-growth', 1), {value: 6, by: 'process-consumer'})
        await waitFor('same subscription after growth', () => observed.includes(6))
        await waitFor('published load transfer', () => Number(roster.nodes().find(row => row.nodeId == 'process-node-1')?.meta?.['readers']) == 4
            && Number(roster.nodes().find(row => row.nodeId == 'process-node-2')?.meta?.['readers']) == 1)
        const loadAfter = roster.nodes().map(row => ({node: row.nodeId, readers: row.meta?.['readers'], weight: row.weight}))
        console.log('PASS active growth -> load balance -> same Store and receipt:', JSON.stringify({growthMs, pids, loadBefore, loadAfter, route: cluster.view.route()}))
        for (const close of loadReaders) close()
        await waitFor('extra readers released', () => Number(roster.nodes().find(row => row.nodeId == 'process-node-1')?.meta?.['readers']) == 0)

        const drainAt = Date.now()
        leader.child.send({type: 'drain', nodeId: 'process-node-2'})
        await waitFor('planned evacuation to first node', () => cluster.view.route() == 'process-node-1')
        assert(!secondNode.exited(), 'reader evacuates while draining process still serves')
        const drainMs = Date.now() - drainAt
        assert.equal(cluster.store, store)
        assert.deepEqual(await add('cross-process-once', 999), {value: 5, by: 'process-consumer'})
        assert.deepEqual(await add('after-drain', 1), {value: 7, by: 'process-consumer'})
        await waitFor('same subscription after graceful evacuation', () => observed.includes(7))
        await waitFor('drained process graceful exit', secondNode.exited)
        assert.equal(secondNode.child.exitCode, 0)
        console.log('PASS planned drain -> evacuation before process exit:', JSON.stringify({drainMs, route: cluster.view.route()}))

        const replacement = startNode('process-node-2')
        await waitFor('replacement capacity registration', () => roster.nodes().some(row => row.nodeId == 'process-node-2' && row.meta?.['pid'] == replacement.child.pid))

        const crashAt = Date.now()
        await firstNode.stop()
        await waitFor('handoff after serving process death', () => cluster.view.route() == 'process-node-2')
        assert.deepEqual(await add('cross-process-once', 999), {value: 5, by: 'process-consumer'})
        assert.deepEqual(await add('after-process-death', 2), {value: 9, by: 'process-consumer'})
        await waitFor('same subscription after process handoff', () => observed.includes(9))
        assert.deepEqual(await primaryApi.read.func[name].view(), {counter: 9})
        console.log('PASS serving process death -> node-2 handoff -> duplicate receipt:', JSON.stringify({crashMs: Date.now() - crashAt}))

        offline = true
        for (const hub of [...sessions.values()]) hub.socket.disconnect()
        await waitFor('consumer offline', () => cluster.status.state.role == 'offline')
        assert.deepEqual(await primaryApi.write.func[name].commands.add('while-consumer-offline', {delta: 3}), {value: 12, by: 'process-consumer'})
        assert.equal(store.state.counter?.value, 9)
        offline = false
        await waitFor('consumer replay catch-up', () => cluster.view.route() == 'process-node-2' && store.state.counter?.value == 12)
        assert.equal(cluster.store, store)
        assert(observed.includes(12))
        console.log('PASS consumer reconnect -> original Store/subscription catch up')

        const restarted = startNode('process-node-1')
        await waitFor('new serving process registration', function restartedReady() {
            restarted.assertAlive()
            return roster.nodes().some(row => row.nodeId == 'process-node-1' && row.meta?.['pid'] == restarted.child.pid)
        })
        assert.notEqual(restarted.child.pid, firstNode.child.pid)
        cluster.placement.repick()
        await waitFor('route to restarted serving process', () => cluster.view.route() == 'process-node-1')
        assert.deepEqual(await add('cross-process-once', 999), {value: 5, by: 'process-consumer'})
        assert.deepEqual(await add('after-restart', 1), {value: 13, by: 'process-consumer'})
        await waitFor('subscription follows restarted process', () => observed.includes(13))
        assert.deepEqual(await primaryApi.read.func[name].view(), {counter: 13})
        console.log('PASS restarted node rejoins -> existing receipt survives -> fresh command applied')

        const leaveAt = Date.now()
        restarted.child.send({type: 'leave'})
        await waitFor('local shutdown evacuates before grace', () => cluster.view.route() == 'process-node-2')
        assert(!restarted.exited(), 'local node.leave publishes departure before the process exits')
        assert.equal(cluster.store, store)
        assert.deepEqual(await add('cross-process-once', 999), {value: 5, by: 'process-consumer'})
        assert.deepEqual(await add('after-local-leave', 1), {value: 14, by: 'process-consumer'})
        await waitFor('original subscription after local leave', () => observed.includes(14))
        console.log('PASS local node.leave -> original Store moves before process exit:', JSON.stringify({leaveMs: Date.now() - leaveAt}))
        await waitFor('locally leaving process exits gracefully', restarted.exited)
        assert.equal(restarted.child.exitCode, 0)
        assert.deepEqual(observed, [0, 5, 6, 7, 9, 12, 13, 14], 'each awaited checkpoint appears once without rollback')
        console.log('scaffold multiprocess: ALL GREEN')
    } catch (error) {
        if (consumerDiagnostic) console.error('consumer state:', JSON.stringify(consumerDiagnostic()))
        for (const entry of processes) console.error(`process ${entry.child.pid} output:\n${entry.output()}`)
        throw error
    } finally {
        for (const close of cleanup.reverse()) await close()
        await Promise.all(processes.map(entry => entry.stop()))
        clearTimeout(watchdog)
    }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
