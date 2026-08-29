// ============================================================
//  replay/command-token.test.ts
//
//  Command token envelope (end-to-end trust mode): the relay copies the END
//  client's token opaquely, ONLY the authority resolves it to an account, a
//  rejected verification commits nothing, and the token hop shares ONE receipt
//  space with direct execution on the authority. Verification is exercised with
//  the real createTokenCodec (signature + expiry) plus an application deny list.
//  Run: npx tsx replay/command-token.test.ts
// ============================================================

import {createCommandHost} from '../src/Common/command/command-host'
import {forwardCommandsByToken, verifyCommands} from '../src/Common/command/command-token'
import {createTokenCodec} from '../src/server/auth-token'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function rejects(run: () => Promise<unknown>, match: string) {
    try { await run() } catch (error) { return String((error as any)?.message ?? error).includes(match) }
    return false
}

async function main() {
    let clock = 1_000_000
    const codec = createTokenCodec({secret: 'oracle-secret', ttlMs: 60_000, now: () => clock})
    const revoked = new Set<string>()
    let applied = 0
    const host = createCommandHost({
        now: () => clock,
        commands: {
            add(ctx, input: {delta: number}) {
                applied += input.delta
                return {value: applied, by: ctx.account}
            },
        },
    })

    // ============== authority: verify EVERY call, never trust the relay ==============
    const seenTokens: unknown[] = []
    const authority = verifyCommands({
        host,
        accountOf(token) {
            seenTokens.push(token)
            const verdict = codec.verify(token)
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            if (revoked.has(verdict.claims.sub)) throw new Error('account revoked')
            return verdict.claims.sub
        },
    })
    ok(authority.names.length == 1 && authority.names[0] == 'add', 'verifyCommands relays the host names')

    // ============== relay: shape-identical fragment, identity never asserted ==============
    const relay = forwardCommandsByToken({upstream: authority.fragment(), names: authority.names})
    const tokenA = codec.issue({sub: 'person-a'})
    const viaRelay = relay.fragment(tokenA)

    const first = await viaRelay.add('r1', {delta: 10})
    ok(first.value == 10 && first.by == 'person-a' && applied == 10,
        'a relayed call executes as the VERIFIED sub, not anything the relay says')
    ok(seenTokens[seenTokens.length - 1] === tokenA, 'the relay hands the authority the exact token, opaquely')

    const dupRelay = await viaRelay.add('r1', {delta: 999})
    ok(dupRelay.value == 10 && applied == 10, 'a duplicate through the relay answers the receipt')
    const dupDirect = await host.execute('person-a', 'add', 'r1', {delta: 999})
    ok(dupDirect.value == 10 && applied == 10,
        'the token hop and direct execution share ONE receipt space (cross-node retry is safe)')

    // ============== rejected verification commits nothing ==============
    ok(await rejects(() => relay.fragment('garbage').add('r2', {delta: 5}), 'malformed'),
        'a malformed token is rejected at the authority')
    ok(await rejects(() => relay.fragment(null).add('r2', {delta: 5}), 'malformed'),
        'a missing token is rejected the same way')
    const afterGarbage = await viaRelay.add('r2', {delta: 5})
    ok(afterGarbage.value == 15 && applied == 15,
        'the rejected attempt left NO receipt — the same requestId retries honestly with a valid token')

    // ============== expiry: the codec clock is the judge, not the relay ==============
    clock += 61_000
    ok(await rejects(() => viaRelay.add('r3', {delta: 5}), 'expired'),
        'an expired token is rejected even on a live relay fragment')
    const tokenA2 = codec.issue({sub: 'person-a'})
    const renewed = await relay.fragment(tokenA2).add('r3', {delta: 5})
    ok(renewed.value == 20 && applied == 20, 'a renewed token resumes, receipts still by the same sub')
    const dupAcrossTokens = await relay.fragment(tokenA2).add('r1', {delta: 999})
    ok(dupAcrossTokens.value == 10 && applied == 20,
        'receipts key on the VERIFIED account: a fresh token still answers the old receipt')

    // ============== revocation: a deny-listed sub dies at the authority ==============
    revoked.add('person-a')
    ok(await rejects(() => relay.fragment(tokenA2).add('r4', {delta: 5}), 'revoked'),
        'a revoked account is refused even though its token still verifies')
    const tokenB = codec.issue({sub: 'person-b'})
    const other = await relay.fragment(tokenB).add('r1', {delta: 7})
    ok(other.value == 27 && other.by == 'person-b' && applied == 27,
        'another sub with the SAME requestId is a different command (accounts stay separate)')

    host.close()
    console.log(fails == 0 ? '\nALL GREEN' : `\n${fails} FAILURES`)
    if (fails) process.exitCode = 1
}
void main()
