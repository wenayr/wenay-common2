// ============================================================
//  observe/scale-authority.test.ts
//
//  Scale authority from one config object: identity lifecycle over the host's
//  mint/verify adapters (login lifts the ban, renew refuses revoked), the
//  command corridor sharing ONE receipt space across fragment/byToken/RPC
//  hops, the gated per-socket connection block over REAL RPC (in-process
//  loopback), the trusted node link (acceptNode guard, pid meta survival),
//  honest readers from the line's subscriber count, and the authority's own
//  directory row + heartbeat meta merge.
//  Run: npx tsx observe/scale-authority.test.ts
// ============================================================

import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createAuthority} from '../src/Common/scale/scale-authority'

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
// adapters here are a transparent mint/parse pair — the layer under test is
// the lifecycle and the wiring, never a token format
const EXPIRES = Date.now() + 60 * 60_000
function issue(account: string) { return 'tok:' + account }
function verify(presented: unknown) {
    const text = String(presented ?? '')
    if (!text.startsWith('tok:')) throw new Error('token rejected: malformed')
    return {account: text.slice(4), expiresAt: EXPIRES}
}

type TickState = Record<string, {id: string, value: number}>

async function main() {
    let applied = 0
    const authority = createAuthority<TickState, {
        add: (ctx: {account: string}, input: {delta: number}) => {value: number, by: string}
    }>({
        storeId: 'scale-line', originId: 'scale-origin',
        initial: {tick: {id: 'tick', value: 0}},
        selfUrl: () => 'mem://authority',
        commands: {
            add(ctx, input) {
                applied += input.delta
                return {value: applied, by: ctx.account}
            },
        },
        identity: {issue, verify},
        heartbeatMs: 50,
        acceptNode: id => id != 'evil',
        meta: () => ({zone: 'test'}),
        log: () => {},
    })

    // ============== identity lifecycle: login lifts, renew refuses revoked ==============
    const minted = authority.identity.login('alice')
    ok(minted.token == 'tok:alice' && minted.account == 'alice' && minted.expiresAt == EXPIRES,
        'login mints through the host adapter and reads the deadline back')
    ok(authority.identity.renew('tok:alice').token == 'tok:alice', 'renew answers for a live token')
    const revoked = authority.identity.revoke('alice')
    ok(revoked.revoked == true && authority.view.isRevoked('alice'),
        'revoke lands the replicated deny fact')
    const refusal = ((): any => {
        try { authority.identity.renew('tok:alice'); return null }
        catch (error) { return error }
    })()
    ok(refusal?.revoke == true, 'renew is refused while revoked, with the revoke flag (RPC-AUTH rule 6)')
    authority.identity.login('alice')
    ok(!authority.view.isRevoked('alice'), 'login lifts the ban')
    authority.identity.revoke('zed')
    ok(authority.identity.mint('zed').token == 'tok:zed' && authority.view.isRevoked('zed'),
        'mint is a raw press: it never touches the deny list')

    // ============== corridor: ONE receipt space across every hop ==============
    const frag = authority.corridor.fragment('bob')
    const first = await frag.add('r1', {delta: 5})
    ok(first.value == 5 && first.by == 'bob' && applied == 5, 'a fragment command executes with its bound account')
    const viaToken = await authority.corridor.byToken().add('tok:bob', 'r1', {delta: 999})
    ok(viaToken.value == 5 && applied == 5, 'the token hop answers the SAME receipt, nothing re-applied')
    const direct = await authority.corridor.execute('bob', 'add', 'r1', {delta: 999})
    ok(direct.value == 5 && applied == 5, 'direct execute shares the receipt space too')
    ok(authority.corridor.names.includes('add'), 'corridor.names lists the command map')
    const badToken = await authority.corridor.byToken().add('garbage', 'rX', {delta: 7}).catch(() => 'rejected')
    ok(badToken == 'rejected' && applied == 5, 'a malformed token is refused and commits NOTHING')
    authority.identity.revoke('bob')
    const revokedHop = await authority.corridor.byToken().add('tok:bob', 'r2', {delta: 5}).catch(() => 'rejected')
    ok(revokedHop == 'rejected' && applied == 5, 'a revoked account is refused at the corridor')
    authority.identity.login('bob')
    const afterLift = await authority.corridor.byToken().add('tok:bob', 'r2', {delta: 5})
    ok(afterLift.value == 10 && applied == 10, 'after login the corridor executes again')

    // ============== connection(): the gated per-socket block over REAL RPC ==============
    const {client: l1Client, server: l1Server} = createLoopbackSocketPair()
    const conn1 = authority.serve.connection()
    const gated1 = createRpcServerAuto({socket: l1Server, socketKey: 'scale', object: conn1.object, auth: conn1.auth})
    conn1.attach(gated1.control)
    createRpcServerAuto({socket: l1Server, socketKey: 'app', object: {svc: authority.serve.reader()}})
    createRpcServerAuto({socket: l1Server, socketKey: 'node', object: {link: authority.serve.nodeLink()}})

    const anon = createRpcClient<any>({socket: l1Client, socketKey: 'scale'})
    const anonCode = await anon.func.whoami().catch((error: any) => error?.code ?? String(error))
    ok(anonCode == 'E_UNAUTHORIZED', 'anonymous is refused by the gate (empty surface + gate, rule 1)')

    const {client: l2Client, server: l2Server} = createLoopbackSocketPair()
    const conn2 = authority.serve.connection()
    const gated2 = createRpcServerAuto({socket: l2Server, socketKey: 'scale', object: conn2.object, auth: conn2.auth})
    conn2.attach(gated2.control)
    const carol = createRpcClient<any>({socket: l2Client, socketKey: 'scale', token: 'tok:carol'})
    await carol.readyStrict()
    const ack = await carol.auth()
    ok(ack?.ok == true && ack?.who == 'carol' && ack?.node == 'authority',
        'a verified HELLO acks the principal')
    ok(ack?.$rpc?.expiresAt == EXPIRES, 'the grant carries the adapter deadline (ack.$rpc.expiresAt)')
    ok(await carol.func.whoami() == 'carol @ authority', 'the per-principal facade is served')
    const carolAdd = await carol.func.commands.add('c1', {delta: 3})
    ok(carolAdd.by == 'carol' && applied == 13, 'commands ride the gated connection with the bound account')

    let sawRevoked = false
    carol.onAuthState(function onCarolAuthState(event: any) {
        if (event.state == 'revoked') sawRevoked = true
    })
    authority.identity.revoke('carol')
    await waitFor('identity.revoke cuts the LIVE session through the registry', () => sawRevoked)
    const afterCut = await carol.func.whoami().catch((error: any) => error?.code ?? String(error))
    ok(afterCut == 'E_UNAUTHORIZED', 'after the cut the gate is closed again')

    const {client: l3Client, server: l3Server} = createLoopbackSocketPair()
    const conn3 = authority.serve.connection()
    const gated3 = createRpcServerAuto({socket: l3Server, socketKey: 'scale', object: conn3.object, auth: conn3.auth})
    conn3.attach(gated3.control)
    const rejoin = createRpcClient<any>({socket: l3Client, socketKey: 'scale', token: 'tok:carol'})
    void rejoin.readyStrict().catch(() => {})
    const rejoinAck = await rejoin.auth()
    ok(rejoinAck?.ok != true, 'a revoked account cannot re-HELLO anywhere')

    // ============== node link: register guard, pid survival, goodbye ==============
    const nodeClient = createRpcClient<any>({socket: l1Client, socketKey: 'node'})
    await nodeClient.readyStrict()
    await nodeClient.func.link.register({nodeId: 'n1', url: 'mem://n1', weight: 4, pid: 123})
    const registered = authority.view.nodes().find(view => view.nodeId == 'n1')
    ok(registered?.role == 'mirror' && registered?.weight == 4 && registered?.meta?.['pid'] == 123,
        'register lands a mirror row with the pid fact')
    const evil = await nodeClient.func.link.register({nodeId: 'evil', url: 'mem://evil', weight: 4}).catch(() => 'refused')
    ok(evil == 'refused' && !authority.view.nodes().some(view => view.nodeId == 'evil'),
        'the acceptNode guard refuses an unknown node')
    await nodeClient.func.link.heartbeat('n1', {readers: 2})
    const beaten = authority.view.nodes().find(view => view.nodeId == 'n1')
    ok(beaten?.meta?.['pid'] == 123 && beaten?.meta?.['readers'] == 2,
        'heartbeat merges meta — the registered pid SURVIVES')
    await nodeClient.func.link.heartbeat('n1', {readers: -7})
    ok(authority.view.nodes().find(view => view.nodeId == 'n1')?.meta?.['readers'] == 0,
        'heartbeat sanitizes the reported readers fact')
    // a node that reconnects re-registers: the row must not lose its last
    // reported facts, or the balancer sees a loaded node as empty for a beat
    await nodeClient.func.link.heartbeat('n1', {readers: 3})
    await nodeClient.func.link.register({nodeId: 'n1', url: 'mem://n1-re', weight: 4, pid: 124})
    const reRegistered = authority.view.nodes().find(view => view.nodeId == 'n1')
    ok(reRegistered?.meta?.['readers'] == 3 && reRegistered?.meta?.['pid'] == 124,
        're-register merges meta — the readers fact SURVIVES until the next heartbeat')
    const hopReceipt = await nodeClient.func.link.commandsByToken.add('tok:bob', 'r2', {delta: 999})
    ok(hopReceipt.value == 10 && applied == 13, 'the node-link token hop shares the ONE receipt space over RPC')
    await nodeClient.func.link.goodbye('n1')
    ok(!authority.view.nodes().some(view => view.nodeId == 'n1'), 'goodbye removes the row')

    // ============== node link: identity discipline + fact hygiene ==============
    // direct calls here on purpose: in-process fragments are a first-party mode,
    // and a JSON wire would launder Infinity into null before the sanitizer
    const link = authority.serve.nodeLink()
    link.register({nodeId: 'n2', url: 'mem://n2', weight: 4, pid: 200})
    link.heartbeat('n2', {readers: Infinity})
    ok(authority.view.nodes().find(view => view.nodeId == 'n2')?.meta?.['readers'] == 0,
        'a non-finite readers fact is sanitized to 0 (Infinity never poisons the balancer)')
    link.register({nodeId: 'n2', url: 'mem://n2', weight: 4, pid: Infinity})
    ok(authority.view.nodes().find(view => view.nodeId == 'n2')?.meta?.['pid'] == 200,
        'a non-finite pid is dropped; the registered pid survives the merge')
    // crash-restart: a fresh process reports its OWN readers count at register —
    // the row must not inherit the dead process's load
    link.heartbeat('n2', {readers: 5})
    link.register({nodeId: 'n2', url: 'mem://n2', weight: 4, pid: 201, readers: 0})
    const reborn = authority.view.nodes().find(view => view.nodeId == 'n2')
    ok(reborn?.meta?.['readers'] == 0 && reborn?.meta?.['pid'] == 201,
        'register carrying a readers fact RESETS the inherited count (crash-restart)')

    const grab = (() => {
        try { link.register({nodeId: 'authority', url: 'mem://evil', weight: 9}); return null }
        catch (error) { return error }
    })()
    ok(grab != null && !authority.view.nodes().some(view => view.nodeId == 'authority' && view.url == 'mem://evil'),
        'a node cannot register over the authority row')
    ok((() => {
        try { link.heartbeat('authority', {readers: 9}); return false }
        catch { return true }
    })(), 'a node cannot heartbeat the authority row')
    ok((() => {
        try { link.goodbye('authority'); return false }
        catch { return true }
    })(), 'a node cannot goodbye the authority row')

    // a host that authenticated the node can BIND the link to that identity
    const boundLink = authority.serve.nodeLink('n2')
    ok((() => {
        try { boundLink.register({nodeId: 'n3', url: 'mem://n3', weight: 1}); return false }
        catch { return true }
    })() && !authority.view.nodes().some(view => view.nodeId == 'n3'),
        'a bound link cannot register a foreign nodeId')
    ok((() => {
        try { boundLink.heartbeat('n3', {readers: 1}); return false }
        catch { return true }
    })(), 'a bound link cannot heartbeat a foreign row')
    boundLink.goodbye('n2')
    ok(!authority.view.nodes().some(view => view.nodeId == 'n2'), 'the bound link still owns its own row')

    // ============== readers: only an ACTIVE line subscription counts ==============
    ok(authority.view.readers() == 0, 'readers is honest: no line subscribers yet')
    const read = createRpcClient<any>({socket: l1Client, socketKey: 'app'})
    await read.readyStrict()
    ok(await read.func.svc.node() == 'authority', 'the lean read surface names the authority as a node')
    const follower = createStoreFollower<TickState>({remote: read.func.svc.replica.replay})
    await follower.ready
    await waitFor('a live line subscription shows up in readers()', () => authority.view.readers() >= 1)

    // ============== start(): the authority row + heartbeat meta merge ==============
    authority.start()
    const row = authority.view.nodes().find(view => view.nodeId == 'authority')
    ok(row?.role == 'leader' && row?.weight == 1 && row?.url == 'mem://authority',
        'start registers the authority row from its config')
    ok(row?.meta?.['zone'] == 'test' && Number(row?.meta?.['readers']) >= 1,
        'the row carries {readers, ...meta()} side by side')
    const ts0 = row?.ts ?? 0
    await waitFor('the heartbeat refreshes the row with the merged meta', () => {
        const beat = authority.view.nodes().find(view => view.nodeId == 'authority')
        return (beat?.ts ?? 0) > ts0 && beat?.meta?.['zone'] == 'test' && typeof beat?.meta?.['readers'] == 'number'
    })
    follower.close()
    await waitFor('closing the follower drops the readers fact', () => authority.view.readers() == 0)

    // ============== browser fragment: identity bound to the connection's account ==============
    const browser = authority.serve.browser('dora')
    ok(browser.identity.login().token == 'tok:dora', 'browser identity is bound to the account')
    ok(!!browser.replica && !!browser.directory, 'browser serves the line and the roster')

    conn1.close()
    conn2.close()
    conn3.close()
    authority.close()
    console.log(fails == 0 ? '\nscale-authority: ALL GREEN' : `\nscale-authority: ${fails} FAILURES`)
    if (fails) process.exitCode = 1
    setTimeout(function exitNow() { process.exit(fails ? 1 : 0) }, 100)
}
void main()
