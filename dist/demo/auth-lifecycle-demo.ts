// =====================================================================
// Auth lifecycle stand — browser half
// =====================================================================
// One socket, two GATED facades, one token provider. Everything a human has to SEE
// is on this panel: the grant and its countdown, a privileged stream that must NOT
// break across a renewal, the server's own Pkt.AUTH notices with timestamps, and the
// two counters that separate "how many alarms the server sent" from "how many times
// the provider was actually asked" — the latter is the single-flight proof.

import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import type {DeepSocketListen} from '../src/Common/rcp/listen-deep'
import type {RpcAuthRenewRequest} from '../src/Common/rcp/rpc-client'
import {
    authLifecycleTimings,
    authSocketKeys,
    type AuthGrantAck,
    type AuthLoginGrant,
    type AuthSessionRemote,
    type AuthTick,
    type AuthVaultRemote,
} from './auth-lifecycle-contract'

type tElement = (id: string) => HTMLElement

type AuthLifecycleDemoDeps = {
    element: tElement
    log: (line: string) => void
    /** Same tab identity the participant connection uses — one human, one browser tab. */
    tab: string
}

type tAuthStandState = 'anonymous' | 'authorized' | 'expiring' | 'expired' | 'revoked'

function errorText(error: unknown) {
    const code = (error as any)?.code
    const message = error instanceof Error ? error.message : String(error)
    return code ? code + ' — ' + message : message
}

function clockStamp(at: number) {
    const time = new Date(at)
    return time.toLocaleTimeString() + '.' + String(time.getMilliseconds()).padStart(3, '0')
}

