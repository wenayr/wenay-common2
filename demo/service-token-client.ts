// =====================================================================
// Service tokens stand — the scenario driver (DOM-free: the panel and the oracle share it)
// =====================================================================
// Every scenario crosses real boundaries — the stand's HTTP login, the ungated 'app' key, the
// gated 'scale' key — and reports each step as a verdict that names the layer which decided it.
// `expected` is what the 3.0.1 contract says must happen; a verdict whose outcome differs is the
// visible alarm on the panel and the failure in the oracle.

import {io, type ManagerOptions, type Socket, type SocketOptions} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {createRpcClientHub, type RpcHubAuthEvent} from '../src/Common/rcp/rpc-clientHub'
import {
    serviceTokenCredentials,
    serviceTokenKeys,
    serviceTokenRole,
    serviceTokenRoutes,
    type ServiceTokenLoginReply,
    type ServiceTokenRefusal,
    type ServiceTokenRevokeReply,
    type ServiceTokenSandboxReply,
    type ServiceTokenWire,
    type tServiceTokenAccount,
    type tServiceTokenService,
} from './service-token-contract'

// ============================================================
// verdict vocabulary
// ============================================================

/** Who decided a step: every verdict names one of these layers. */
export const serviceTokenLayers = {
    routing: 'stand host · routes the socket by role, sandbox and service',
    standLogin: "stand HTTP login · the application's own authentication",
    budget: 'stand host · per-sandbox budget',
    leaderIssue: 'leader.identity.login(account) · issued server-side',
    browserFragment: 'leader.serve.browserFragment() · the ungated identity port',
    dispatch: 'RPC dispatch · no route to a member the facade does not serve',
    gate: 'RPC gate · gate: true, no principal on this key',
    resolveAuth: 'serve.scaleConnection() resolveAuth · codec + deny list',
    access: 'service access · roles from state, commands pruned by allow',
    corridor: 'leader corridor · allow-list, budgets and receipts at the point of order',
    accessLogin: 'definition access.login · the leader as identity provider',
    renew: 'leader identity.renew · a live, unrevoked token for a fresh one',
    denyList: 'authority deny list · a revoked account is refused everywhere',
    operator: 'stand operator · leader.control.revoke(account)',
    sessionCut: 'authority session registry · control.revoke on every live session (RPC-AUTH rule 7)',
} as const
export type tServiceTokenLayer = keyof typeof serviceTokenLayers

export const serviceTokenScenarios = {
    handshake: '1 · An account named in the handshake',
    issued: '2 · The stand issues after its own login',
    selfIssued: '3 · access.login: the leader checks credentials',
    revoke: '4 · The operator revokes',
} as const
export type tServiceTokenScenario = keyof typeof serviceTokenScenarios

export type tVerdictOutcome = 'allowed' | 'refused'

export type ServiceTokenVerdict = {
    step: string
    /** What the 3.0.1 contract says must happen. */
    expected: tVerdictOutcome
    outcome: tVerdictOutcome
    layer: tServiceTokenLayer
    /** The decider's own words: an error, an ack, a receipt. */
    detail: string
}

export type ServiceTokenReport = {
    scenario: tServiceTokenScenario
    verdicts: ServiceTokenVerdict[]
    /** Every verdict matched its expectation and nothing broke the run. */
    ok: boolean
    error?: string
}

type tPrincipal = {account: string, roles: readonly string[], expiresAt?: number}
type tNote = {text: string, by: string}

export type ServiceTokenSnapshot = {
    sandbox: {id: string, expiresAt: number} | null
    principals: {[S in tServiceTokenService]: tPrincipal | null}
    notes: {[S in tServiceTokenService]: tNote[] | null}
    /** The last server word about a service session: a revocation reason, a refusal. */
    notices: {[S in tServiceTokenService]: string}
}

/** The sandbox this client held is gone (swept, evicted) or refused its socket: open a new one. */
class SandboxGone extends Error {}

// ============================================================
// small pure helpers
// ============================================================

type tAttempt<T> = {ok: true, value: T} | {ok: false, error: unknown}

