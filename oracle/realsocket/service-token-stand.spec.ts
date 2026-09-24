// The stand's "Service tokens" panel, driven through the SAME client module the browser runs,
// against the host mounted on a real Socket.IO server the way demo/server.ts mounts it.
// Every scenario verdict is asserted with the layer that decided it: the handshake-named account
// mints nothing, the stand issues only after its own login, access.login checks credentials, the
// operator's revoke cuts the live session and refuses renewal. Then isolation (one sandbox's
// revoke leaves another sandbox's session working) and the public-stand bounds.
import assert from 'node:assert/strict'
import type {AddressInfo} from 'node:net'
import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createServiceTokenHost, type ServiceTokenHostDeps} from '../../demo/service-token-host'
import {
    createServiceTokenClient,
    type ServiceTokenReport,
    type tServiceTokenLayer,
    type tVerdictOutcome,
} from '../../demo/service-token-client'
import {serviceTokenKeys, serviceTokenLimits, serviceTokenRole, serviceTokenRoutes} from '../../demo/service-token-contract'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'
import {runOracle} from '../run-oracle'

let failed = 0
async function check(label: string, run: () => Promise<void>) {
    try {
        await run()
        console.log('PASS ' + label)
    } catch (error) {
        failed++
        console.log('FAIL ' + label + ': ' + ((error as Error)?.message ?? error))
    }
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return
        await delay(25)
    }
    throw new Error('timeout: ' + label)
}

/** The host mounted as demo/server.ts mounts it: a tab is required, the role picks the surface. */
async function startStand(deps: ServiceTokenHostDeps = {}) {
    const host = createServiceTokenHost(deps)
    const app = express()
    app.use(serviceTokenRoutes.base, host.serve.router())
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', function routeStandSocket(socket) {
        const tab = socket.handshake.auth?.['tab']
        if (typeof tab != 'string' || !tab || socket.handshake.auth?.['role'] != serviceTokenRole) {
            socket.disconnect(true)
            return
        }
        host.serve.socket(socket)
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + (httpServer.address() as AddressInfo).port
    return {
        host, origin,
        close: () => new Promise<void>(function closeStand(resolve) {
            host.close()
            ioServer.close(() => resolve())
        }),
    }
}

type tConnect = NonNullable<Parameters<typeof createServiceTokenClient>[0]['connect']>

/** One browser tab: the browser's own polling-first transport unless a test swaps it. */
function visitor(origin: string, tab: string, connect?: tConnect) {
    return createServiceTokenClient({origin, tab, ...(connect ? {connect} : {})})
}

/** Websocket only: a socket the host refuses mid-polling (a swept sandbox) arms engine.io's fixed
 *  30 s server-side close timeout, which would hold this process open. */
const websocketOnly: tConnect = (origin, options) => io(origin, {...options, transports: ['websocket']})

/** The revocation's Pkt.AUTH lands, its downgrading Pkt.MAP only later: what a browser gets over
 *  long-polling when the two packets fall into different poll responses (seen on the live stand). */
const downgradeLate: tConnect = function connectDowngradeLate(origin, options) {
    const socket = io(origin, options)
    return new Proxy(socket, {
        get(target, prop) {
            if (prop == 'on') {
                return function onWithLateDowngrade(event: string, handler: (...args: any[]) => void) {
                    if (event != serviceTokenKeys.scale) return target.on(event, handler)
                    return target.on(event, function deliverScalePacket(packet: unknown) {
                        const downgrade = Array.isArray(packet) && packet[0] == Pkt.MAP && (packet[4] as {ok?: unknown} | null)?.ok == false
                        if (downgrade) setTimeout(function lateDowngrade() { handler(packet) }, 300)
                        else handler(packet)
                    })
                }
            }
            const value = Reflect.get(target, prop, target)
            return typeof value == 'function' ? value.bind(target) : value
        },
    })
}

type tExpected = [tVerdictOutcome, tServiceTokenLayer][]

/** Outcome and deciding layer of every step, in order; the report must match its own expectations. */
function expectReport(report: ServiceTokenReport, expected: tExpected) {
    const verdicts = JSON.stringify(report.verdicts, null, 1)
    assert.equal(report.error, undefined, 'the run broke: ' + report.error + '\n' + verdicts)
    assert.deepEqual(report.verdicts.map(item => [item.outcome, item.layer]), expected, verdicts)
    assert.equal(report.ok, true, 'a verdict differs from its expectation\n' + verdicts)
}

