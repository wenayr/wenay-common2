// ============================================================
//  experiments/wenay-scaffold/examples/rental/self-check.ts
//
//  The final-stand proof as an oracle: the leader boots IN-PROCESS with a
//  REAL http server on an ephemeral port (the same ./rest surface the live
//  stand mounts), one node links in-process through the 7a loopback pattern,
//  and every client-facing claim is checked over the wire it really rides:
//  REST envelopes over real HTTP for the documented routes, real RPC legs
//  for the node corridor, and a live follower subscription for replication.
//  Run: node node_modules/tsx/dist/cli.mjs experiments/wenay-scaffold/examples/rental/self-check.ts
// ============================================================

import {spawnSync} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import express from 'express'
import {createServer} from 'http'
import {createStoreFollower} from '../../../../src/Common/Observe/store-follower'
import {followNodeDirectory} from '../../../../src/Common/Observe/node-directory'
import {createRpcClient} from '../../../../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../../../../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../../../../src/Common/rcp/rpc-protocol'
import {createTokenCodec} from '../../../../src/server/auth-token'
import {createServiceLeader} from '../../template/leader'
import {createServiceNode} from '../../template/node'
import {createRentalRest} from './rest'
import {serviceDefinition, type RentalState} from './service'

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

async function main() {
    const name = serviceDefinition.name

    // ============== leader in-process + the REAL http REST surface ==============
    let base = ''
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => base, log: quiet})
    const app = express()
    createRentalRest({
        app,
        board: leader.view.reader,
        // the corridor facet is the honest address for the token hop (the node
        // link below still retransmits the same fragment to the node)
        corridor: leader.corridor.byToken(),
    })
    const httpServer = createServer(app)
    const port = await new Promise<number>(function listenEphemeral(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, function bound() { resolve((httpServer.address() as any).port) })
    })
    base = 'http://localhost:' + port
    leader.control.start()

    async function httpGet(pathname: string) {
        const answer = await fetch(base + pathname)
        return {status: answer.status, body: await answer.json() as any}
    }
    async function httpPost(pathname: string, args: unknown[], bearer?: string) {
        const answer = await fetch(base + pathname, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(bearer ? {authorization: 'Bearer ' + bearer} : {}),
            },
            body: JSON.stringify({args}),
        })
        return {status: answer.status, body: await answer.json() as any}
    }
    const bookings = () => leader.view.state().bookings
    const bookingCount = () => Object.keys(bookings()).length

    // ============== node from the template factory, linked in-process (7a pattern) ==============
    const link = leader.serve.nodeLinkFragment()
    const roster = followNodeDirectory(link.directory, {staleMs: 0})
    await roster.ready
    const row = (nodeId: string) => roster.nodes().find(view => view.nodeId == nodeId)

    const codec = createTokenCodec({secret: leader.secrets.tokenSecret})
    let connect: ((socket: SocketTmpl) => void) | null = null
    let leftReason: string | null = null
    const node = createServiceNode<RentalState>({
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
            directory: link.directory,
            revoked: link.revoked,
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
    ok(row('leader')?.role == 'leader' && row('node-1')?.role == 'mirror',
        'the leader serves REST on a real port and the node registers in the directory')

    const minted = leader.serve.browserFragment('renter').identity.login()
    ok(minted.account == 'renter' && codec.verify(minted.token).ok == true,
        'login mints a codec token the shared secret verifies')

    // ============== the documented REST surface over REAL HTTP ==============
    const board0 = await httpGet('/api/rental/board')
    ok(board0.status == 200 && board0.body.ok == true
        && board0.body.value.items.length == 3 && board0.body.value.bookings.length == 0,
        'GET /api/rental/board answers 3 seeded items and 0 bookings')

    const noBearer = await httpPost('/api/rental/book', ['r0', {itemId: 'kayak', from: '2026-09-01', to: '2026-09-03'}])
    ok(noBearer.status == 401 && noBearer.body.ok == false,
        'POST without a bearer is refused before the corridor (401)')

    const first = await httpPost('/api/rental/book',
        ['r1', {itemId: 'kayak', from: '2026-09-01', to: '2026-09-03'}], minted.token)
    const receipt = first.body?.value
    ok(first.status == 200 && first.body.ok == true
        && receipt?.id == 'bk-r1' && receipt?.state == 'active' && receipt?.account == 'renter',
        'POST book with the bearer books as the VERIFIED account — 200 receipt')

    // ============== replication proof: a live follower through the node ==============
    const {client: clientEnd, server: serverEnd} = createLoopbackSocketPair()
    connect!(serverEnd)
    const read = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
    await read.readyStrict()
    const follower = createStoreFollower<RentalState>({remote: (read.func[name].replica as any).replay})
    await follower.ready
    await waitFor('the booking appears in a LIVE follower subscription through the node',
        () => follower.store.state.bookings?.['bk-r1']?.state == 'active')

    // ============== receipts: one execution per (account, requestId) ==============
    const dup = await httpPost('/api/rental/book',
        ['r1', {itemId: 'kayak', from: '2026-10-01', to: '2026-10-05'}], minted.token)
    ok(dup.status == 200 && dup.body.value?.id == 'bk-r1'
        && dup.body.value?.from == '2026-09-01' && bookingCount() == 1,
        'the same requestId answers the receipt — the booking is NOT doubled')

    // ============== validation: a refusal commits nothing ==============
    const clash = await httpPost('/api/rental/book',
        ['r2', {itemId: 'kayak', from: '2026-09-02', to: '2026-09-04'}], minted.token)
    ok(clash.body.ok == false && /already booked/.test(clash.body.error?.message ?? '')
        && bookingCount() == 1,
        'an overlapping book is refused and commits nothing')
    const retried = await httpPost('/api/rental/book',
        ['r2', {itemId: 'kayak', from: '2026-09-05', to: '2026-09-07'}], minted.token)
    ok(retried.status == 200 && retried.body.value?.id == 'bk-r2' && bookingCount() == 2,
        'the refused requestId left NO receipt — the same id retries honestly')

    // ============== ownership: the account is the token principal ==============
    const stranger = leader.serve.browserFragment('stranger').identity.login()
    const stolen = await httpPost('/api/rental/cancel', ['s1', {bookingId: 'bk-r2'}], stranger.token)
    ok(stolen.body.ok == false && /owner/.test(stolen.body.error?.message ?? '')
        && bookings()['bk-r2']?.state == 'active',
        'a stranger bearer cannot cancel someone else\'s booking')

    const cancelled = await httpPost('/api/rental/cancel', ['r3', {bookingId: 'bk-r1'}], minted.token)
    const board1 = await httpGet('/api/rental/board')
    ok(cancelled.status == 200 && cancelled.body.value?.state == 'cancelled'
        && board1.body.value.bookings.length == 1 && board1.body.value.bookings[0].id == 'bk-r2',
        'cancel works for the owner and the board shows the booking gone')

    // ============== the spec serves what the server registered ==============
    const spec = await httpGet('/openapi.json')
    const paths = spec.body?.paths ?? {}
    ok(paths['/api/rental/board']?.get != null
        && paths['/api/rental/book']?.post != null
        && paths['/api/rental/cancel']?.post != null
        && paths['/api/rental/board'].get.security == undefined
        && Array.isArray(paths['/api/rental/book'].post.security),
        '/openapi.json documents the rental routes — board public, writes behind the bearer')

    // the definition's input schemas ARE the documented bodies: real field types
    // as a [requestId, input] prefixItems tuple, not positional unknowns
    function bodyTuple(route: string) {
        return paths[route]?.post?.requestBody?.content?.['application/json']?.schema?.oneOf
            ?.find((variant: any) => variant.type == 'object')?.properties?.args
    }
    const bookTuple = bodyTuple('/api/rental/book')
    ok(spec.body?.openapi == '3.1.0'
        && bookTuple?.prefixItems?.length == 2
        && bookTuple.prefixItems[0]?.title == 'requestId'
        && bookTuple.prefixItems[1]?.properties?.itemId?.type == 'string'
        && bookTuple.prefixItems[1]?.properties?.from?.format == 'date'
        && bookTuple.prefixItems[1]?.required?.join(',') == 'itemId,from,to'
        && bookTuple.prefixItems[1]?.additionalProperties == false
        && bookTuple.items === false,
        'the 3.1.0 document types book args as [requestId, {itemId, from, to}] from the definition schema')
    const cancelTuple = bodyTuple('/api/rental/cancel')
    ok(cancelTuple?.prefixItems?.[1]?.properties?.bookingId?.type == 'string'
        && cancelTuple.prefixItems[1]?.required?.join(',') == 'bookingId',
        'cancel args document the real {bookingId} input the same way')

    // ============== cross-node receipts survive a drain ==============
    const write = createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token: minted.token})
    await write.readyStrict()
    const viaNode = await write.func[name].commands.book('r-drain', {itemId: 'tent', from: '2026-09-01', to: '2026-09-05'})
    ok(viaNode?.id == 'bk-r-drain' && bookingCount() == 3,
        'a book through the NODE corridor lands in the leader store')

    leader.control.drain('node-1')
    await waitFor('drain makes the node leave cleanly through onLeave',
        () => leftReason == 'drained by the authority')
    await waitFor('the goodbye removed the node row', () => row('node-1') == undefined)

    const replayed = await httpPost('/api/rental/book',
        ['r-drain', {itemId: 'tent', from: '2026-09-01', to: '2026-09-05'}], minted.token)
    ok(replayed.status == 200 && replayed.body.value?.id == 'bk-r-drain' && bookingCount() == 3,
        'the SAME requestId at the leader answers the receipt after the node\'s death — one booking')

    // ============== the SCHEMA guards the corridor before the domain sees input ==============
    const wrongType = await httpPost('/api/rental/book',
        ['r-schema', {itemId: 42, from: '2026-11-01', to: '2026-11-03'}], minted.token)
    ok(wrongType.body.ok == false && wrongType.body.error?.message == 'input.itemId must be a string'
        && bookingCount() == 3,
        'a wrong-typed field is refused by the SCHEMA with its exact path — and commits nothing')
    const missingField = await httpPost('/api/rental/book',
        ['r-schema', {itemId: 'tent', from: '2026-11-01'}], minted.token)
    ok(missingField.body.ok == false && missingField.body.error?.message == 'input.to is required'
        && bookingCount() == 3,
        'a missing required field is refused by name')
    const undeclared = await httpPost('/api/rental/book',
        ['r-schema', {itemId: 'tent', from: '2026-11-01', to: '2026-11-03', account: 'evil'}], minted.token)
    ok(undeclared.body.ok == false && undeclared.body.error?.message == 'input.account is not a known field'
        && bookingCount() == 3,
        'an undeclared field is refused — additionalProperties: false is enforced, not just documented')
    const schemaRetried = await httpPost('/api/rental/book',
        ['r-schema', {itemId: 'tent', from: '2026-11-01', to: '2026-11-03'}], minted.token)
    ok(schemaRetried.status == 200 && schemaRetried.body.value?.id == 'bk-r-schema' && bookingCount() == 4,
        'schema refusals left NO receipt — the same requestId then passes to the domain and books')

    // ============== third-party consumer: the emitted .d.ts carries the REAL fields ==============
    // openapi-typescript (the standard OpenAPI->TS generator) consumes the
    // SERVED document; the named command fields must survive into its output.
    {
        const served = await httpGet('/openapi.json')
        const specDir = await mkdtemp(path.join(tmpdir(), 'rental-openapi-'))
        try {
            const specPath = path.join(specDir, 'openapi.json')
            await writeFile(specPath, JSON.stringify(served.body), 'utf8')
            // Windows: npx is a .cmd, runnable only through a shell — and the
            // shell wants ONE command string (DEP0190 refuses args + shell)
            const typegen = process.platform == 'win32'
                ? spawnSync(`npx --yes openapi-typescript ${JSON.stringify(specPath)}`,
                    {encoding: 'utf8', shell: true, timeout: 180_000})
                : spawnSync('npx', ['--yes', 'openapi-typescript', specPath],
                    {encoding: 'utf8', timeout: 180_000})
            const emitted = typegen.stdout ?? ''
            ok(typegen.status == 0
                && /itemId: string/.test(emitted)
                && /from: string/.test(emitted)
                && /to: string/.test(emitted)
                && /bookingId: string/.test(emitted)
                && /args: \[/.test(emitted),
                'openapi-typescript emits the named input fields as a typed args tuple')
        } finally {
            await rm(specDir, {recursive: true, force: true})
        }
    }

    follower.close()
    node.close()
    roster.close()
    leader.control.close()
    httpServer.close()
    console.log(fails == 0 ? '\nrental self-check: ALL GREEN' : `\nrental self-check: ${fails} FAILURES`)
    setTimeout(function exitNow() { process.exit(fails ? 1 : 0) }, 100)
}
main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
