// ============================================================
//  observe/store-node.test.ts
//
//  Store node from one config object: catches up the replica line from the
//  authority, registers itself in the directory, serves an ungated read key
//  and a token-gated write key over REAL RPC (in-process loopback transport),
//  forwards commands with the END client's token (one receipt space with the
//  authority), cuts its own sessions on the replicated deny-list fact, reports
//  line readers through the heartbeat, and leaves on its OWN directory row.
//  Run: npx tsx observe/store-node.test.ts
// ============================================================

import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {createCommandHost} from '../src/Common/command/command-host'
import {verifyCommands} from '../src/Common/command/command-token'
import {createNodeDirectory} from '../src/Common/Observe/node-directory'
import {createReplicatedMap} from '../src/Common/Observe/replicated-map'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {createStoreNode, type StoreNodeRevocation} from '../src/Common/Observe/store-node'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function waitFor(message: string, check: () => boolean, timeoutMs = 4000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    ok(false, message + ' (timed out)')
}

// the ORACLE's token scheme: crypto is deliberately the host's job, so the
// verifier here is a transparent parser — the layer under test is the wiring
function parseToken(presented: unknown) {
    const text = String(presented ?? '')
    if (!text.startsWith('tok:')) throw new Error('token rejected: malformed')
    return {account: text.slice(4)}
}

type TickState = Record<string, {id: string, value: number}>

