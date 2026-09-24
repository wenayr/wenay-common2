// The shipped leader host's ungated 'app' key is reachable by anyone who can open a socket.
// Its identity port must never mint a token for an account the CLIENT names, and never lift a
// revocation that way; a definition with access.login keeps its credential login unchanged.
import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {createServiceLeaderHost} from '../../src/service/host'
import type {tServiceDefinition} from '../../src/service'
import {runOracle} from '../run-oracle'

type State = {roles: Record<string, string[]>, passwords: Record<string, string>, vault: string}
const initial: State = {roles: {owner: ['owner']}, passwords: {alice: 'alice-pass'}, vault: 'sealed'}
const commands = {
    drain: {allow: ['owner'], apply(ctx: {state: State}, input: {to: string}) {
        ctx.state.vault = 'drained to ' + input.to
        return ctx.state.vault
    }},
}
const rolesOf = (state: State, account: string) => state.roles[account] ?? []

// no access.login: the service mints tokens only server-side (operator, harness, own issuer)
const tokenOnly = {
    name: 'identity-token-only', storeId: 'identity-token-only', originId: 'identity-token-only',
    initial, commands, access: {rolesOf},
} satisfies tServiceDefinition<State>

// access.login: the leader is the IdP, credentials in
const credentialLogin = {
    name: 'identity-credentials', storeId: 'identity-credentials', originId: 'identity-credentials',
    initial, commands,
    access: {rolesOf, login: {input: {account: 'string', password: 'string'},
        resolve: (state: State, input: {account: string, password: string}) => state.passwords[input.account] == input.password ? input.account : null}},
} satisfies tServiceDefinition<State>

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

/** A raw participant socket with an arbitrary handshake: what any network peer can open. */
async function participant(url: string, handshake: Record<string, unknown>) {
    const hub = createRpcClientHub(
        () => io(url, {transports: ['websocket'], forceNew: true, reconnection: false, auth: handshake}),
        rpc => ({app: rpc<any>('app'), scale: rpc<any>('scale')}),
    )
    const api = await hub.setToken(null)
    await api.app.readyStrict()
    return {hub, api}
}

function outcome<T>(work: Promise<T>) {
    return work.then(value => ({ok: true as const, value}), error => ({ok: false as const, error: String((error as Error)?.message ?? error)}))
}

async function main() {
    const host = await createServiceLeaderHost({definition: tokenOnly, host: '127.0.0.1', env: {}, rest: false})
    const name = tokenOnly.name
    const opened: {hub: {close: () => void}}[] = []
    try {
        await check('the ungated identity refuses to mint a token for a client-named account', async function namedAccount() {
            const peer = await participant(host.url, {account: 'owner'})
            opened.push(peer)
            const minted = await outcome(peer.api.app.func[name].identity.login())
            assert.equal(minted.ok, false, 'minted a token for the handshake account: ' + JSON.stringify(minted))
        })

        await check('a client-named account cannot run an owner-only command', async function ownerCommand() {
            const peer = await participant(host.url, {account: 'owner'})
            opened.push(peer)
            const minted = await outcome(peer.api.app.func[name].identity.login() as Promise<{token: string}>)
            if (minted.ok) {
                await peer.hub.reauth(minted.value.token)
                await outcome(peer.api.scale.func[name].commands.drain('forged-1', {to: 'attacker'}))
            }
            assert.equal(host.leader.view.state().vault, 'sealed')
        })

        await check('an anonymous login cannot lift the operator\'s revocation', async function revocation() {
            host.leader.control.revoke('owner')
            assert.equal(host.leader.view.isRevoked('owner'), true)
            const peer = await participant(host.url, {account: 'owner'})
            opened.push(peer)
            await outcome(peer.api.app.func[name].identity.login())
            assert.equal(host.leader.view.isRevoked('owner'), true, 'the revocation was lifted by a client-named login')
        })

        await check('renew still works for a live, server-issued token and refuses a revoked one', async function renewal() {
            const peer = await participant(host.url, {})
            opened.push(peer)
            const issued = host.leader.identity.login('member').token
            const renewed = await peer.api.app.func[name].identity.renew(issued) as {token: string, account: string}
            assert.equal(renewed.account, 'member')
            assert.equal(host.leader.identity.principal(renewed.token).account, 'member')
            const revokedToken = host.leader.identity.mint('owner').token
            host.leader.control.revoke('owner')
            const refused = await outcome(peer.api.app.func[name].identity.renew(revokedToken))
            assert.equal(refused.ok, false)
            assert.equal(host.leader.view.isRevoked('owner'), true)
        })
    } finally {
        for (const peer of opened) peer.hub.close()
        await host.close()
    }

    const withLogin = await createServiceLeaderHost({definition: credentialLogin, host: '127.0.0.1', env: {}, rest: false})
    const loginName = credentialLogin.name
    const peers: {hub: {close: () => void}}[] = []
    try {
        await check('access.login is unchanged: credentials mint, the handshake account is ignored, system and bad passwords are refused', async function credentials() {
            const peer = await participant(withLogin.url, {account: 'owner'})
            peers.push(peer)
            const identity = peer.api.app.func[loginName].identity
            const minted = await identity.login({account: 'alice', password: 'alice-pass'}) as {token: string, account: string}
            assert.equal(minted.account, 'alice')
            assert.equal(withLogin.leader.identity.principal(minted.token).account, 'alice')
            assert.equal((await outcome(identity.login({account: 'alice', password: 'wrong'}))).ok, false)
            assert.equal((await outcome(identity.login({account: 'system', password: ''}))).ok, false)
            assert.equal((await outcome(identity.login())).ok, false, 'a login without credentials must not mint')
            const renewed = await identity.renew(minted.token) as {account: string}
            assert.equal(renewed.account, 'alice')
        })
    } finally {
        for (const peer of peers) peer.hub.close()
        await withLogin.close()
    }
    if (failed) process.exitCode = 1
    else console.log('PASS service leader identity: no client-named mint, no anonymous unrevoke, renew and credential login intact')
}

runOracle(main)
