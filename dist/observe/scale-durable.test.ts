// ============================================================
//  observe/scale-durable.test.ts
//
//  The storage seam of the authority line (ROADMAP §6.3): createAuthority
//  with line.durable puts the replica line on the ReplayStorage port. A
//  restart of the authority PROCESS (close + construct again over the same
//  storage) restores the state, continues the seq space, and a follower
//  that reconnects catches up through since() from the journal — no forced
//  keyframe reset. The boundary is stated too: receipts live on the CONTROL
//  line, which survives through a standby, not through storage.
//  Run: npx tsx observe/scale-durable.test.ts
// ============================================================

import {listen} from '../src/Common/events/Listen'
import {createMemoryReplayStorage} from '../src/Common/events/replay-history'
import type {StorePatch} from '../src/Common/Observe/store'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
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
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

type TickState = Record<string, {id: string, value: number}>
type Cmds = {add: (ctx: {account: string}, input: {delta: number}) => {value: number, by: string}}

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() {
        console.error('scale-durable oracle timed out')
        process.exit(3)
    }, 30_000)

    // the storage port, instrumented: every since() a follower resumes with lands here as a
    // journal read from that seq — the observable "served from the journal" fact
    const memory = createMemoryReplayStorage<[readonly StorePatch[]]>()
    const journalReads: number[] = []
    const storage: typeof memory = {
        ...memory,
        getEvents(from, to) {
            journalReads.push(from)
            return memory.getEvents(from, to)
        },
    }
    let applied = 0
    const commands: Cmds = {
        add(ctx, input) {
            applied += input.delta
            return {value: applied, by: ctx.account}
        },
    }
    function boot() {
        return createAuthority<TickState, Cmds>({
            line: {
                storeId: 'durable-line', originId: 'durable-origin',
                initial: {tick: {id: 'tick', value: 0}},
                durable: {storage, everyEvents: 3},
            },
            roster: {url: () => 'mem://authority', heartbeatMs: 50, staleMs: 0},
            corridor: {commands},
            identity: {issue: account => 'tok:' + account, verify: presented => ({account: String(presented ?? '').slice(4)})},
            log: () => {},
        })
    }

    // ============== first lifetime: an empty archive is seeded from `initial` ==============
    let authority = boot()
    authority.start()
    ok(authority.view.restored()?.fromArchive == false && authority.view.restored()?.seq == 0, 'first boot: nothing to restore, the archive is fresh')
    ok(authority.line.control.store.state.tick?.value == 0, 'initial seeds the empty archive')
    for (let value = 1; value <= 5; value++) {
        authority.line.control.store.state.tick = {id: 'tick', value}
        await settle()
    }
    const r1 = await authority.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(r1.value == 5 && applied == 5, 'a command executes in the first lifetime')
    const headBefore = authority.line.api.replay.head()
    ok(headBefore >= 5, `the line advanced (head ${headBefore})`)
    ok((authority.view.archive()?.keyframes ?? 0) >= 1 && (authority.view.archive()?.events ?? 0) >= 5,
        `the archiver wrote events and cadence keyframes: ${JSON.stringify(authority.view.archive())}`)

    // ============== a follower on the CURRENT authority, host-resolved (an in-process link) ==============
    let current = authority
    const [fail, onFail] = listen<[]>()
    const mirror = createStoreReplicaSet<TickState>({
        storeId: 'durable-line', originId: 'durable-origin', nodeId: 'm1', lineId: 'm1-line',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
        route: {reconnectMs: 50},
    })
    mirror.control.addOffer({
        id: 'to-authority',
        connect: () => ({remote: current.line.api.fragment, onFail: {on: (cb: () => void) => onFail.on(cb)}, close() {}}),
    })
    await mirror.api.ready
    await waitFor('the follower caught up in the first lifetime', () => mirror.api.store.state.tick?.value == 5)
    const followerSeq = mirror.api.status.state.authoritySeq
    ok(followerSeq == headBefore, `the follower sits at the authority head (${followerSeq})`)
    journalReads.length = 0

    // ============== the process dies and comes back over the SAME storage ==============
    authority.close()
    authority = boot()
    current = authority
    authority.start()
    const restored = authority.view.restored()
    ok(restored?.fromArchive == true && restored.seq == headBefore, `the restart restored the archive head (${JSON.stringify(restored)})`)
    ok(authority.line.control.store.state.tick?.value == 5, 'the state survived the process')
    ok(authority.line.api.replay.head() == headBefore, 'the seq space CONTINUES from the persisted head')
    ok(authority.line.api.canWrite() && authority.view.role() == 'leader', 'the restarted authority is the leader again')

    // ============== the follower reconnects: since() is served from the journal ==============
    // the new lifetime advances BEFORE the follower notices: its since(5) must then be a real
    // tail read (an empty "already at head" answer would prove nothing)
    authority.line.control.store.state.tick = {id: 'tick', value: 6}
    await settle()
    fail()
    await waitFor('the follower re-attached and received the fact written while it was away', () => mirror.api.store.state.tick?.value == 6)
    authority.line.control.store.state.tick = {id: 'tick', value: 7}
    await waitFor('...and keeps following', () => mirror.api.store.state.tick?.value == 7)
    ok(journalReads.includes(followerSeq),
        `the follower resumed by seq: its since(${followerSeq}) was served as a journal read on the storage port (reads from ${JSON.stringify(journalReads)})`)
    ok(mirror.api.status.state.authoritySeq == headBefore + 2,
        `the follower sees ONE continuing seq space (${headBefore} → ${mirror.api.status.state.authoritySeq}), not a fresh lifetime`)
    ok(mirror.api.status.state.routeId == 'to-authority' && mirror.api.status.state.leaderId == 'authority',
        'the follower is back on the authority route')

    // ============== the boundary, stated: receipts are NOT on the storage port ==============
    const again = await authority.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(again.value == 10 && applied == 10,
        'an OLD requestId re-executes after a solo restart — receipts live on the control line (a standby carries them, storage does not)')

    // ============== the archive keeps growing in the second lifetime ==============
    for (let value = 8; value <= 12; value++) {
        authority.line.control.store.state.tick = {id: 'tick', value}
        await settle()
    }
    ok((authority.view.archive()?.keyframes ?? 0) >= 1, `cadence keyframes continue in the second lifetime: ${JSON.stringify(authority.view.archive())}`)
    const headAfter = authority.line.api.replay.head()
    ok(headAfter > headBefore, `the head kept advancing (${headBefore} → ${headAfter})`)

    // ============== a third lifetime proves the SECOND lifetime's journal is what restores ==============
    authority.close()
    authority = boot()
    ok(authority.view.restored()?.seq == headAfter && authority.line.control.store.state.tick?.value == 12,
        'a third boot restores the second lifetime exactly')

    // ============== the negative control: WITHOUT the seam a restart resets the follower ==============
    function bootPlain() {
        return createAuthority<TickState>({
            line: {storeId: 'plain-line', originId: 'plain-origin', initial: {tick: {id: 'tick', value: 0}}},
            roster: {url: () => 'mem://plain', heartbeatMs: 50, staleMs: 0},
            identity: {issue: account => 'tok:' + account, verify: presented => ({account: String(presented ?? '').slice(4)})},
            log: () => {},
        })
    }
    let plain = bootPlain()
    ok(plain.view.restored() == null && plain.view.archive() == null, 'without line.durable the view says so (null, not a fake fact)')
    plain.start()
    for (let value = 1; value <= 5; value++) {
        plain.line.control.store.state.tick = {id: 'tick', value}
        await settle()
    }
    let plainCurrent = plain
    const [plainFail, plainOnFail] = listen<[]>()
    const plainMirror = createStoreReplicaSet<TickState>({
        storeId: 'plain-line', originId: 'plain-origin', nodeId: 'p1', lineId: 'p1-line',
        initial: {},
        leadership: {initialRole: 'follower', eligible: false},
        route: {reconnectMs: 50},
    })
    plainMirror.control.addOffer({
        id: 'to-plain',
        connect: () => ({remote: plainCurrent.line.api.fragment, onFail: {on: (cb: () => void) => plainOnFail.on(cb)}, close() {}}),
    })
    await plainMirror.api.ready
    await waitFor('control: the follower caught up on the plain authority', () => plainMirror.api.store.state.tick?.value == 5)
    const plainSeq = plainMirror.api.status.state.authoritySeq
    plain.close()
    plain = bootPlain()
    plainCurrent = plain
    plain.start()
    plainFail()
    plain.line.control.store.state.tick = {id: 'tick', value: 6}
    await waitFor('control: the follower re-attached to the plain restart', () => plainMirror.api.store.state.tick?.value == 6)
    ok(plain.view.restored() == null && plainMirror.api.status.state.authoritySeq < plainSeq,
        `control: a restart WITHOUT the seam is a foreign lifetime — the follower's seq fell back (${plainSeq} → ${plainMirror.api.status.state.authoritySeq}): a keyframe, not a tail`)
    plainMirror.close()
    plain.close()

    mirror.close()
    authority.close()
    clearTimeout(watchdog)
    console.log(fails ? `\nFAIL scale-durable: ${fails} check(s)` : '\nPASS scale-durable')
    process.exit(fails ? 1 : 0)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
