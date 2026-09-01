// ============================================================
//  observe/scale-failover.test.ts
//
//  Authority succession: a standby follows the leader's replica line and its
//  three control lines (directory, deny list, receipts); when the leader dies
//  it takes over — the roster continues, revocations still bite, and an OLD
//  requestId answers its receipt instead of running again (at-most-once across
//  processes). A store node re-homes onto the new leader through its
//  re-resolved upstream; the old leader rejoining loses fork choice and
//  demotes to standby, refusing writes. A standby never promotes before its
//  first follow; an operator can force it.
//  Run: npx tsx observe/scale-failover.test.ts
// ============================================================

import {listen} from '../src/Common/events/Listen'
import {createAuthority, type AuthorityUpstream} from '../src/Common/scale/scale-authority'
import {createStoreNode} from '../src/Common/Observe/store-node'

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
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const EXPIRES = Date.now() + 60 * 60_000
function issue(account: string) { return 'tok:' + account }
function verify(presented: unknown) {
    const text = String(presented ?? '')
    if (!text.startsWith('tok:')) throw new Error('token rejected: malformed')
    return {account: text.slice(4), expiresAt: EXPIRES}
}

type TickState = Record<string, {id: string, value: number}>
type Cmds = {add: (ctx: {account: string}, input: {delta: number}) => {value: number, by: string}}

/** An in-process "link" to an authority: its node link plus a failure switch the test flips. */
function linkTo(authority: ReturnType<typeof createAuthority<TickState, Cmds>>, asNode: string) {
    const [fail, onFail] = listen<[]>()
    const link = authority.serve.nodeLink(asNode)
    const upstream: AuthorityUpstream = {
        replica: link.replica, control: link.control,
        register: link.register, heartbeat: link.heartbeat, goodbye: link.goodbye,
        onFail: {on: (cb: () => void) => onFail.on(cb)},
    }
    return {upstream, link, fail}
}

