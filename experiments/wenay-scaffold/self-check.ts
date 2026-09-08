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

import {spawn} from 'node:child_process'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {io as ioClient} from 'socket.io-client'
import {followNodeDirectory} from '../../src/Common/Observe/node-directory'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../../src/Common/rcp/rpc-protocol'
import {createTokenCodec} from '../../src/server/auth-token'
import {buildInputValidate, inputJsonSchema} from './template/input-schema'
import {createStripeProvider, fakeBankWebhook, signSettlement, signStripeEvent, stripeWebhook, toMinorUnits, verifyStripeSignature} from './template/payments'
import {createServiceLeader, SYSTEM_ACCOUNT} from './template/leader'
import {createMemoryReplayStorage} from '../../src/Common/events/replay-history'
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

const quiet = () => {}

function throwsMessage(run: () => void, expected: string) {
    try { run() } catch (error) { return (error as Error)?.message == expected }
    return false
}

async function main() {
    // still the literal '{{name}}' pre-instantiation — a plain string wire key
    const name = serviceDefinition.name

    // ============== the input-schema DSL: the primitive before the layers above ==============
    {
        const validate = buildInputValidate({
            itemId: 'string',
            from: 'date-string',
            days: 'number?',
            kind: {enum: ['standard', 'premium']},
            tags: {array: 'string', optional: true},
            contact: {object: {email: 'string'}, optional: true},
        })
        let accepted = true
        try {
            validate({itemId: 'kayak', from: '2026-09-01', kind: 'standard'})
            validate({itemId: 'kayak', from: '2026-09-01', days: 3, kind: 'premium', tags: ['a'], contact: {email: 'a@b.c'}})
        } catch { accepted = false }
        ok(accepted, 'the DSL validator accepts schema-shaped input, optional fields present or absent')
        ok(throwsMessage(() => validate({from: '2026-09-01', kind: 'standard'}), 'input.itemId is required')
            && throwsMessage(() => validate({itemId: 'kayak', from: 'tomorrow', kind: 'standard'}), 'input.from must be an ISO day (YYYY-MM-DD)')
            && throwsMessage(() => validate({itemId: 'kayak', from: '2026-09-01', days: '3', kind: 'standard'}), 'input.days must be a finite number')
            && throwsMessage(() => validate({itemId: 'kayak', from: '2026-09-01', kind: 'luxury'}), 'input.kind must be one of: standard, premium')
            && throwsMessage(() => validate({itemId: 'kayak', from: '2026-09-01', kind: 'standard', tags: ['a', 2]}), 'input.tags[1] must be a string')
            && throwsMessage(() => validate({itemId: 'kayak', from: '2026-09-01', kind: 'standard', contact: {email: 7}}), 'input.contact.email must be a string')
            && throwsMessage(() => validate({itemId: 'kayak', from: '2026-09-01', kind: 'standard', sneaky: 1}), 'input.sneaky is not a known field')
            && throwsMessage(() => validate('kayak'), 'input must be an object'),
            'every refusal names its exact field path and rule')
        const json = inputJsonSchema({
            itemId: 'string',
            from: 'date-string',
            days: 'number?',
            kind: {enum: ['standard', 'premium']},
            tags: {array: 'string', optional: true},
        }) as any
        ok(json.type == 'object' && json.additionalProperties == false
            && JSON.stringify(json.required) == '["itemId","from","kind"]'
            && json.properties.from.format == 'date'
            && JSON.stringify(json.properties.kind.enum) == '["standard","premium"]'
            && json.properties.tags.items.type == 'string'
            && json.properties.days.type == 'number',
            'inputJsonSchema mirrors the same value: required excludes optional, formats and enums carried')
    }

    // ============== the payments primitives: codecs and the Stripe-shaped adapter, offline ==============
    {
        const bank = fakeBankWebhook('bank-secret')
        const body = JSON.stringify({eventId: 'evt_1', paymentId: 'pay_1', ref: 'ch_1', status: 'confirmed'})
        const headers = (signature: string | undefined) => (name: string) => name == 'x-bank-signature' ? signature : undefined
        ok(bank.verify(body, headers(signSettlement('bank-secret', body))) && !bank.verify(body, headers(signSettlement('other', body))) && !bank.verify(body, headers(undefined)),
            'the fake bank codec verifies its HMAC and refuses another secret or no header')
        ok(bank.parse(body)?.[0]?.status == 'confirmed' && throwsMessage(() => bank.parse(JSON.stringify({eventId: 'x'})), 'malformed settlement'),
            'the fake bank codec parses one settlement and refuses a malformed body')

        const stripe = stripeWebhook('whsec_test', {now: () => 1_700_000_000_000})
        const event = JSON.stringify({id: 'evt_s1', type: 'payment_intent.succeeded', data: {object: {id: 'pi_1', metadata: {paymentId: 'pay_9'}}}})
        const signed = signStripeEvent(event, 'whsec_test', 1_700_000_000)
        const stripeHeaders = (signature: string | undefined) => (name: string) => name == 'stripe-signature' ? signature : undefined
        ok(stripe.verify(event, stripeHeaders(signed)) && !stripe.verify(event, stripeHeaders(signStripeEvent(event, 'whsec_other', 1_700_000_000))),
            'the Stripe codec verifies t=…,v1=… over `${t}.${body}` and refuses a foreign secret')
        ok(!verifyStripeSignature(signStripeEvent(event, 'whsec_test', 1_700_000_000 - 301), event, 'whsec_test', {now: () => 1_700_000_000_000})
            && verifyStripeSignature(signStripeEvent(event, 'whsec_test', 1_700_000_000 - 299), event, 'whsec_test', {now: () => 1_700_000_000_000}),
            'a signature older than the tolerance is refused, a fresh one accepted')
        const failed = JSON.stringify({id: 'evt_s2', type: 'payment_intent.payment_failed', data: {object: {id: 'pi_2', metadata: {paymentId: 'pay_8'}, last_payment_error: {message: 'card declined'}}}})
        const other = JSON.stringify({id: 'evt_s3', type: 'charge.refunded', data: {object: {id: 'ch_3', metadata: {paymentId: 'pay_7'}}}})
        ok(stripe.parse(event)?.[0]?.status == 'confirmed' && stripe.parse(event)?.[0]?.ref == 'pi_1' && stripe.parse(event)?.[0]?.eventId == 'evt_s1'
            && stripe.parse(failed)?.[0]?.status == 'failed' && stripe.parse(failed)?.[0]?.error == 'card declined' && stripe.parse(other) == null,
            'the Stripe codec maps the two PaymentIntent outcomes and ignores other event types')

        const calls: {url: string, init: RequestInit}[] = []
        const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({url: String(url), init: init ?? {}})
            const params = new URLSearchParams(String(init?.body))
            if (params.get('amount') == '999999') return new Response(JSON.stringify({error: {message: 'insufficient funds'}}), {status: 402})
            return new Response(JSON.stringify({id: 'pi_' + params.get('metadata[paymentId]')}), {status: 200})
        }) as typeof fetch
        const {provider} = createStripeProvider({secretKey: 'sk_test_x', webhookSecret: 'whsec_test', fetch: fakeFetch})
        const charged = await provider.charge({paymentId: 'pay_42', amount: 12.5, currency: 'EUR', description: 'booking bk-1', hints: {paymentMethod: 'pm_1'}})
        const sent = new URLSearchParams(String(calls[0]?.init.body))
        const sentHeaders = calls[0]?.init.headers as Record<string, string>
        ok(charged.ref == 'pi_pay_42' && calls[0]?.url == 'https://api.stripe.com/v1/payment_intents'
            && sent.get('amount') == '1250' && sent.get('currency') == 'eur' && sent.get('confirm') == 'true' && sent.get('metadata[paymentId]') == 'pay_42' && sent.get('payment_method') == 'pm_1'
            && sentHeaders['idempotency-key'] == 'pay_42' && sentHeaders['authorization'] == 'Bearer sk_test_x',
            'the Stripe adapter posts a confirmed PaymentIntent in minor units under the payment id as Idempotency-Key')
        ok(toMinorUnits(12.5, 'EUR') == 1250 && toMinorUnits(1200, 'JPY') == 1200, 'minor units respect zero-decimal currencies')
        const declined = await provider.charge({paymentId: 'pay_43', amount: 9999.99, currency: 'EUR'}).then(() => 'charged', (error: Error) => error.message)
        ok(declined == 'stripe: insufficient funds', `a provider error surfaces with its message (${declined})`)
    }

    // ============== limits are data: per command, per account, and the host's own principal is exempt ==============
    {
        const limited = {
            ...serviceDefinition,
            limits: {perMinute: 3},
            commands: {
                ...serviceDefinition.commands,
                add: {...serviceDefinition.commands.add, limit: {perMinute: 2}},
            },
        }
        const host = createServiceLeader({definition: limited, selfUrl: () => 'mem://limits', log: quiet})
        host.control.start()
        const call = (account: string, id: string) => host.corridor.execute(account, 'add', id, {delta: 1}).then(() => 'ok', (error: Error) => error.message)
        ok(await call('u', 'a') == 'ok' && await call('u', 'b') == 'ok' && /rate limit: add allows 2/.test(await call('u', 'c')),
            'a command-level limit refuses the third call of one account within the minute')
        ok(await call('v', 'a') == 'ok', 'the command window is per account')
        let systemOk = true
        for (let i = 0; i < 70 && systemOk; i++) systemOk = await call(SYSTEM_ACCOUNT, 's' + i) == 'ok'
        ok(systemOk, 'the system principal is exempt from both the corridor budget and the command limit (70 calls)')
        host.control.close()
    }

    // ============== the archive's schema version: migrate once, refuse a silent mismatch ==============
    {
        const storage = createMemoryReplayStorage()
        const v1 = createServiceLeader({definition: serviceDefinition, selfUrl: () => 'mem://v1', durable: {storage, everyEvents: 1}, log: quiet})
        v1.control.start()
        await v1.corridor.execute('author', 'add', 'm1', {delta: 5})
        ok((v1.view.state() as any).$version == 1 && v1.view.state().counter?.value == 5, 'a fresh durable leader stamps schema version 1 into the state')
        v1.control.close()
        const v2 = createServiceLeader({
            definition: {
                ...serviceDefinition,
                version: 2,
                migrate: (state: any) => ({counter: {id: 'counter', value: state.counter.value * 100, ts: state.counter.ts}}),
            },
            selfUrl: () => 'mem://v2', durable: {storage, everyEvents: 1}, log: quiet,
        })
        v2.control.start()
        ok(v2.view.restored()?.fromArchive == true && v2.view.state().counter?.value == 500 && (v2.view.state() as any).$version == 2,
            'a newer definition migrates the restored archive once and stamps its version')
        v2.control.close()
        const v3 = createServiceLeader({definition: {...serviceDefinition, version: 2}, selfUrl: () => 'mem://v3', durable: {storage, everyEvents: 1}, log: quiet})
        ok((v3.view.state() as any).$version == 2 && v3.view.state().counter?.value == 500, 'the migrated archive restores at its version without migrating again')
        v3.control.close()
        let refused = ''
        try { createServiceLeader({definition: {...serviceDefinition, version: 3}, selfUrl: () => 'mem://v4', durable: {storage, everyEvents: 1}, log: quiet}) }
        catch (error) { refused = (error as Error).message }
        ok(/schema version 2, the definition at 3, and no migrate/.test(refused), `a version bump without migrate() refuses to boot over an older archive (${refused.slice(0, 60)}…)`)
    }

    // ============== leader from the template factory ==============
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => 'mem://leader', log: quiet})
    leader.control.start()
    const link = leader.serve.nodeLinkFragment()
    const roster = followNodeDirectory(link.control)
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
            control: link.control,
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
    await waitFor('the node registers itself in the roster', () => row('node-1')?.role == 'mirror' && row('node-1')?.url == 'mem://node-1')

    // ============== identity: a real codec token from the leader's ungated port ==============
    const minted = leader.serve.browserFragment('author').identity.login()
    ok(minted.account == 'author' && codec.verify(minted.token).ok == true,
        'login mints a codec token the node secret verifies')

    // ============== a client over REAL RPC to the node ==============
    const {client: clientEnd, server: serverEnd} = createLoopbackSocketPair()
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

    // schema first, domain second: the old coercing validate accepted '5';
    // the declared schema refuses it by NAME, and validate() still guards after
    const schemaRefusal = await write.func[name].commands.add('r2b', {delta: '5'})
        .then(() => '', (error: any) => String(error?.message ?? error))
    ok(schemaRefusal == 'input.delta must be a finite number' && leader.view.state().counter?.value == 5,
        'the input SCHEMA refuses a coercible non-number with its precise field message')
    const domainRefusal = await write.func[name].commands.add('r2c', {delta: 2000})
        .then(() => '', (error: any) => String(error?.message ?? error))
    ok(domainRefusal == 'delta must be within ±1000' && leader.view.state().counter?.value == 5,
        'validate() still runs AFTER the schema for the domain rule')
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
        ok(names.length == 14 && names.includes('README.md') && names.includes('access.ts') && names.includes('rest.ts') && names.includes('panel.ts') && names.includes('effects.ts') && names.includes('payments.ts') && names.includes('client.ts') && leftovers == 0 && substituted,
            `create.mjs instantiates all 14 template files with {{name}} substituted (${names.length})`)
    } finally {
        await rm(targetDir, {recursive: true, force: true})
    }

    // ============== day 1: the leader entrypoint is a whole deployment by itself ==============
    // the template's leader.ts main() as a REAL process: env in, port bound, the ungated 'app'
    // surface answering over a real Socket.IO connection — with zero nodes (ROADMAP §6.1)
    {
        const tsx = path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
        const child = spawn(process.execPath, [tsx, path.join(__dirname, 'template', 'leader.ts')], {
            env: {...process.env, SERVICE_PORT: '0'},
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        const url = await new Promise<string>(function awaitListening(resolve, reject) {
            const timer = setTimeout(function bootTimedOut() { reject(new Error('leader.ts did not bind within 15s:\n' + output)) }, 15_000)
            function scan(chunk: unknown) {
                output += String(chunk)
                const bound = /leader listening on (http:\/\/localhost:\d+)/.exec(output)
                if (bound) { clearTimeout(timer); resolve(bound[1]) }
            }
            child.stdout.on('data', scan)
            child.stderr.on('data', scan)
            child.once('exit', function exitedEarly(code) { clearTimeout(timer); reject(new Error(`leader.ts exited early (${code}):\n` + output)) })
        }).catch(function bootFailed(error: Error) { ok(false, error.message); return '' })
        if (url) {
            ok(true, `leader.ts boots as a process and binds a port (${url})`)
            const socket = ioClient(url, {transports: ['websocket'], auth: {account: 'day-one'}})
            const read = createRpcClient<any>({socket: socket as any, socketKey: 'app'})
            const view = await read.readyStrict().then(() => read.func[name].view()).catch((error: any) => ({error: String(error?.message ?? error)}))
            ok(JSON.stringify(view) == '{"counter":0}', `the process serves the read view over a real socket with zero nodes (${JSON.stringify(view)})`)
            // the roster projection, read the way a cluster client reads it
            const wireRoster = followNodeDirectory(read.func[name].roster)
            await wireRoster.ready
            const rows = wireRoster.nodes().map(view => view.nodeId)
            ok(rows.length == 1 && rows[0] == 'leader', `the roster projection on the wire holds only the leader row (${rows.join(',')})`)
            wireRoster.close()
            socket.close()
            child.kill()
            await new Promise<void>(resolve => child.once('exit', () => resolve()))
        }
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
