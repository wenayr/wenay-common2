// ============================================================
//  experiments/wenay-scaffold/self-check.ts
//
//  Boot proof of the scaffold: the template modules are imported directly
//  (no child processes). Client legs ride REAL RPC over the in-process
//  loopback transport from observe/store-node.test.ts; the node→leader link
//  is the same direct fragment handoff that test uses. Proven end to end:
//  the node registers in the directory, a login token flows the corridor
//  client → node gate → forwarded command → leader verification → store,
//  the change replicates to a follower THROUGH the node, and drain makes
//  the node leave cleanly on its own directory fact.
//  Run: node node_modules/tsx/dist/cli.mjs experiments/wenay-scaffold/self-check.ts
// ============================================================

import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {followNodeDirectory} from '../../src/Common/Observe/node-directory'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import type {SocketTmpl} from '../../src/Common/rcp/rpc-protocol'
import {createTokenCodec} from '../../src/server/auth-token'
import {createServiceLeader} from './template/leader'
import {createServiceNode} from './template/node'
import {serviceDefinition, type CounterState} from './template/service'

let fails = 0
let step = 0
const ok = (condition: any, message: string) => {
    const label = String(++step).padStart(2, ' ')
    if (!condition) { fails++; console.log(`${label}. FAIL ${message}`) }
    else console.log(`${label}. OK   ${message}`)
}

async function waitFor(message: string, check: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    ok(false, message + ' (timed out)')
}

// loopback transport (observe/store-node.test.ts): emit on one end delivers to
// the other through a JSON clone, so payloads break exactly as on a real socket
function createLoopback(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)]
}

const quiet = () => {}