function attempt<T>(work: PromiseLike<T>): Promise<tAttempt<T>> {
    return Promise.resolve(work).then(
        function attemptAnswered(value): tAttempt<T> { return {ok: true, value} },
        function attemptRefused(error: unknown): tAttempt<T> { return {ok: false, error} },
    )
}

function errorText(error: unknown) {
    const code = (error as {code?: unknown} | null)?.code
    const message = String((error as {message?: unknown} | null)?.message ?? error)
    return typeof code == 'string' && code != 'ERR' ? code + ' ' + message : message
}

/** Which layer refused, read from the refusal itself; `fallback` names the caller's context. */
function refusalLayer(error: unknown, fallback: tServiceTokenLayer): tServiceTokenLayer {
    const code = (error as {code?: unknown} | null)?.code
    const message = String((error as {message?: unknown} | null)?.message ?? error)
    if (code == 'E_UNAUTHORIZED') return 'gate'
    if (message.startsWith('demo rate limit')) return 'budget'
    if (message == 'account revoked at the authority') return 'denyList'
    if (message.startsWith('token rejected')) return 'resolveAuth'
    if (message == 'login refused') return 'accessLogin'
    if (message.startsWith('forbidden') || message.startsWith('rate limit') || message.startsWith('the board is full')) return 'corridor'
    return fallback
}

function clock(at: number) {
    return new Date(at).toLocaleTimeString()
}

function expiryText(expiresAt: number | undefined) {
    if (expiresAt == undefined) return 'no deadline'
    return 'expires ' + clock(expiresAt) + ' (in ' + Math.round((expiresAt - Date.now()) / 60_000) + ' min)'
}

/** The claims inside a v1 token: the holder may read them, the mac is what nobody can forge. */
function claimsOf(token: string): Record<string, unknown> {
    try {
        const payload = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')
        return JSON.parse(atob(payload)) as Record<string, unknown>
    } catch {
        return {}
    }
}

function tokenText(token: string, expiresAt: number | undefined) {
    return token.slice(0, 10) + '… claims {' + Object.keys(claimsOf(token)).join(', ') + '} · ' + expiryText(expiresAt)
}

type tAck = {ok?: boolean, who?: string, node?: string, state?: string, reason?: string} | null | undefined

function ackText(ack: tAck) {
    if (!ack) return 'no ack'
    if (ack.ok) return `{ok: true, who: '${ack.who}', node: '${ack.node}'}`
    return `{ok: false${ack.state ? `, state: '${ack.state}'` : ''}, reason: '${ack.reason ?? 'unknown'}'}`
}

function verdict(step: string, expected: tVerdictOutcome, outcome: tVerdictOutcome, layer: tServiceTokenLayer, detail: string): ServiceTokenVerdict {
    return {step, expected, outcome, layer, detail}
}

function delay(ms: number) {
    return new Promise<void>(function waitServiceTokenDelay(resolve) { setTimeout(resolve, ms) })
}

// ============================================================
// the client
// ============================================================

export type ServiceTokenClientDeps = {
    /** The stand's origin; the browser passes location.origin. */
    origin: string
    /** The stand refuses a socket without a tab: one human, one browser tab. */
    tab: string
    fetch?: typeof fetch
    /** Bound of every wire wait: a hung step ends as a report, never as a spinner. */
    timeoutMs?: number
    /** The socket factory; default socket.io-client's io, polling first like the whole stand
     *  (HTTP-only tunnels). Tests swap the transport here. */
    connect?: (origin: string, options: Partial<ManagerOptions & SocketOptions>) => Socket
}

