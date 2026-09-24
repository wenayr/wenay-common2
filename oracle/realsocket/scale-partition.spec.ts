// oracle-ends: own watchdog timer — a stall exits 3
// Two authorities over real sockets; the lease/resource arbiter is a local test fixture.
// This proves host fencing integration, not distributed consensus or Kubernetes Leases.
import assert from 'node:assert/strict'
import {createAuthority, type AuthorityUpstream} from '../../src/Common/scale/scale-authority'
import type {CommandCtx} from '../../src/Common/command/command-host'
import {commandReceiptKey} from '../../src/Common/command/command-receipts'
import type {StoreReplicaDescriptor, StoreReplicaElectionContext} from '../../src/Common/Observe/store-replica-set'
import {startRealServer, startRealClient, delay} from './_rs'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(function capture(done) { resolve = done })
    return {promise, resolve}
}

async function waitFor(label: string, condition: () => boolean) {
    const deadline = Date.now() + 5000
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timeout: ' + label)
        await delay(10)
    }
}

// The receiving resource owns the fence and dedup atomically with the effect.
// A production host needs an equivalent durable transaction at its real sink.
function createResource() {
    let owner = ''
    let epoch = 0
    let value = 0
    const receipts = new Map<string, number>()

    function elect(ctx: StoreReplicaElectionContext) {
        owner = ctx.nodeId
        epoch = Math.max(epoch, ctx.maxEpoch) + 1
        return {epoch, proof: owner + ':' + epoch}
    }
    function accept(descriptor: StoreReplicaDescriptor) {
        return descriptor.nodeId == owner && descriptor.epoch == epoch && descriptor.proof == owner + ':' + epoch
    }
    function requireCurrent(descriptor: StoreReplicaDescriptor) {
        if (!accept(descriptor)) throw new Error('resource rejected stale fence')
    }
    function commit(descriptor: StoreReplicaDescriptor, ctx: CommandCtx, delta: number) {
        requireCurrent(descriptor)
        const key = commandReceiptKey(ctx.account, ctx.requestId)
        const old = receipts.get(key)
        if (old != undefined) return old
        value += delta
        receipts.set(key, value)
        return value
    }
    return {elect, accept, requireCurrent, commit, value: () => value, count: () => receipts.size}
}