async function main() {
    let applied = 0
    const commands: Cmds = {
        add(ctx, input) {
            applied += input.delta
            return {value: applied, by: ctx.account}
        },
    }
    function authorityDeps(nodeId: string) {
        return {
            line: {storeId: 'fo-line', originId: 'fo-origin', nodeId, initial: {tick: {id: 'tick', value: 0}} as TickState},
            roster: {url: () => 'mem://' + nodeId, heartbeatMs: 50, staleMs: 0},
            corridor: {commands}, identity: {issue, verify},
            log: () => {},
        }
    }

    // ============== leader A, standby B following it ==============
    const a = createAuthority<TickState, Cmds>(authorityDeps('a'))
    a.start()
    const aLink = linkTo(a, 'b')
    let currentForB = aLink.upstream
    const roles: string[] = []
    const b = createAuthority<TickState, Cmds>({
        ...authorityDeps('b'),
        leadership: {role: 'standby', upstream: () => currentForB, autoPromoteMs: 150},
    })
    b.events.role.on(function rememberRole(role) { roles.push(role) })
    b.start()
    ok(b.view.role() == 'standby' && a.view.role() == 'leader', 'A is the leader, B a standby')
    await waitFor('B follows the replica line', () => b.line.api.status.state.role == 'follower' && b.line.api.status.state.leaderId == 'a')
    await waitFor('B is announced in the roster as a standby with weight 0',
        () => a.view.nodes().some(view => view.nodeId == 'b' && view.role == 'standby' && view.weight == 0 && !view.eligible))

    // facts land on the leader, B mirrors them
    a.line.control.store.state.tick = {id: 'tick', value: 7}
    const r1 = await a.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(r1.value == 5 && applied == 5, 'a command executes on the leader')
    a.identity.revoke('zed')
    await waitFor('B mirrors the line', () => b.line.api.store.state.tick?.value == 7)
    await waitFor('B mirrors the deny list', () => b.view.isRevoked('zed'))
    await waitFor('B mirrors the roster', () => b.view.nodes().some(view => view.nodeId == 'a' && view.role == 'leader'))

    const refused = await b.corridor.execute('alice', 'add', 'rX', {delta: 1}).catch((error: any) => String(error.message))
    ok(String(refused).includes('standby') && applied == 5, 'a standby refuses commands and names the leader')
    ok((() => { try { b.serve.nodeLink('n'); return false } catch { return true } })(), 'a standby serves no node link')

    // ============== a store node on the current leader, host-resolved ==============
    const nodeLinkA = linkTo(a, 'n1')
    let nodeUpstream = nodeLinkA
    const node = createStoreNode<TickState>({
        line: {nodeId: 'n1', storeId: 'fo-line', originId: 'fo-origin'},
        roster: {url: () => 'mem://n1', heartbeatMs: 50},
        upstream: () => nodeUpstream.upstream,
        serve: {onConnection() {}},
        onLeave() {},
        log: () => {},
    })
    await node.start()
    await waitFor('the node is registered at A', () => a.view.nodes().some(view => view.nodeId == 'n1' && view.role == 'mirror'))
    await waitFor('B mirrors the node row before the failover', () => b.view.nodes().some(view => view.nodeId == 'n1'))

    // ============== A dies ==============
    a.close()
    aLink.fail()
    nodeLinkA.fail()
    await waitFor('B promotes itself after losing A', () => b.view.role() == 'leader', 3000)
    ok(roles.join(',') == 'leader', 'the host saw the TRANSITION on events.role (the birth role is view.role()): ' + roles.join(','))
    ok(b.line.api.canWrite() && b.view.epoch() >= 1, 'B owns the replica line now')
    ok(b.view.nodes().some(view => view.nodeId == 'b' && view.role == 'leader' && view.weight == 1),
        "B's own row flipped from standby to leader")
    ok(!b.view.nodes().some(view => view.nodeId == 'a'), "the dead leader's row is gone")
    ok(b.view.nodes().some(view => view.nodeId == 'n1'), 'the roster CONTINUED: the node row survived the failover')
    ok(b.view.isRevoked('zed'), 'the deny list continued too')
    const renewZed = (() => { try { b.identity.renew('tok:zed'); return 'renewed' } catch (error: any) { return error.revoke ? 'revoked' : 'other' } })()
    ok(renewZed == 'revoked', 'a revoked account is still refused at the new leader')

    const replayed = await b.corridor.execute('alice', 'add', 'r1', {delta: 999})
    ok(replayed.value == 5 && applied == 5, 'the OLD requestId answers its receipt on the new leader — nothing re-applied')
    const fresh = await b.corridor.execute('alice', 'add', 'r2', {delta: 1})
    ok(fresh.value == 6 && applied == 6, 'new commands execute on the new leader')
    b.line.control.store.state.tick = {id: 'tick', value: 8}

    // ============== the node re-homes: its host now resolves B ==============
    nodeUpstream = linkTo(b, 'n1')
    await waitFor('the node re-homes onto B (registers there, follows ITS control line)',
        () => node.view.status().rehomes >= 1, 8000)
    ok(b.view.nodes().find(view => view.nodeId == 'n1')?.meta?.['pid'] == process.pid, "the node's row at B carries its pid fact")
    b.roster.control.drain('n1')
    await waitFor('a drain issued by the NEW leader reaches the node', () => node.view.status().leaving)

    // ============== the old leader restarts and rejoins: it loses fork choice ==============
    const bLinkForA = linkTo(b, 'a')
    const a2 = createAuthority<TickState, Cmds>({
        ...authorityDeps('a'),
        leadership: {role: 'leader', epoch: 1, upstream: () => bLinkForA.upstream},
    })
    a2.start()
    await waitFor('the returning leader demotes to standby behind the higher epoch', () => a2.view.role() == 'standby' && a2.view.leaderId() == 'b')
    const demotedWrite = await a2.corridor.execute('alice', 'add', 'r3', {delta: 1}).catch((error: any) => String(error.message))
    ok(String(demotedWrite).includes('standby') && applied == 6, 'the demoted leader refuses writes')
    await waitFor('the demoted leader follows the winner roster', () => a2.view.nodes().some(view => view.nodeId == 'b' && view.role == 'leader'))
    await waitFor('and is listed as a standby there', () => b.view.nodes().some(view => view.nodeId == 'a' && view.role == 'standby'))

    // ============== a standby never promotes before its first follow ==============
    const orphan = createAuthority<TickState, Cmds>({
        ...authorityDeps('orphan'),
        leadership: {role: 'standby', upstream: () => { throw new Error('leader not up yet') }, autoPromoteMs: 60},
    })
    await delay(250)
    ok(orphan.view.role() == 'standby', 'an unfollowed standby stays standby (no epoch-1 twin at boot)')
    const forced = await orphan.control.promote('operator')
    ok(forced?.role == 'leader' && orphan.view.role() == 'leader', 'the operator can force the take-over')
    orphan.close()

    a2.close(); node.close(); b.close()
    console.log(fails ? `scale-failover: ${fails} FAILED` : 'scale-failover: ALL GREEN')
    process.exit(fails ? 1 : 0)
}

main().catch(function crashed(error) { console.error(error); process.exit(1) })