async function main() {
    // ============== authority: line + directory + commands + deny list ==============
    const authority = createStoreReplicaSet<TickState>({
        storeId: 'node-line', originId: 'node-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: {tick: {id: 'tick', value: 0}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const directory = createNodeDirectory()
    const revocations = createReplicatedMap<StoreNodeRevocation>({
        keyOf(revocation) { return revocation.account },
        delivery: 'latest',
    })
    let applied = 0
    const host = createCommandHost({
        commands: {
            add(ctx, input: {delta: number}) {
                applied += input.delta
                return {value: applied, by: ctx.account}
            },
        },
    })
    const verified = verifyCommands({
        host,
        accountOf(presented) {
            const {account} = parseToken(presented)
            if (revocations.control.get(account)) throw new Error('account revoked at the authority')
            return account
        },
    })

    // ============== the node under test, wired to the authority in-process ==============
    let connect: ((socket: SocketTmpl) => void) | null = null
    let leftReason: string | null = null
    const node = createStoreNode<TickState>({
        nodeId: 'n1', storeId: 'node-line', originId: 'node-origin',
        graceMs: 40,
        auth: {verify: parseToken},
        commands: ['add'],
        upstream: () => ({
            replica: authority.api.fragment,
            directory: directory.api,
            revoked: revocations.api,
            commandsByToken: verified.fragment(),
            register: entry => directory.control.upsert({...entry, role: 'mirror'}),
            heartbeat: (nodeId, facts) => directory.control.heartbeat(nodeId, {meta: {readers: facts?.readers ?? 0}}),
            goodbye: nodeId => directory.control.remove(nodeId),
            onFail: {on: () => () => {}},
        }),
        serve: {onConnection(handler) { connect = handler }},
        selfUrl: () => 'mem://n1',
        heartbeatMs: 50,
        onLeave: reason => { leftReason = reason },
        wrap: fragment => ({svc: fragment}),
        log: () => {},
    })
    await node.start()

    const row = directory.control.get('n1')
    ok(row?.url == 'mem://n1' && row?.role == 'mirror' && row?.weight == 4,
        'start registers the node in the directory from its config')

    authority.control.store.state.tick = {id: 'tick', value: 7}
    await waitFor('the node line converges on the authority write', () => node.view.status().seq >= 1)

    // ============== a client over REAL RPC: read key ungated, write key gated ==============
    const {client: clientEnd, server: serverEnd} = createLoopbackSocketPair()
    connect!(serverEnd)
    const read = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
    await read.readyStrict()
    ok(await read.func.svc.node() == 'n1', 'the ungated read key serves the wrapped fragment')

    const write = createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token: 'tok:alice'})
    await write.readyStrict()
    const ack = await write.auth()
    ok(ack?.ok == true && ack?.who == 'alice' && ack?.node == 'n1',
        'the gated key verifies the token LOCALLY and acks the principal')
    ok(await write.func.svc.whoami() == 'alice @ n1', 'the per-principal facade is served')

    const first = await write.func.svc.commands.add('r1', {delta: 5})
    ok(first.value == 5 && first.by == 'alice' && applied == 5,
        'a forwarded write executes at the AUTHORITY as the verified account')
    const dup = await write.func.svc.commands.add('r1', {delta: 999})
    ok(dup.value == 5 && applied == 5, 'a duplicate through the node answers the receipt')
    const direct = await host.execute('alice', 'add', 'r1', {delta: 999})
    ok(direct.value == 5 && applied == 5, 'the node hop and the authority share ONE receipt space')

    // ============== a bad token is refused by the gate ==============
    const {client: badEnd, server: badServer} = createLoopbackSocketPair()
    connect!(badServer)
    const bad = createRpcClient<any>({socket: badEnd, socketKey: 'scale', token: 'garbage'})
    const badCode = await bad.func.svc.whoami().catch((error: any) => error?.code ?? String(error))
    ok(badCode == 'E_UNAUTHORIZED', 'a malformed token leaves the gate closed (E_UNAUTHORIZED)')

    // ============== readers: only an ACTIVE line subscription counts ==============
    // the replica-set fragment carries the replay wire under .replay — a plain
    // line subscription is exactly what an active route holds
    const follower = createStoreFollower<TickState>({remote: (read.func.svc.replica as any).replay})
    await follower.ready
    await waitFor('a live line subscription shows up in the readers fact',
        () => node.view.status().readers >= 1)
    await waitFor('the heartbeat publishes readers into the directory',
        () => Number(directory.control.get('n1')?.meta?.['readers'] ?? 0) >= 1)

    // ============== revocation is DATA: the node cuts its own session ==============
    let sawRevoked = false
    write.onAuthState(function onWriteAuthState(event: any) {
        if (event.state == 'revoked') sawRevoked = true
    })
    revocations.control.set({account: 'alice', ts: Date.now()})
    await waitFor('the replicated deny fact cuts the live session on the node', () => sawRevoked)
    const afterRevoke = await write.func.svc.whoami().catch((error: any) => error?.code ?? String(error))
    ok(afterRevoke == 'E_UNAUTHORIZED', 'after the cut the gate is closed again')
    const rejoin = createRpcClient<any>({socket: badEnd, socketKey: 'scale', token: 'tok:alice'})
    void rejoin.readyStrict().catch(() => {})
    const rejoinAck = await rejoin.auth()
    ok(rejoinAck?.ok != true, 'a revoked account cannot re-HELLO on the node')

    // ============== leave on the node's OWN directory fact ==============
    directory.control.drain('n1')
    await waitFor('drain fact makes the node leave through onLeave', () => leftReason == 'drained by the authority')
    await waitFor('goodbye removed the node row', () => directory.control.get('n1') == undefined)

    // a reusable fake authority link for the lifecycle scenarios below
    function makeLink(onRegister?: (entry: any) => void) {
        return {
            replica: authority.api.fragment,
            directory: directory.api,
            register: (entry: any) => { onRegister?.(entry); directory.control.upsert({...entry, role: 'mirror'}) },
            heartbeat: (id: string, facts: any) => directory.control.heartbeat(id, {meta: {readers: facts?.readers ?? 0}}),
            goodbye: (id: string) => directory.control.remove(id),
            onFail: {on: () => () => {}},
        }
    }

    // ============== a failed start() must stay retryable ==============
    let n2Left: string | null = null
    let n2Registered: any = null
    let upstreamDown = true
    const n2 = createStoreNode<TickState>({
        nodeId: 'n2', storeId: 'node-line', originId: 'node-origin',
        // heartbeatMs is huge on purpose: the seeding scenario below needs the
        // removal to be the FIRST post-subscribe batch, with no beat in between
        graceMs: 40, heartbeatMs: 60_000,
        upstream: () => {
            if (upstreamDown) throw new Error('authority briefly down')
            return makeLink(function recordRegister(entry) { n2Registered = entry })
        },
        serve: {onConnection() {}},
        selfUrl: () => 'mem://n2',
        onLeave: reason => { n2Left = reason },
        log: () => {},
    })
    const failedStart = await n2.start().then(() => null, error => String(error))
    ok(failedStart != null && failedStart.includes('authority briefly down'), 'a failed start throws to the host')
    ok(n2.view.status().started == false, 'a failed start does not latch started')
    upstreamDown = false
    await n2.start()
    ok(directory.control.get('n2')?.url == 'mem://n2', 'the retried start registers and serves')
    ok(n2Registered?.readers == 0 && n2Registered?.pid == process.pid,
        'register carries the node\'s OWN readers and pid facts (a restart resets stale load)')

    // ============== removal as the FIRST post-subscribe batch still means leave ==============
    directory.control.remove('n2')
    await waitFor('a removal landing as the first batch still triggers leave',
        () => n2Left == 'removed from the directory')

    // ============== close() during start() must win ==============
    let releaseN3: ((link: any) => void) | null = null
    let n3Registered = false
    const n3 = createStoreNode<TickState>({
        nodeId: 'n3', storeId: 'node-line', originId: 'node-origin',
        graceMs: 40, heartbeatMs: 50,
        upstream: () => new Promise(resolve => { releaseN3 = resolve }),
        serve: {onConnection() {}},
        selfUrl: () => 'mem://n3',
        onLeave: () => {},
        log: () => {},
    })
    const n3Start = n3.start()
    n3.close()
    releaseN3!(makeLink(function markRegistered() { n3Registered = true }))
    await n3Start
    await new Promise(resolve => setTimeout(resolve, 50))
    ok(!n3Registered && directory.control.get('n3') == undefined,
        'a node closed during start never registers or arms its heartbeat')

    // ============== the upstream link is re-resolved on reconnect ==============
    let resolves = 0
    const failCbs: (() => void)[] = []
    const n4 = createStoreNode<TickState>({
        nodeId: 'n4', storeId: 'node-line', originId: 'node-origin',
        graceMs: 40, heartbeatMs: 60_000,
        upstream: () => {
            resolves++
            return {
                ...makeLink(),
                onFail: {on: (cb: () => void) => { failCbs.push(cb); return () => {} }},
            }
        },
        serve: {onConnection() {}},
        selfUrl: () => 'mem://n4',
        onLeave: () => {},
        log: () => {},
    })
    await n4.start()
    const resolvedAtStart = resolves
    for (const cb of [...failCbs]) cb()
    await waitFor('a route failure re-resolves the upstream link (a hub rotation survives)',
        () => resolves > resolvedAtStart)
    n4.close()

    follower.close()
    node.close()
    host.close()
    revocations.control.close()
    directory.control.close()
    authority.close()
    console.log(fails == 0 ? '\nstore-node: ALL GREEN' : `\nstore-node: ${fails} FAILURES`)
    if (fails) process.exitCode = 1
    setTimeout(function exitNow() { process.exit(fails ? 1 : 0) }, 100)
}
void main()