async function scenario(fenced: boolean) {
    const cleanup: (() => void | Promise<void>)[] = []
    const resource = createResource()
    const entered = deferred()
    const release = deferred()
    let partitioned = false
    let bodyCalls = 0

    function makeAuthority(nodeId: string, upstream?: () => AuthorityUpstream) {
        const authority = createAuthority({
            line: {storeId: 'partition', originId: 'partition-origin', nodeId, initial: {value: 0}},
            roster: {url: () => 'fixture://' + nodeId, heartbeatMs: 50},
            identity: {
                issue: (account: string) => account,
                verify(presented: unknown) {
                    if (presented != 'alice') throw new Error('invalid fixture account')
                    return {account: 'alice', expiresAt: Date.now() + 60_000}
                },
            },
            leadership: {
                role: 'standby',
                ...(upstream ? {upstream} : {}),
                ...(fenced ? {elect: resource.elect, accept: resource.accept} : {}),
            },
            corridor: {commands: {
                async add(ctx: CommandCtx, input: {delta: number, pause?: boolean}): Promise<number> {
                    // Capture the proof BEFORE awaiting: never borrow the successor's fence.
                    const admitted = authority.line.api.descriptor()
                    if (fenced) resource.requireCurrent(admitted)
                    bodyCalls++
                    if (input.pause) {
                        entered.resolve()
                        await release.promise
                    }
                    const value = fenced
                        ? resource.commit(admitted, ctx, input.delta)
                        : authority.line.api.store.state.value + input.delta
                    authority.line.control.store.state.value = value
                    return value
                },
            }},
            log() {},
        })
        cleanup.push(authority.close)
        return authority
    }

    type Authority = ReturnType<typeof makeAuthority>
    type NodeLink = ReturnType<Authority['serve']['nodeLink']>
    type Consumer = {replica: ReturnType<Authority['serve']['reader']>['replica'], commands: ReturnType<Authority['corridor']['fragment']>}

    async function serve(authority: Authority) {
        const server = await startRealServer({
            port: 0,
            makeObject: () => ({}),
            serverOpts: {auth: {gate: true, resolveAuth(token: unknown) {
                if (token == 'peer') return {object: authority.serve.nodeLink('b'), ack: {ok: true}}
                if (token != 'alice') throw new Error('invalid fixture token')
                return {object: {replica: authority.serve.reader().replica, commands: authority.corridor.fragment('alice')}, ack: {ok: true}}
            }}},
        })
        cleanup.push(server.close)
        const address = server.httpServer.address()
        assert(address && typeof address != 'string')
        authority.start()
        return address.port
    }

    try {
        const a = makeAuthority('a')
        await a.control.promote()
        const aPort = await serve(a)
        const peer = await startRealClient<NodeLink>({port: aPort, token: 'peer'})
        cleanup.push(function closePeer() { peer.hub.close() })
        const remote = peer.client.func
        const upstream: AuthorityUpstream = {
            replica: remote.replica, control: remote.control,
            register: remote.register, heartbeat: remote.heartbeat, goodbye: remote.goodbye,
            onFail: {on: cb => peer.client.onDisconnect(cb)},
        }
        const b = makeAuthority('b', function currentUpstream() {
            if (partitioned) throw new Error('authority link partitioned')
            return upstream
        })
        const bPort = await serve(b)
        const ca = await startRealClient<Consumer>({port: aPort, token: 'alice'})
        const cb = await startRealClient<Consumer>({port: bPort, token: 'alice'})
        cleanup.push(function closeConsumers() { ca.hub.close(); cb.hub.close() })
        await waitFor('B follows A', () => b.line.api.status.state.role == 'follower' && b.view.leaderId() == 'a')
        assert.equal(await ca.client.func.commands.add('initial', {delta: 1}), 1)
        await waitFor('replica crosses real socket', () => b.line.api.store.state.value == 1)

        const pending = fenced
            ? ca.client.func.commands.add('raced', {delta: 100, pause: true}).then(
                value => ({value, error: ''}), error => ({value: -1, error: String(error.message)}))
            : null
        if (pending) await entered.promise
        partitioned = true
        peer.hub.close('partition only the authority link')
        await b.control.promote()
        assert.equal(a.view.role(), 'leader')
        assert.equal(b.view.role(), 'leader')

        if (!fenced) {
            assert.equal(await ca.client.func.commands.add('fork-a', {delta: 10}), 11)
            assert.equal(await cb.client.func.commands.add('fork-b', {delta: 20}), 21)
            assert.equal(a.line.api.store.state.value, 11)
            assert.equal(b.line.api.store.state.value, 21)
            console.log('PASS negative control: both isolated authorities admit writes without host fencing')
            return
        }

        const before = bodyCalls
        await assert.rejects(ca.client.func.commands.add('stale-new', {delta: 1000}), /stale fence/)
        assert.equal(bodyCalls, before, 'host admission rejects before entering the body')
        assert.equal(await cb.client.func.commands.add('raced', {delta: 2}), 3)
        release.resolve()
        assert.match((await pending!).error, /stale fence/)
        assert.equal(resource.value(), 3, 'old in-flight external effect is fenced at commit')
        assert.equal(resource.count(), 2)
        assert.equal(await cb.client.func.commands.add('raced', {delta: 999}), 3)
        assert.equal(resource.value(), 3, 'retry has no duplicate side effect')

        // Heal with a real RPC replica offer; the higher certified epoch demotes A.
        a.line.control.addOffer({id: 'healed-b', connect() {
            return {remote: cb.client.func.replica, onFail: {on: callback => cb.client.onDisconnect(callback)}, close() {}}
        }})
        await a.line.control.probe()
        await waitFor('A follows the accepted successor', () => a.view.role() == 'standby' && a.line.api.store.state.value == 3)
        await assert.rejects(ca.client.func.commands.add('after-heal', {delta: 5}), /standby/)
        assert.equal(resource.value(), 3)
        console.log('PASS fenced partition: stale admission/commit rejected, retry deduplicated, healed replica converged')
    } finally {
        release.resolve()
        for (const close of cleanup.reverse()) await close()
    }
}

async function main() {
    const watchdog = setTimeout(function timeout() { console.error('scale partition timeout'); process.exit(3) }, 25_000)
    try {
        await scenario(false)
        await scenario(true)
        console.log('##RESULT## scale-partition PASS (local arbiter, real sockets, no consensus claim)')
    } finally { clearTimeout(watchdog) }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