function detailOf(report: ServiceTokenReport, step: string) {
    const found = report.verdicts.find(item => item.step.startsWith(step))
    assert.ok(found, 'no verdict for step: ' + step)
    return found.detail
}

async function post(origin: string, route: string, body: object) {
    const response = await fetch(origin + serviceTokenRoutes.base + route, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
    })
    return {status: response.status, body: await response.json().catch(() => null) as any}
}

async function main() {
    const stand = await startStand()
    const a = visitor(stand.origin, 'oracle-tab-a')
    const b = visitor(stand.origin, 'oracle-tab-b')
    const c = visitor(stand.origin, 'oracle-tab-c', downgradeLate)
    try {
        // ============== scenario 1: the handshake names an account ==============
        await check('scenario 1: a handshake-named account mints nothing and binds nothing', async function handshake() {
            const report = await a.control.run('handshake')
            expectReport(report, [
                ['allowed', 'routing'],
                ['refused', 'browserFragment'],
                ['refused', 'dispatch'],
                ['refused', 'gate'],
            ])
            assert.match(detailOf(report, 'look for a login verb'), /^identity: \{renew\}/)
            assert.match(detailOf(report, 'call identity.login()'), /^Not a function: board,identity,login$/)
            const clear = detailOf(report, 'run the owner-only clear')
            assert.match(clear, /^E_UNAUTHORIZED Unauthorized/)
            assert.match(clear, /RPC client presented no token/)
        })

        // ============== scenario 2: the stand issues after its own login ==============
        await check('scenario 2: the stand issues after its own login; the allow-list refuses the member, not the owner', async function issued() {
            const report = await a.control.run('issued')
            expectReport(report, [
                ['refused', 'standLogin'],
                ['allowed', 'leaderIssue'],
                ['allowed', 'resolveAuth'],
                ['allowed', 'access'],
                ['allowed', 'corridor'],
                ['refused', 'access'],
                ['allowed', 'leaderIssue'],
                ['allowed', 'resolveAuth'],
                ['allowed', 'access'],
                ['allowed', 'corridor'],
            ])
            assert.match(detailOf(report, 'stand login: member / wrong-password'), /^401 wrong demo credentials/)
            assert.match(detailOf(report, 'stand login: member / member-pass'), /claims \{sub, exp, jti\}/)
            assert.match(detailOf(report, 'present the member token'), /who: 'member'/)
            assert.match(detailOf(report, 'me()'), /account member · roles \[member\] · commands \[note\]/)
            assert.match(detailOf(report, 'member clears the board'), /commands\.clear is null .*Not a function: board,commands,clear/)
            assert.match(detailOf(report, 'owner clears the board'), /cleared 1 note/)
            assert.equal(a.view.snapshot().principals.board?.account, 'owner')
        })

        // ============== scenario 3: access.login — the leader is the identity provider ==============
        await check('scenario 3: access.login mints from credentials only; a desk token verifies nowhere else', async function selfIssued() {
            const report = await a.control.run('selfIssued')
            expectReport(report, [
                ['allowed', 'browserFragment'],
                ['refused', 'accessLogin'],
                ['refused', 'accessLogin'],
                ['allowed', 'accessLogin'],
                ['allowed', 'resolveAuth'],
                ['allowed', 'corridor'],
                ['refused', 'resolveAuth'],
            ])
            assert.match(detailOf(report, "look for a login verb on the desk"), /^identity: \{login, renew\}/)
            assert.match(detailOf(report, 'identity.login({account: "owner"'), /^login refused/)
            assert.match(detailOf(report, 'present the desk token to the board'), /token rejected: signature/)
            // the refused foreign token was transient: the board kept its owner principal
            assert.equal((await a.control.note('board', 'the owner is still here')).outcome, 'allowed')
        })

        // ============== scenario 4 + isolation: the operator revokes one sandbox's account ==============
        let sandboxA = ''
        let sandboxB = ''
        await check('isolation: a second visitor gets its own sandbox and its own owner session', async function secondVisitor() {
            const report = await b.control.run('issued')
            assert.equal(report.ok, true, JSON.stringify(report, null, 1))
            sandboxA = a.view.snapshot().sandbox?.id ?? ''
            sandboxB = b.view.snapshot().sandbox?.id ?? ''
            assert.ok(sandboxA && sandboxB && sandboxA != sandboxB, 'two tabs, two sandboxes')
            assert.equal(b.view.snapshot().principals.board?.account, 'owner')
        })

        await check('scenario 4: the operator revokes — the live session is cut, renewal and commands are refused', async function revoke() {
            const report = await a.control.run('revoke')
            expectReport(report, [
                ['allowed', 'leaderIssue'],
                ['allowed', 'resolveAuth'],
                ['allowed', 'access'],
                ['allowed', 'renew'],
                ['allowed', 'resolveAuth'],
                ['allowed', 'operator'],
                ['refused', 'sessionCut'],
                ['refused', 'denyList'],
                ['refused', 'gate'],
                ['refused', 'denyList'],
            ])
            assert.match(detailOf(report, 'renew the live token'), /^a fresh token \(new jti\)/)
            assert.match(detailOf(report, 'the operator revokes'), /revoked owner · 1 live session\(s\) cut/)
            assert.match(detailOf(report, 'keep using the live owner session'), /Pkt\.AUTH 'revoked' \(account revoked at the authority\) · the scale facade fell back to \{\}/)
            assert.match(detailOf(report, 'renew the token after the revoke'), /^account revoked at the authority$/)
            assert.match(detailOf(report, 'run a command on the same socket'), /^E_UNAUTHORIZED Unauthorized/)
            assert.match(detailOf(report, 're-present the same token'), /state: 'revoked', reason: 'account revoked at the authority'/)
            assert.equal(stand.host.view.isRevoked(sandboxA, 'board', 'owner'), true)
            assert.equal(a.view.snapshot().principals.board, null)
        })

        await check('scenario 4 when the downgrading MAP lands after Pkt.AUTH: the verdict waits for the facade to fall', async function lateDowngrade() {
            const report = await c.control.run('revoke')
            assert.equal(report.ok, true, JSON.stringify(report, null, 1))
            const session = detailOf(report, 'keep using the live owner session')
            assert.match(session, /the scale facade fell back to \{\} · ack \{ok: false, state: 'revoked'/, session)
        })

        await check("isolation: sandbox A's revoke leaves sandbox B's live owner session working", async function untouched() {
            assert.equal(stand.host.view.isRevoked(sandboxB, 'board', 'owner'), false)
            const still = await b.control.note('board', 'B is unaffected')
            assert.equal(still.outcome, 'allowed', JSON.stringify(still))
            // and A's own revoked session stays cut
            const cut = await a.control.note('board', 'A is cut')
            assert.deepEqual([cut.outcome, cut.layer], ['refused', 'gate'], JSON.stringify(cut))
        })

        await check('a sandbox is addressed only by its id: an unknown id reaches nothing', async function unknownSandbox() {
            const revoked = await post(stand.origin, serviceTokenRoutes.revoke, {sandbox: 'st-guess', service: 'board', account: 'owner'})
            assert.equal(revoked.status, 404)
            const login = await post(stand.origin, serviceTokenRoutes.login, {sandbox: 'st-guess', account: 'owner', password: 'owner-pass'})
            assert.equal(login.status, 404)
            assert.equal(stand.host.view.isRevoked(sandboxB, 'board', 'owner'), false)
        })

        await check("an explicit server-side login lifts the operator's revocation (the lifecycle verb)", async function relogin() {
            const report = await a.control.run('issued')
            assert.equal(report.ok, true, JSON.stringify(report, null, 1))
            assert.match(detailOf(report, 'stand login: owner / owner-pass'), /LIFTED the operator's earlier revocation/)
            assert.equal(stand.host.view.isRevoked(sandboxA, 'board', 'owner'), false)
        })

        // ============== bounds ==============
        await check('bounds: the board holds at most maxNotes notes; the corridor refuses the next', async function notesCap() {
            let added = 1   // B's board already holds the isolation note
            while (added < serviceTokenLimits.maxNotes) {
                const note = await b.control.note('board', 'note #' + added)
                assert.equal(note.outcome, 'allowed', JSON.stringify(note))
                added++
            }
            const full = await b.control.note('board', 'one too many')
            assert.deepEqual([full.outcome, full.layer], ['refused', 'corridor'], JSON.stringify(full))
            assert.match(full.detail, /the board is full \(12 notes\)/)
        })

        await check('bounds: one budget per sandbox refuses a login flood with 429', async function budget() {
            const opened = await post(stand.origin, serviceTokenRoutes.sandbox, {})
            assert.equal(opened.status, 200)
            const statuses: number[] = []
            for (let call = 0; call <= serviceTokenLimits.callsPerMinute; call++) {
                statuses.push((await post(stand.origin, serviceTokenRoutes.login, {sandbox: opened.body.sandbox, account: 'owner', password: 'guess-' + call})).status)
            }
            assert.equal(statuses.filter(status => status == 401).length, serviceTokenLimits.callsPerMinute)
            assert.equal(statuses.at(-1), 429)
            // the flood spent only its own sandbox's budget
            const other = await post(stand.origin, serviceTokenRoutes.login, {sandbox: sandboxB, account: 'member', password: 'member-pass'})
            assert.equal(other.status, 200)
        })

        await check('bounds: sockets per sandbox are capped by the host', async function socketCap() {
            const sandbox = sandboxB
            const room = serviceTokenLimits.socketsPerSandbox - stand.host.view.sockets(sandbox)
            const sockets = []
            const reasons: string[] = []
            try {
                for (let n = 0; n <= room; n++) {
                    const socket = io(stand.origin, {forceNew: true, reconnection: false, transports: ['websocket'],
                        auth: {tab: 'oracle-raw', role: serviceTokenRole, sandbox, service: 'board'}})
                    socket.on('disconnect', reason => reasons.push(reason))
                    sockets.push(socket)
                }
                await waitFor('the extra socket is refused by the host', () => reasons.includes('io server disconnect'))
                await waitFor('the cap holds', () => stand.host.view.sockets(sandbox) == serviceTokenLimits.socketsPerSandbox)
                assert.equal(reasons.length, 1, JSON.stringify(reasons))
            } finally {
                for (const socket of sockets) socket.disconnect()
            }
        })
    } finally {
        a.close()
        b.close()
        c.close()
        await stand.close()
    }

    // ============== a small stand: sandbox cap, eviction, idle sweep ==============
    const small = await startStand({limits: {maxSandboxes: 1}, sweepMs: 0})
    // the sweep check makes the host refuse a socket: websocket keeps that refusal from lingering
    const d = visitor(small.origin, 'oracle-tab-d', websocketOnly)
    const e = visitor(small.origin, 'oracle-tab-e', websocketOnly)
    try {
        await check('bounds: a full stand refuses a new sandbox while every sandbox has live sockets', async function full() {
            assert.equal((await d.control.run('issued')).ok, true)
            const refused = await e.control.run('handshake')
            assert.equal(refused.ok, false)
            assert.match(refused.error ?? '', /503 the service token stand is full/)
        })

        await check('bounds: a full stand evicts the least recently used sandbox nobody is connected to', async function evict() {
            const evicted = d.view.snapshot().sandbox?.id ?? ''
            d.close()
            await waitFor('the idle sandbox has no sockets', () => small.host.view.sockets(evicted) == 0)
            const report = await e.control.run('handshake')
            assert.equal(report.ok, true, JSON.stringify(report, null, 1))
            assert.equal(small.host.view.sandboxes(), 1)
            assert.equal((await post(small.origin, serviceTokenRoutes.login, {sandbox: evicted, account: 'owner', password: 'owner-pass'})).status, 404)
        })

        await check('bounds: the idle sweep closes a sandbox; the client opens a fresh one on its next run', async function sweep() {
            const before = e.view.snapshot().sandbox?.id ?? ''
            // scenario 1 closes its probe socket; the host must have seen it go before the sandbox is idle
            await waitFor('the probe socket is gone', () => small.host.view.sockets(before) == 0)
            assert.equal(small.host.control.sweep(Date.now() + serviceTokenLimits.sandboxIdleMs + 1), 1)
            assert.equal(small.host.view.sandboxes(), 0)
            const report = await e.control.run('issued')
            assert.equal(report.ok, true, JSON.stringify(report, null, 1))
            const after = e.view.snapshot().sandbox?.id
            assert.ok(after && after != before, 'a new sandbox replaced the swept one')
        })
    } finally {
        d.close()
        e.close()
        await small.close()
    }

    // ============== the openings budget, through the host's own facade ==============
    await check('bounds: sandbox openings per minute are budgeted across visitors', async function opens() {
        const host = createServiceTokenHost({limits: {opensPerMinute: 3}, sweepMs: 0})
        try {
            const results = [1, 2, 3, 4].map(() => host.control.openSandbox())
            assert.deepEqual(results.map(result => result.ok ? 200 : result.status), [200, 200, 200, 429])
            assert.equal(host.view.sandboxes(), 3)
        } finally {
            host.close()
        }
        assert.equal(host.view.sandboxes(), 0)
    })

    if (failed) process.exitCode = 1
    else console.log('PASS service token stand: handshake mints nothing, server-side issuance, access.login, operator revoke, isolation and bounds')
}

runOracle(main)