async function main() {
    // still the literal '{{name}}' pre-instantiation — a plain string wire key
    const name = serviceDefinition.name

    // ============== leader from the template factory ==============
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => 'mem://leader', log: quiet})
    leader.control.start()
    const link = leader.serve.nodeLinkFragment()
    const roster = followNodeDirectory(link.directory, {staleMs: 0})
    await roster.ready
    const row = (nodeId: string) => roster.nodes().find(view => view.nodeId == nodeId)
    ok(row('leader')?.role == 'leader' && row('leader')?.url == 'mem://leader',
        'the leader boots from the definition and registers its own directory row')

    // ============== node from the template factory, linked in-process ==============
    // the node process builds its codec from the SAME env secret the leader handed out
    const codec = createTokenCodec({secret: leader.secrets.tokenSecret})
    let connect: ((socket: SocketTmpl) => void) | null = null
    let leftReason: string | null = null
    const node = createServiceNode<CounterState>({
        definition: serviceDefinition,
        nodeId: 'node-1',
        heartbeatMs: 50,
        graceMs: 40,
        verifyToken: function verifyPresentedToken(presented) {
            const verdict = codec.verify(presented)
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
        },
        upstream: () => ({
            replica: link.replica,
            directory: link.directory,
            revoked: link.revoked,
            commandsByToken: link.commandsByToken,
            register: entry => link.register(entry),
            heartbeat: (nodeId, facts) => link.heartbeat(nodeId, facts),
            goodbye: nodeId => link.goodbye(nodeId),
            onFail: {on: () => () => {}},
        }),
        serve: {onConnection(handler) { connect = handler }},
        selfUrl: () => 'mem://node-1',
        onLeave: reason => { leftReason = reason },
        log: quiet,
    })
    await node.start()
    ok(row('node-1')?.role == 'mirror' && row('node-1')?.url == 'mem://node-1',
        'the node registers itself in the directory')

    // ============== identity: a real codec token from the leader's ungated port ==============
    const minted = leader.serve.browserFragment('author').identity.login()
    ok(minted.account == 'author' && codec.verify(minted.token).ok == true,
        'login mints a codec token the node secret verifies')

    // ============== a client over REAL RPC to the node ==============
    const [clientEnd, serverEnd] = createLoopback()
    connect!(serverEnd)
    const read = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
    await read.readyStrict()
    ok(await read.func[name].node() == 'node-1', 'the ungated read key serves the definition-named fragment')

    const write = createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token: minted.token})
    await write.readyStrict()
    const ack = await write.auth()
    ok(ack?.ok == true && ack?.who == 'author' && ack?.node == 'node-1',
        'the node verifies the login token LOCALLY and acks the principal')

    // ============== the command corridor: client → node → leader → store ==============
    const first = await write.func[name].commands.add('r1', {delta: 5})
    ok(first.value == 5 && first.by == 'author' && leader.view.state().counter?.value == 5,
        'a forwarded command lands in the LEADER store as the verified account')
    const dup = await write.func[name].commands.add('r1', {delta: 999})
    ok(dup.value == 5 && leader.view.state().counter?.value == 5,
        'a duplicate requestId answers the receipt — nothing applied twice')

    // one receipt space: the leader's own gated surface answers the node-hop receipt
    const gate = leader.serve.scaleConnection()
    const resolved = gate.auth.resolveAuth(minted.token)
    const replayed = await resolved.object.commands.add('r1', {delta: 999})
    ok(replayed.value == 5, 'the node hop and the leader gate share ONE receipt space')
    gate.close()

    // ============== validation: a throw commits nothing, the id can honestly retry ==============
    let refused = false
    try { await write.func[name].commands.add('r2', {delta: 'nope'}) } catch { refused = true }
    ok(refused && leader.view.state().counter?.value == 5,
        'validate() rejects bad input before any effect')
    const retried = await write.func[name].commands.add('r2', {delta: 2})
    ok(retried.value == 7 && leader.view.state().counter?.value == 7,
        'the refused requestId left NO receipt — the same id retries honestly')

    // ============== replication THROUGH the node to a follower ==============
    const follower = createStoreFollower<CounterState>({remote: (read.func[name].replica as any).replay})
    await follower.ready
    await waitFor('the command result replicates through the node to a follower',
        () => follower.store.state.counter?.value == 7)
    ok(JSON.stringify(follower.store.state) == JSON.stringify(leader.view.state()),
        'the follower snapshot deep-equals the leader store')

    // ============== readerFacet: the read policy projection ==============
    const projected = leader.serve.readFragment().view() as any
    ok(projected.counter == 7 && JSON.stringify(projected) == '{"counter":7}',
        'readerFacet serves the projection, not the raw record')

    // ============== revocation is a replicated fact ==============
    let sawRevoked = false
    write.onAuthState(function onWriteAuthState(event: any) {
        if (event.state == 'revoked') sawRevoked = true
    })
    leader.control.revoke('author')
    await waitFor('the deny-list fact cuts the live session on the node', () => sawRevoked)
    const afterRevoke = await write.func[name].commands.add('r3', {delta: 1}).catch((error: any) => error?.code ?? String(error))
    ok(afterRevoke == 'E_UNAUTHORIZED', 'after the cut the node gate is closed')
    const relogin = leader.serve.browserFragment('author').identity.login()
    ok(codec.verify(relogin.token).ok == true, 'an explicit login lifts the revocation and mints anew')

    // ============== drain: leave on the node's OWN directory fact ==============
    leader.control.drain('node-1')
    await waitFor('drain makes the node leave cleanly through onLeave',
        () => leftReason == 'drained by the authority')
    await waitFor('the goodbye removed the node row', () => row('node-1') == undefined)

    // ============== create.mjs: {{name}} substitution into a fresh directory ==============
    const {instantiate} = await import('./create.mjs') as any
    const targetDir = await mkdtemp(path.join(tmpdir(), 'wenay-scaffold-'))
    try {
        const created = await instantiate({name: 'demo-rental', target: targetDir})
        const names = await readdir(created.targetDir)
        let leftovers = 0
        let substituted = false
        for (const file of names) {
            const text = await readFile(path.join(created.targetDir, file), 'utf8')
            if (text.includes('{{name}}')) leftovers++
            if (file == 'service.ts' && text.includes(`name: 'demo-rental'`)) substituted = true
        }
        ok(names.length == 6 && leftovers == 0 && substituted,
            'create.mjs instantiates all 6 template files with {{name}} substituted')
    } finally {
        await rm(targetDir, {recursive: true, force: true})
    }

    follower.close()
    node.close()
    roster.close()
    leader.control.close()
    console.log(fails == 0 ? '\nwenay-scaffold self-check: ALL GREEN' : `\nwenay-scaffold self-check: ${fails} FAILURES`)
    setTimeout(function exitNow() { process.exit(fails ? 1 : 0) }, 100)
}
main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
