// =====================================================================
//  A server WITHOUT `gate` must stay callable after a refused reauth.
//
//  Production shape: an application that uses resolveAuth to attach a principal facade
//  but does NOT gate the base surface — the documented "open, as before" configuration.
//  RpcServerAuth documents `ack.ok === false` as a way to refuse a token without
//  throwing, and Rule 6 of doc/RPC-AUTH.md promises the live session keeps its principal
//  while the caller's reauth() simply resolves {ok:false}.
//
//  applyGrant wrote `authed = authAck?.ok !== false` unconditionally, so one refusal shut
//  the connection down permanently: every later CALL and PIPE answered E_UNAUTHORIZED,
//  while downgradePrincipal — the other half of the same corridor — had always read the
//  gate correctly as `!auth?.gate`. The two halves disagreed.
//
//  This test fails against that code and passes against the fix.
// =====================================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'

const PORT = 4133

function makeObject() {
    return {
        ping: () => 'pong',
        add: (a: number, b: number) => a + b,
    }
}

// 'good' attaches a principal; 'bad' refuses WITHOUT throwing — the documented ack form.
function resolveAuth(token: any) {
    if (token == 'bad') return {ack: {ok: false, reason: 'refused by policy'}}
    return {ack: {ok: true, who: String(token)}}
}

async function main() {
    const {check, done} = makeChecker('auth-ungated')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // NOTE: no `gate` — the base facade is public by design.
    const srv = await startRealServer({
        port: PORT,
        makeObject,
        serverOpts: {auth: {resolveAuth}},
    })

    const cli = await startRealClient({port: PORT, token: 'good'})
    await delay(20)

    await check('ungated: call works before any refusal', () => cli.api.ping(), 'pong')
    await check('ungated: first token accepted', async () => (await cli.client.auth())?.ok, true)

    // the refusal itself must resolve, not throw — that is the documented contract
    await check('ungated: refused reauth resolves {ok:false}', async () => {
        const ack = await cli.client.reauth('bad')
        return ack?.ok
    }, false)

    await delay(30)

    // …and the connection must still serve the base facade afterwards.
    await check('ungated: call STILL works after a refused reauth', () => cli.api.ping(), 'pong')
    await check('ungated: second call too, with arguments', () => cli.api.add(2, 3), 5)

    // a later good token must still be accepted — the session is not poisoned
    await check('ungated: a good token is accepted after the refusal', async () => {
        const ack = await cli.client.reauth('good-again')
        return ack?.ok
    }, true)
    await check('ungated: call works after recovery', () => cli.api.ping(), 'pong')

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