export function createServiceTokenClient(deps: ServiceTokenClientDeps) {
    const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
    const connect = deps.connect ?? io
    const timeoutMs = deps.timeoutMs ?? 8_000
    const [emitChange, changes] = listen<[ServiceTokenSnapshot]>()
    let sandbox: ServiceTokenSnapshot['sandbox'] = null
    const principals: ServiceTokenSnapshot['principals'] = {board: null, desk: null}
    const notes: ServiceTokenSnapshot['notes'] = {board: null, desk: null}
    const notices: ServiceTokenSnapshot['notices'] = {board: '', desk: ''}
    const connections: {board?: tConnection<'board'>, desk?: tConnection<'desk'>} = {}
    let requestSeq = 0
    let queue: Promise<unknown> = Promise.resolve()
    let closed = false

    function snapshot(): ServiceTokenSnapshot {
        return {
            sandbox: sandbox && {...sandbox},
            principals: {...principals},
            notes: {board: notes.board && [...notes.board], desk: notes.desk && [...notes.desk]},
            notices: {...notices},
        }
    }

    function publish() {
        if (!closed) emitChange(snapshot())
    }

    function bounded<T>(work: PromiseLike<T>, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<never>(function rejectAfterTimeout(_resolve, reject) {
            timer = setTimeout(function serviceTokenTimeout() { reject(new Error('timeout: ' + label)) }, timeoutMs)
        })
        return Promise.race([work, expired]).finally(function clearServiceTokenTimeout() { clearTimeout(timer) })
    }

    function requestId(prefix: string) {
        return prefix + '-' + (++requestSeq) + '-' + Math.random().toString(36).slice(2, 8)
    }

    // ============== resource: the stand's HTTP port ==============

    async function post<T>(route: string, body: object): Promise<{ok: true, value: T} | {ok: false, status: number, error: string}> {
        const response = await bounded(request(deps.origin + serviceTokenRoutes.base + route, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
        }), 'POST ' + route)
        const payload: unknown = await response.json().catch(function unreadableServiceTokenReply() { return null })
        if (response.ok) return {ok: true, value: payload as T}
        const error = (payload as ServiceTokenRefusal | null)?.error ?? 'HTTP ' + response.status
        if (response.status == 404) throw new SandboxGone(error)
        return {ok: false, status: response.status, error}
    }

    async function ensureSandbox() {
        if (sandbox) return sandbox.id
        const opened = await post<ServiceTokenSandboxReply>(serviceTokenRoutes.sandbox, {})
        if (!opened.ok) throw new Error('no sandbox: ' + opened.status + ' ' + opened.error)
        sandbox = {id: opened.value.sandbox, expiresAt: opened.value.expiresAt}
        publish()
        return sandbox.id
    }

    /** Drop the sandbox and everything bound to it; the next scenario opens a fresh one. */
    function forget() {
        for (const connection of Object.values(connections)) connection?.hub.close()
        delete connections.board
        delete connections.desk
        sandbox = null
        principals.board = principals.desk = null
        notes.board = notes.desk = null
        notices.board = notices.desk = ''
        publish()
    }

    // ============== resource: one socket per service ('app' ungated + 'scale' gated) ==============

    async function open<S extends tServiceTokenService>(service: S, extraHandshake: Record<string, unknown> = {}) {
        const id = await ensureSandbox()
        let dropped: string | null = null
        const received: RpcHubAuthEvent[] = []
        const hub = createRpcClientHub(
            function openServiceTokenSocket() {
                // forceNew: a dedicated manager per connection (the hub's contract); no reconnection:
                // a dropped socket is a closed session here, the next scenario opens a fresh one
                return connect(deps.origin, {
                    forceNew: true,
                    reconnection: false,
                    auth: {...extraHandshake, tab: deps.tab, role: serviceTokenRole, sandbox: id, service},
                })
            },
            r => ({
                app: r<ServiceTokenWire<S>['app']>(serviceTokenKeys.app),
                scale: r<ServiceTokenWire<S>['scale']>(serviceTokenKeys.scale),
            }),
        )
        hub.authListen(function recordServiceTokenNotice(event) { received.push(event) })
        const refused = new Promise<never>(function watchServiceTokenSocket(_resolve, reject) {
            hub.disconnectListen(function serviceTokenSocketDropped(reason) {
                dropped = reason
                reject(new SandboxGone('the stand closed the ' + service + ' socket (' + reason + ')'))
            })
        })
        // a drop after the handshake is read through dropped(), not through this promise
        refused.catch(function socketDroppedLater() {})
        try {
            const clients = await bounded(Promise.race([hub.setToken(null), refused]), 'the ' + service + ' socket')
            await bounded(Promise.race([clients.app.readyStrict(), refused]), 'the ' + service + ' app schema')
            await bounded(Promise.race([clients.scale.readyStrict(), refused]), 'the ' + service + ' scale schema')
            return {hub, app: clients.app, scale: clients.scale, notices: received, dropped: () => dropped != null}
        } catch (error) {
            hub.close()
            throw error
        }
    }
    type tConnection<S extends tServiceTokenService> = Awaited<ReturnType<typeof open<S>>>

    // a fresh socket is an anonymous principal: the card forgets the old one before it opens
    async function board() {
        const live = connections.board
        if (live && !live.dropped()) return live
        principals.board = null
        publish()
        return connections.board = await open('board')
    }

    async function desk() {
        const live = connections.desk
        if (live && !live.dropped()) return live
        principals.desk = null
        publish()
        return connections.desk = await open('desk')
    }

    /** The stand's own login for the board: its authentication first, the leader's issuance after. */
    async function standLogin(account: tServiceTokenAccount, password: string = serviceTokenCredentials[account]) {
        const id = await ensureSandbox()
        return post<ServiceTokenLoginReply>(serviceTokenRoutes.login, {sandbox: id, account, password})
    }

    async function waitForNotice(connection: {notices: RpcHubAuthEvent[]}, from: number, state: string) {
        for (let waited = 0; waited < timeoutMs; waited += 50) {
            const found = connection.notices.slice(from).find(event => event.key == serviceTokenKeys.scale && event.state == state)
            if (found) return found
            await delay(50)
        }
        return null
    }

    /** Pkt.AUTH lands first and the downgrading Pkt.MAP after it (RPC-AUTH rule 7) — over polling
     *  in a later response — so the facade is read only once the ack itself has turned. */
    async function waitForDowngrade(connection: {scale: {auth: () => Promise<unknown>}}) {
        let ack = await bounded(connection.scale.auth(), 'ack after the revoke') as tAck
        for (let waited = 0; ack?.ok != false && waited < timeoutMs; waited += 50) {
            await delay(50)
            ack = await bounded(connection.scale.auth(), 'ack after the revoke') as tAck
        }
        return ack
    }

    // ============== scenario 1: an account named in the handshake ==============

    async function handshakeScenario(verdicts: ServiceTokenVerdict[]) {
        // a one-off peer whose handshake names an account — what any network client can send
        const probe = await open('board', {account: 'owner'})
        try {
            verdicts.push(verdict('open the board socket with handshake auth {account: "owner"}', 'allowed', 'allowed', 'routing',
                'connected: the host read role, sandbox and service; it never reads an account'))
            const identity = Object.keys((probe.app.schema() as {board?: {identity?: object}} | null)?.board?.identity ?? {})
            const offersLogin = identity.includes('login')
            verdicts.push(verdict('look for a login verb on the ungated identity facade', 'refused', offersLogin ? 'allowed' : 'refused',
                'browserFragment', 'identity: {' + identity.join(', ') + '}'
                    + (offersLogin ? ' — a login verb is served to anyone' : ' — no access.login, so this port only renews a live token')))
            // the typed facade has no login, correctly: the forged CALL goes by path
            const forged = probe.app.func.board.identity as unknown as {login: () => Promise<{token?: unknown, account?: unknown}>}
            const minted = await attempt(bounded(forged.login(), 'forged login'))
            const token = minted.ok && typeof minted.value?.token == 'string' ? minted.value.token : null
            verdicts.push(minted.ok
                ? verdict('call identity.login() anyway (a forged CALL)', 'refused', 'allowed', 'browserFragment',
                    token ? 'MINTED a token for ' + String(minted.value.account) : 'answered ' + JSON.stringify(minted.value))
                : verdict('call identity.login() anyway (a forged CALL)', 'refused', 'refused', refusalLayer(minted.error, 'dispatch'),
                    errorText(minted.error)))
            // the whole exploit chain: whatever came back is presented, then the owner-only verb is tried
            if (token) await attempt(bounded(probe.scale.reauth(token), 'present the minted token'))
            const ack = await bounded(probe.scale.auth(), 'probe ack') as tAck
            const clear = await attempt(bounded(probe.scale.func.board.commands.clear(requestId('clear'), {}), 'probe clear'))
            verdicts.push(clear.ok
                ? verdict('run the owner-only clear as the handshake-named "owner"', 'refused', 'allowed', 'corridor',
                    'the board was cleared: ' + JSON.stringify(clear.value))
                : verdict('run the owner-only clear as the handshake-named "owner"', 'refused', 'refused', refusalLayer(clear.error, 'gate'),
                    errorText(clear.error) + ' · scale.auth(): ' + ackText(ack) + ' — nothing was bound from the handshake'))
        } finally {
            probe.hub.close()
        }
    }

    // ============== scenario 2: the stand issues after its own login ==============

    async function presentOnBoard(verdicts: ServiceTokenVerdict[], connection: tConnection<'board'>, token: string, account: string) {
        const ack = await bounded(connection.scale.reauth(token), 'board reauth') as tAck
        verdicts.push(verdict(`present the ${account} token on the gated scale key (scale.reauth)`, 'allowed',
            ack?.ok ? 'allowed' : 'refused', 'resolveAuth', 'ack ' + ackText(ack)))
        return ack?.ok == true
    }

    async function loginOnBoard(verdicts: ServiceTokenVerdict[], connection: tConnection<'board'>, account: tServiceTokenAccount) {
        const issued = await standLogin(account)
        if (!issued.ok) {
            verdicts.push(verdict(`stand login: ${account} / ${serviceTokenCredentials[account]}`, 'allowed', 'refused',
                issued.status == 429 ? 'budget' : 'standLogin', issued.status + ' ' + issued.error))
            return null
        }
        const {token, expiresAt, liftedRevocation} = issued.value
        verdicts.push(verdict(`stand login: ${account} / ${serviceTokenCredentials[account]}`, 'allowed', 'allowed', 'leaderIssue',
            `token for ${issued.value.account}: ${tokenText(token, expiresAt)} — no roles inside, the leader reads them from its state`
                + (liftedRevocation ? ' · this explicit login LIFTED the operator\'s earlier revocation' : '')))
        if (!await presentOnBoard(verdicts, connection, token, account)) return null
        const me = await attempt(bounded(connection.scale.func.board.me(), 'me()'))
        if (me.ok) {
            principals.board = {account: me.value.account, roles: me.value.roles, expiresAt}
            notices.board = liftedRevocation ? 'revocation lifted by an explicit login' : ''
            publish()
        }
        verdicts.push(me.ok
            ? verdict('me() on the gated facade', 'allowed', 'allowed', 'access',
                `account ${me.value.account} · roles [${me.value.roles.join(', ')}] · commands [${me.value.commands.join(', ')}] · views [${me.value.views.join(', ')}]`)
            : verdict('me() on the gated facade', 'allowed', 'refused', refusalLayer(me.error, 'access'), errorText(me.error)))
        return token
    }

    async function issuedScenario(verdicts: ServiceTokenVerdict[]) {
        const connection = await board()
        const wrong = await standLogin('member', 'wrong-password')
        verdicts.push(wrong.ok
            ? verdict('stand login: member / wrong-password', 'refused', 'allowed', 'leaderIssue', 'ISSUED a token for a wrong password')
            : verdict('stand login: member / wrong-password', 'refused', 'refused', wrong.status == 429 ? 'budget' : 'standLogin',
                wrong.status + ' ' + wrong.error))

        if (!await loginOnBoard(verdicts, connection, 'member')) return
        const note = await attempt(bounded(connection.scale.func.board.commands.note(requestId('note'), {text: 'the member was here'}), 'member note'))
        if (note.ok) {
            notes.board = note.value.notes
            publish()
        }
        verdicts.push(note.ok
            ? verdict('member adds a note', 'allowed', 'allowed', 'corridor', `receipt: ${note.value.notes.length} note(s) on the board`)
            : verdict('member adds a note', 'allowed', 'refused', refusalLayer(note.error, 'corridor'), errorText(note.error)))

        const schema = connection.scale.schema() as {board?: {commands?: Record<string, unknown>}} | null
        const clear = await attempt(bounded(connection.scale.func.board.commands.clear(requestId('clear'), {}), 'member clear'))
        verdicts.push(clear.ok
            ? verdict('member clears the board', 'refused', 'allowed', 'corridor', 'the member cleared the board: ' + JSON.stringify(clear.value))
            : verdict('member clears the board', 'refused', 'refused', refusalLayer(clear.error, 'access'),
                `commands.clear is ${String(schema?.board?.commands?.['clear'])} in the member's facade (allow: ['owner']) · the dispatcher: ${errorText(clear.error)}`))

        if (!await loginOnBoard(verdicts, connection, 'owner')) return
        const cleared = await attempt(bounded(connection.scale.func.board.commands.clear(requestId('clear'), {}), 'owner clear'))
        if (cleared.ok) {
            notes.board = cleared.value.notes
            publish()
        }
        verdicts.push(cleared.ok
            ? verdict('owner clears the board (same socket, new principal)', 'allowed', 'allowed', 'corridor', `receipt: cleared ${cleared.value.cleared} note(s)`)
            : verdict('owner clears the board (same socket, new principal)', 'allowed', 'refused', refusalLayer(cleared.error, 'corridor'), errorText(cleared.error)))
    }

    // ============== scenario 3: access.login — the leader checks the credentials ==============

    async function selfIssuedScenario(verdicts: ServiceTokenVerdict[]) {
        const connection = await desk()
        const identity = Object.keys((connection.app.schema() as {desk?: {identity?: object}} | null)?.desk?.identity ?? {})
        verdicts.push(verdict("look for a login verb on the desk's ungated identity facade", 'allowed',
            identity.includes('login') ? 'allowed' : 'refused', 'browserFragment',
            'identity: {' + identity.join(', ') + '} — the definition declares access.login'))

        const login = connection.app.func.desk.identity.login
        const bare = await attempt(bounded(login(undefined), 'login without credentials'))
        verdicts.push(bare.ok
            ? verdict('identity.login() without credentials', 'refused', 'allowed', 'accessLogin', 'MINTED a token without credentials')
            : verdict('identity.login() without credentials', 'refused', 'refused', refusalLayer(bare.error, 'accessLogin'),
                errorText(bare.error) + ' (the login input schema)'))
        const wrong = await attempt(bounded(login({account: 'owner', password: 'wrong-password'}), 'login with a wrong password'))
        verdicts.push(wrong.ok
            ? verdict('identity.login({account: "owner", password: "wrong-password"})', 'refused', 'allowed', 'accessLogin', 'MINTED a token for a wrong password')
            : verdict('identity.login({account: "owner", password: "wrong-password"})', 'refused', 'refused', refusalLayer(wrong.error, 'accessLogin'),
                errorText(wrong.error) + ' — resolve() returned null'))
        const minted = await attempt(bounded(login({account: 'member', password: serviceTokenCredentials.member}), 'member login'))
        if (!minted.ok) {
            verdicts.push(verdict('identity.login({account: "member", password: "member-pass"})', 'allowed', 'refused',
                refusalLayer(minted.error, 'accessLogin'), errorText(minted.error)))
            return
        }
        const {token, expiresAt} = minted.value
        verdicts.push(verdict('identity.login({account: "member", password: "member-pass"})', 'allowed', 'allowed', 'accessLogin',
            `the desk's leader minted a token for ${minted.value.account}: ${tokenText(token, expiresAt)}`))

        const ack = await bounded(connection.scale.reauth(token), 'desk reauth') as tAck
        verdicts.push(verdict("present it on the desk's scale key", 'allowed', ack?.ok ? 'allowed' : 'refused', 'resolveAuth', 'ack ' + ackText(ack)))
        if (!ack?.ok) return
        principals.desk = {account: String(ack.who), roles: ['member'], expiresAt}
        const note = await attempt(bounded(connection.scale.func.desk.commands.note(requestId('note'), {text: 'signed in at the desk'}), 'desk note'))
        if (note.ok) notes.desk = note.value.notes
        publish()
        verdicts.push(note.ok
            ? verdict('member adds a note to the desk', 'allowed', 'allowed', 'corridor', `receipt: ${note.value.notes.length} note(s) on the desk`)
            : verdict('member adds a note to the desk', 'allowed', 'refused', refusalLayer(note.error, 'corridor'), errorText(note.error)))

        // another leader, another per-run secret: a desk token verifies nowhere else
        const boardConnection = await board()
        const foreign = await bounded(boardConnection.scale.reauth(token), 'desk token on the board') as tAck
        verdicts.push(verdict('present the desk token to the board (another leader)', 'refused', foreign?.ok ? 'allowed' : 'refused',
            foreign?.ok ? 'resolveAuth' : refusalLayer({message: foreign?.reason}, 'resolveAuth'),
            'ack ' + ackText(foreign) + (foreign?.ok ? '' : ' — each leader signs with its own per-run secret; a plain throw is transient, the board keeps its principal')))
    }

    // ============== scenario 4: the operator revokes ==============

    async function revokeScenario(verdicts: ServiceTokenVerdict[]) {
        const connection = await board()
        const token = await loginOnBoard(verdicts, connection, 'owner')
        if (!token) return
        const id = await ensureSandbox()

        const renewed = await attempt(bounded(connection.app.func.board.identity.renew(token), 'renew'))
        const expiresBefore = principals.board?.expiresAt
        let current = token
        if (renewed.ok) {
            current = renewed.value.token
            // every leader token lives the codec's fixed 15 min, so the deadline moves by the time elapsed
            const moved = renewed.value.expiresAt != undefined && expiresBefore != undefined
                ? ' · deadline +' + ((renewed.value.expiresAt - expiresBefore) / 1000).toFixed(1) + 's'
                : ''
            const fresh = claimsOf(current)['jti'] != claimsOf(token)['jti'] ? 'a fresh token (new jti) ' : 'the same token '
            verdicts.push(verdict('renew the live token (identity.renew on the ungated key)', 'allowed', 'allowed', 'renew',
                fresh + tokenText(current, renewed.value.expiresAt) + moved))
            await presentOnBoard(verdicts, connection, current, 'renewed owner')
        } else {
            verdicts.push(verdict('renew the live token (identity.renew on the ungated key)', 'allowed', 'refused',
                refusalLayer(renewed.error, 'renew'), errorText(renewed.error)))
        }

        const heard = connection.notices.length
        const revoked = await post<ServiceTokenRevokeReply>(serviceTokenRoutes.revoke, {sandbox: id, service: 'board', account: 'owner'})
        if (!revoked.ok) {
            verdicts.push(verdict('the operator revokes the board account "owner"', 'allowed', 'refused',
                revoked.status == 429 ? 'budget' : 'operator', revoked.status + ' ' + revoked.error))
            return
        }
        verdicts.push(verdict('the operator revokes the board account "owner"', 'allowed', 'allowed', 'operator',
            `revoked ${revoked.value.account} · ${revoked.value.sessionsCut} live session(s) cut`))

        const notice = await waitForNotice(connection, heard, 'revoked')
        const ack = notice ? await waitForDowngrade(connection) : await bounded(connection.scale.auth(), 'ack after the revoke') as tAck
        const facade = Object.keys(connection.scale.schema() ?? {})
        const cut = notice != null && ack?.ok == false
        if (cut) {
            principals.board = null
            notices.board = 'revoked: ' + String(notice.reason ?? 'no reason')
            publish()
        }
        verdicts.push(verdict('keep using the live owner session', 'refused', cut ? 'refused' : 'allowed', 'sessionCut', notice
            ? `Pkt.AUTH 'revoked' (${String(notice.reason)}) · the scale facade fell back to {${facade.join(', ')}} · ack ${ackText(ack)}`
            : 'no revocation reached the live session · ack ' + ackText(ack)))

        const renewAfter = await attempt(bounded(connection.app.func.board.identity.renew(current), 'renew after the revoke'))
        verdicts.push(renewAfter.ok
            ? verdict('renew the token after the revoke', 'refused', 'allowed', 'renew', 'RENEWED a revoked account: ' + tokenText(renewAfter.value.token, renewAfter.value.expiresAt))
            : verdict('renew the token after the revoke', 'refused', 'refused', refusalLayer(renewAfter.error, 'renew'), errorText(renewAfter.error)))

        const command = await attempt(bounded(connection.scale.func.board.commands.note(requestId('note'), {text: 'after the revoke'}), 'command after the revoke'))
        verdicts.push(command.ok
            ? verdict('run a command on the same socket', 'refused', 'allowed', 'corridor', 'the command ran: ' + JSON.stringify(command.value))
            : verdict('run a command on the same socket', 'refused', 'refused', refusalLayer(command.error, 'gate'),
                errorText(command.error) + ' — the principal was downgraded to the anonymous {}'))

        const again = await bounded(connection.scale.reauth(current), 're-present the token') as tAck
        verdicts.push(verdict('re-present the same token (scale.reauth)', 'refused', again?.ok ? 'allowed' : 'refused',
            again?.ok ? 'resolveAuth' : refusalLayer({message: again?.reason}, 'resolveAuth'),
            'ack ' + ackText(again) + (again?.ok ? '' : ' — resolveAuth threw {revoke: true}')))
    }

    // ============== the runner: one scenario at a time, partial verdicts survive a failure ==============

    const scenarioSteps = {
        handshake: handshakeScenario,
        issued: issuedScenario,
        selfIssued: selfIssuedScenario,
        revoke: revokeScenario,
    } satisfies {[K in tServiceTokenScenario]: (verdicts: ServiceTokenVerdict[]) => Promise<void>}

    async function runOnce(scenario: tServiceTokenScenario, retry: boolean): Promise<ServiceTokenReport> {
        const verdicts: ServiceTokenVerdict[] = []
        try {
            await scenarioSteps[scenario](verdicts)
            return {scenario, verdicts, ok: verdicts.length > 0 && verdicts.every(item => item.outcome == item.expected)}
        } catch (error) {
            // a swept or evicted sandbox is not a verdict: start over once in a fresh one
            if (error instanceof SandboxGone && retry && !closed) {
                forget()
                return runOnce(scenario, false)
            }
            return {scenario, verdicts, ok: false, error: errorText(error)}
        }
    }

    function run(scenario: tServiceTokenScenario) {
        if (closed) return Promise.resolve<ServiceTokenReport>({scenario, verdicts: [], ok: false, error: 'the client is closed'})
        const next = queue.then(function runServiceTokenScenario() { return runOnce(scenario, true) })
        queue = next.catch(function keepServiceTokenQueue() {})
        return next
    }

    /** One note on the current session — the oracle's probe that an untouched session still works. */
    async function note(service: tServiceTokenService, text: string): Promise<ServiceTokenVerdict> {
        const step = `${service}: add a note on the current session`
        const connection = service == 'board' ? await board() : await desk()
        const added = await attempt(bounded(service == 'board'
            ? (connection as tConnection<'board'>).scale.func.board.commands.note(requestId('note'), {text})
            : (connection as tConnection<'desk'>).scale.func.desk.commands.note(requestId('note'), {text}), step))
        if (added.ok) {
            notes[service] = added.value.notes
            publish()
        }
        return added.ok
            ? verdict(step, 'allowed', 'allowed', 'corridor', `receipt: ${added.value.notes.length} note(s)`)
            : verdict(step, 'allowed', 'refused', refusalLayer(added.error, 'corridor'), errorText(added.error))
    }

    function close() {
        if (closed) return
        forget()
        closed = true
        changes.close()
    }

    return {
        /** Commands inward: each resolves with its report, never rejects. */
        control: {run, note, reset: forget},
        /** Synchronous read of what the panel shows. */
        view: {snapshot},
        /** Outward: a fresh snapshot after every state change. */
        events: {changed: changes},
        close,
    }
}

export type ServiceTokenClient = ReturnType<typeof createServiceTokenClient>