export function setupAuthLifecycleDemo(deps: AuthLifecycleDemoDeps) {
    const {element, log} = deps
    const statusBadge = element('authStatus')
    const whoLine = element('authWho')
    const deadlineLine = element('authDeadline')
    const ticksLine = element('authTicks')
    const streamLine = element('authStream')
    const providerLine = element('authProvider')
    const noticesLine = element('authNotices')
    const resultLine = element('authResult')
    const logBox = element('authLog')
    const loginBtn = element('authLogin') as HTMLButtonElement
    const callBtn = element('authCall') as HTMLButtonElement
    const vaultBtn = element('authVault') as HTMLButtonElement
    const renewBtn = element('authRenew') as HTMLButtonElement
    const revokeBtn = element('authRevoke') as HTMLButtonElement

    let sid: string | null = null
    let token: string | null = null
    let grant: AuthGrantAck | null = null
    let state: tAuthStandState = 'anonymous'
    let autoRenew = true
    let busy = false
    let closed = false
    let providerCalls = 0
    let minted = 0
    let serverNotices = 0
    let ticksSeen = 0
    let lastTick = 0
    let gaps = 0
    let subscription: (() => void) | null = null
    let lastRow = 0

    // ============== the panel's own log: every notice, with its own clock ==============

    function note(text: string, tone?: 'good' | 'bad') {
        const at = Date.now()
        const row = document.createElement('div')
        row.className = 'authLogRow'
        if (tone) row.dataset.tone = tone
        const since = lastRow ? ' (+' + ((at - lastRow) / 1000).toFixed(1) + 's)' : ''
        lastRow = at
        row.textContent = clockStamp(at) + since + '  ' + text
        logBox.prepend(row)
        while (logBox.children.length > 40) logBox.lastChild?.remove()
    }

    function render() {
        if (closed) return
        const live = state == 'authorized' || state == 'expiring'
        statusBadge.textContent = state
        statusBadge.dataset.state = state == 'authorized' ? 'live'
            : state == 'expiring' ? 'connecting'
                : state == 'anonymous' ? 'idle' : 'stale'
        whoLine.textContent = live && grant?.who ? grant.who : 'anonymous (gate refuses every call)'
        const left = grant?.expiresAt ? (grant.expiresAt - Date.now()) / 1000 : null
        deadlineLine.textContent = live && left != null
            ? 'grant expires in ' + Math.max(left, 0).toFixed(1) + 's · session ' + (grant?.sid ?? '—')
            : grant?.reason ? 'last server word: ' + grant.reason : 'no grant yet'
        ticksLine.textContent = ticksSeen ? ticksSeen + ' ticks · last #' + lastTick : 'not subscribed'
        streamLine.textContent = subscription
            ? 'stream live · gaps across renewals: ' + gaps
            : ticksSeen ? 'stream ended by the server · gaps: ' + gaps : 'the anonymous facade has no ticks node'
        providerLine.textContent = 'provider calls ' + providerCalls + ' · tokens minted ' + minted
        noticesLine.textContent = 'server Pkt.AUTH notices ' + serverNotices
            + ' · auto-renew ' + (autoRenew ? 'on' : 'off')
        renewBtn.textContent = 'Auto-renew: ' + (autoRenew ? 'on' : 'off')
        renewBtn.setAttribute('aria-pressed', String(autoRenew))
        loginBtn.disabled = busy
        callBtn.disabled = busy
        vaultBtn.disabled = busy
        revokeBtn.disabled = busy || !live
    }

    // ============== the token provider: ONE function for the whole lifecycle ==============
    // The hub consults it on connect, on every server notice and on an unauthorized retry,
    // and collapses a whole wave of those into a single call — which is why the counter
    // above reads "2 notices, 1 provider call" after a renewal.

    async function provideToken(request: RpcAuthRenewRequest) {
        providerCalls++
        const trigger = request.notice ? request.reason + '/' + request.notice.state : request.reason
        if (!sid) {
            note('provider asked (' + trigger + ') → no session yet, staying anonymous')
            render()
            return null
        }
        if (!autoRenew) {
            note('provider asked (' + trigger + ') → renewal is OFF, no token', 'bad')
            render()
            return null
        }
        try {
            const fresh = await mintToken()
            note('provider asked (' + trigger + ') → minted token #' + minted, 'good')
            void adoptRenewedGrant(grant?.expiresAt)
            return fresh
        } catch (error) {
            note('provider asked (' + trigger + ') → mint refused: ' + errorText(error), 'bad')
            return null
        } finally {
            render()
        }
    }

    // A renewal has no completion event of its own — the fresh grant arrives inside the MAP
    // the server sends after the soft re-auth. So the panel waits for the ack to change
    // instead of guessing, and only then repaints the deadline it shows the human.
    async function adoptRenewedGrant(previous: number | undefined) {
        for (let attempt = 0; attempt < 20 && !closed; attempt++) {
            await new Promise(function waitForFreshAck(resolve) { setTimeout(resolve, 100) })
            const ack = await hub.facade.session.auth() as AuthGrantAck | null
            if (!ack || ack.ok == false || ack.expiresAt == previous) continue
            grant = ack
            state = 'authorized'
            note('renewal applied: deadline moved out to ' + clockStamp(ack.expiresAt ?? Date.now()), 'good')
            render()
            return
        }
    }

    // The identity port is deliberately OUTSIDE the gated RPC surface: with gate: true
    // nothing is callable until a HELLO succeeds, so a login method there could never run.
    async function mintToken() {
        const response = await fetch('/auth-lifecycle/login', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({sid}),
        })
        const payload = await response.json().catch(function unreadableLoginReply() { return null })
        if (!response.ok) throw new Error((payload as any)?.error ?? 'login failed with ' + response.status)
        const issued = payload as AuthLoginGrant
        minted++
        sid = issued.sid
        token = issued.token
        return issued.token
    }

    // ============== the connection: two gated facades, one provider ==============
    // forceNew is not decoration: socket.io returns the SAME socket for a namespace it
    // already has, so without it this stand would silently ride the participant socket.

    const hub = createRpcClientHub(
        () => io({auth: {tab: deps.tab, role: 'auth'}, forceNew: true}),
        r => ({
            session: r<AuthSessionRemote>(authSocketKeys.session),
            vault: r<AuthVaultRemote>(authSocketKeys.vault),
        }) as const,
        {token: provideToken},
    )

    hub.authListen(function onAuthNotice(event) {
        if (event.state == 'renewFailed') {
            note('client: renewal produced nothing (' + event.key + ')', 'bad')
        } else {
            serverNotices++
            note('Pkt.AUTH ' + event.state + ' ← facade "' + event.key + '"'
                + (event.reason ? ' · ' + String(event.reason) : ''),
                event.state == 'expiring' ? undefined : 'bad')
        }
        if (event.state == 'expiring' && state == 'authorized') state = 'expiring'
        if (event.state == 'expired' || event.state == 'revoked') {
            state = event.state
            grant = {ok: false, state: event.state, reason: event.reason == null ? undefined : String(event.reason)}
        }
        render()
    })

    // ============== the privileged stream ==============
    // Its node lives on the PRIVILEGED facade only, so the server ends it on downgrade and
    // keeps it across a renewal. A gap in tick numbers would mean the renewal was not soft.

    // The subscription surface a Listen node projects to is a RUNTIME projection; the static
    // client API cannot infer it (a callback would come out as Promise<never>), so the live
    // contract is declared here — the same cast the RPC harness uses for the same reason.
    function sessionStreams() {
        return hub.facade.session.func as unknown as DeepSocketListen<AuthSessionRemote>
    }

    function subscribeTicks() {
        if (subscription || closed) return
        const handle = sessionStreams().ticks.on(function onAuthTick(tick: AuthTick) {
            if (lastTick && tick.n != lastTick + 1) {
                gaps++
                note('tick gap: #' + lastTick + ' → #' + tick.n, 'bad')
            }
            lastTick = tick.n
            ticksSeen++
            render()
        })
        subscription = handle
        note('subscribed to the privileged tick stream')
        void Promise.resolve(handle).then(function authTickStreamEnded() {
            if (subscription != handle) return
            subscription = null
            note('privileged tick stream ENDED cleanly (server tore it down with the principal)', 'bad')
            render()
        })
    }

    function dropTicks() {
        const handle = subscription
        subscription = null
        handle?.()
    }

    async function run(action: () => Promise<void>) {
        if (busy) return
        busy = true
        render()
        try { await action() }
        catch (error) {
            resultLine.textContent = errorText(error)
            note('action failed: ' + errorText(error), 'bad')
        }
        finally {
            busy = false
            render()
        }
    }

    // ============== the five things a human can do ==============

    async function login() {
        // A new demo session every time, so a revoked one never comes back to life.
        sid = null
        dropTicks()
        lastTick = 0
        const fresh = await mintToken()
        note('login: presenting a fresh ' + (authLifecycleTimings.ttlMs / 1000) + 's token to both facades')
        const acks = await hub.reauth(fresh) as AuthGrantAck[]
        const refused = acks.find(ack => ack?.ok == false)
        if (refused) {
            state = 'anonymous'
            grant = refused
            resultLine.textContent = 'login refused: ' + (refused.reason ?? 'unknown reason')
            return
        }
        grant = await hub.facade.session.auth() as AuthGrantAck
        state = 'authorized'
        resultLine.textContent = 'logged in as ' + (grant?.who ?? 'demo-member')
        log('auth stand: logged in as ' + (grant?.who ?? 'demo-member'))
        subscribeTicks()
    }

    async function callPrivileged() {
        const answer = await hub.facade.session.func.secret()
        resultLine.textContent = 'session.secret() → ' + answer
        note('privileged call answered: ' + answer, 'good')
    }

    async function readVault() {
        const answer = await hub.facade.vault.func.read()
        resultLine.textContent = 'vault.read() → ' + answer.entries.join(', ')
        note('second facade answered ' + answer.entries.length + ' entries', 'good')
    }

    // Revocation is a server-side decision, but the downgrade corridor only runs when a
    // token is PRESENTED: the stand marks the session revoked, then re-presents the very
    // same token so resolveAuth can throw `revoke: true` at it.
    async function revokeNow() {
        const answer = await hub.facade.session.func.revoke()
        note('server marked session ' + answer.sid + ' revoked; re-presenting the dead token')
        await hub.reauth(token)
        resultLine.textContent = 'session ' + answer.sid + ' revoked — press Login for a new one'
        log('auth stand: session revoked')
    }

    function toggleRenew() {
        autoRenew = !autoRenew
        note('auto-renew switched ' + (autoRenew ? 'ON' : 'OFF — the next deadline will be the last'))
        render()
    }

    loginBtn.addEventListener('click', function onAuthLogin() { void run(login) })
    callBtn.addEventListener('click', function onAuthCall() { void run(callPrivileged) })
    vaultBtn.addEventListener('click', function onAuthVault() { void run(readVault) })
    revokeBtn.addEventListener('click', function onAuthRevoke() { void run(revokeNow) })
    renewBtn.addEventListener('click', toggleRenew)

    // The countdown is the only thing that has to repaint on its own.
    const countdown = setInterval(render, 200)

    void hub.promise.then(function authStandConnected() {
        if (closed) return
        note('connected anonymously: gate: true, so every call is refused until a token lands')
        render()
    })

    render()

    return {
        close() {
            if (closed) return
            closed = true
            clearInterval(countdown)
            dropTicks()
            hub.socket?.disconnect?.()
        },
    }
}

export type AuthLifecycleDemo = ReturnType<typeof setupAuthLifecycleDemo>
