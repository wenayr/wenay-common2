// ============================================================
//  experiments/wenay-scaffold/examples/pizzeria/self-check.ts
//
//  The multi-level-access stand as an oracle: the leader boots IN-PROCESS
//  with the template's REST surface on a REAL http port, one node links
//  in-process (loopback RPC), and every audience claim is checked over the
//  wire it really rides. Roles come from state, credentials mint real codec
//  tokens, every facade is pruned by role AND the authority refuses the role
//  again at execution, view lines carry exactly their projection (secrets and
//  contacts never ride a line that hides them), and the generic panel, docs
//  and OpenAPI answer over HTTP.
//  Run: node node_modules/tsx/dist/cli.mjs experiments/wenay-scaffold/examples/pizzeria/self-check.ts
// ============================================================

import express from 'express'
import {createServer} from 'http'
import {createStoreFollower} from '../../../../src/Common/Observe/store-follower'
import {followNodeDirectory} from '../../../../src/Common/Observe/node-directory'
import {createRpcClient} from '../../../../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../../../../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../../../../src/Common/rcp/rpc-protocol'
import {createTokenCodec} from '../../../../src/server/auth-token'
import {createServiceLeader, SYSTEM_ACCOUNT} from '../../template/leader'
import {createServiceNode} from '../../template/node'
import {createServiceRest} from '../../template/rest'
import {DEMO_LOGINS, serviceDefinition, type PizzeriaState} from './service'

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
const hasKey = (value: unknown, key: string): boolean => {
    if (value == null || typeof value != 'object') return false
    if (Object.hasOwn(value, key)) return true
    return Object.values(value as Record<string, unknown>).some(inner => hasKey(inner, key))
}

async function main() {
    const watchdog = setTimeout(function timedOut() { console.error('pizzeria self-check timed out'); process.exit(3) }, 90_000)
    const name = serviceDefinition.name

    // ============== the leader in-process + the template REST surface on a real port ==============
    let base = ''
    const leader = createServiceLeader({definition: serviceDefinition, selfUrl: () => base, log: quiet})
    const app = express()
    createServiceRest({app, leader, definition: serviceDefinition, info: {version: '0.1.0'}})
    const httpServer = createServer(app)
    const port = await new Promise<number>(function listenEphemeral(resolve, reject) {
        httpServer.once('error', reject)
        httpServer.listen(0, function bound() { resolve((httpServer.address() as any).port) })
    })
    base = 'http://localhost:' + port
    leader.control.start()

    async function get(pathname: string, bearer?: string) {
        const answer = await fetch(base + pathname, {headers: bearer ? {authorization: 'Bearer ' + bearer} : {}})
        return {status: answer.status, body: await answer.json() as any}
    }
    async function post(pathname: string, args: unknown[], bearer?: string) {
        const answer = await fetch(base + pathname, {
            method: 'POST',
            headers: {'content-type': 'application/json', ...(bearer ? {authorization: 'Bearer ' + bearer} : {})},
            body: JSON.stringify({args}),
        })
        return {status: answer.status, body: await answer.json() as any}
    }
    const api = '/api/' + name
    async function login(account: string, password: string) {
        const answer = await post(api + '/login', [{account, password}])
        if (!answer.body.ok) throw new Error(answer.body.error?.message)
        return answer.body.value.token as string
    }

    // ============== public: the menu, and nothing that a view hides ==============
    const menu = await get(api + '/views/menu')
    ok(menu.status == 200 && menu.body.ok && menu.body.value.items.length == 2 && !menu.body.value.items.some((item: any) => item.id == 'calzone'),
        'GET views/menu is public and lists only the available items')
    const kitchenAnon = await get(api + '/views/kitchen')
    ok(kitchenAnon.body.ok == false && /forbidden/.test(kitchenAnon.body.error?.message ?? ''), `a role view without a bearer is refused (${kitchenAnon.body.error?.message})`)
    const meAnon = await get(api + '/me')
    ok(meAnon.status == 401, 'GET /me without a bearer answers 401')

    // ============== credentials → token: the leader is the identity provider ==============
    const badLogin = await post(api + '/login', [{account: 'chef', password: 'wrong'}])
    ok(badLogin.body.ok == false && badLogin.body.error?.message == 'login refused', 'a wrong password is refused without saying which half was wrong')
    const shapeLogin = await post(api + '/login', [{account: 'chef'}])
    ok(shapeLogin.body.ok == false && shapeLogin.body.error?.message == 'input.password is required', 'the login schema refuses a malformed form by field')
    const chefToken = await login('chef', DEMO_LOGINS.chef)
    const chefMe = await get(api + '/me', chefToken)
    ok(chefMe.body.ok && chefMe.body.value.account == 'chef' && JSON.stringify(chefMe.body.value.roles) == '["cook"]'
        && JSON.stringify(chefMe.body.value.views) == '["menu","kitchen"]'
        && JSON.stringify(chefMe.body.value.commands) == '["startCooking","markReady"]',
        `/me tells the cook exactly what it may read and call (${JSON.stringify(chefMe.body.value)})`)

    // the system principal is never a token: a forged claim is refused by the verifier
    const forgedSystem = createTokenCodec({secret: leader.secrets.tokenSecret}).issue({sub: SYSTEM_ACCOUNT})
    const forgedMe = await get(api + '/me', forgedSystem)
    ok(forgedMe.body.ok == false && /reserved account/.test(forgedMe.body.error?.message ?? ''), 'a signed token claiming the system principal is refused')

    // ============== signup over REST: the signup command runs as the system principal ==============
    const signedUp = await post(api + '/signup', ['s1', {account: 'dana', name: 'Dana', phone: '+1-555-0111', password: 'dana-pass'}])
    ok(signedUp.body.ok && signedUp.body.value.account == 'dana' && JSON.stringify(signedUp.body.value.roles) == '["customer"]', 'signup creates a customer account')
    const signedAgain = await post(api + '/signup', ['s1', {account: 'dana', name: 'Dana', phone: '+1-555-0111', password: 'dana-pass'}])
    ok(signedAgain.body.ok && signedAgain.body.value.account == 'dana', 'the same requestId answers the receipt instead of failing on the existing account')
    const duplicate = await post(api + '/signup', ['s2', {account: 'dana', name: 'Dana', phone: '+1', password: 'dana-pass'}])
    ok(duplicate.body.ok == false && /already exists/.test(duplicate.body.error?.message ?? ''), 'a new requestId for an existing account is refused')
    const weak = await post(api + '/signup', ['s3', {account: 'eve', name: 'Eve', phone: '+1', password: '123'}])
    ok(weak.body.ok == false && /at least 6/.test(weak.body.error?.message ?? ''), 'validate() still guards the signup input')
    ok(!hasKey(leader.view.state().accounts['dana'], 'password') && typeof leader.view.state().accounts['dana'].secret.hash == 'string', 'the state holds a salted hash, never the password')

    // ============== the customer: places an order over REST, cannot cook ==============
    const danaToken = await login('dana', 'dana-pass')
    const placed = await post(api + '/commands/placeOrder', ['p1', {items: ['margherita', 'diavola'], address: '12 Elm St'}], danaToken)
    const orderId = placed.body.value?.id as string
    ok(placed.body.ok && typeof orderId == 'string' && placed.body.value.total == 21 && placed.body.value.customer == 'dana' && placed.body.value.phone == '+1-555-0111',
        `placeOrder computes the total from the menu and binds the order to the verified account (${JSON.stringify(placed.body.value?.id)})`)
    const offMenu = await post(api + '/commands/placeOrder', ['p2', {items: ['calzone'], address: '12 Elm St'}], danaToken)
    ok(offMenu.body.ok == false && /not on the menu/.test(offMenu.body.error?.message ?? ''), 'an unavailable item is refused, nothing committed')
    const forbidden = await post(api + '/commands/startCooking', ['p3', {orderId}], danaToken)
    ok(forbidden.body.ok == false && /forbidden: startCooking needs one of: cook/.test(forbidden.body.error?.message ?? ''),
        `the authority refuses a customer's cook command at execution (${forbidden.body.error?.message})`)
    const danaMe = await get(api + '/me', danaToken)
    ok(!danaMe.body.value.commands.includes('startCooking') && JSON.stringify(danaMe.body.value.views) == '["menu","myOrders"]', 'and /me never advertised it')
    const myOrders = await get(api + '/views/myOrders', danaToken)
    ok(myOrders.body.ok && Object.keys(myOrders.body.value.orders).join() == orderId, 'myOrders shows the customer her own order')

    // ============== a node in-process: per-role facades and view lines from ITS mirror ==============
    const link = leader.serve.nodeLinkFragment()
    const roster = followNodeDirectory(link.control)
    await roster.ready
    const codec = createTokenCodec({secret: leader.secrets.tokenSecret})
    let connect: ((socket: SocketTmpl) => void) | null = null
    const node = createServiceNode<PizzeriaState>({
        definition: serviceDefinition,
        nodeId: 'node-1',
        heartbeatMs: 50,
        graceMs: 40,
        verifyToken: function verifyPresentedToken(presented) {
            const verdict = codec.verify(presented)
            if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
            if (verdict.claims.sub == SYSTEM_ACCOUNT) throw new Error('token rejected: reserved account')
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
        onLeave: () => {},
        log: quiet,
    })
    await node.start()
    await waitFor('the node registers itself in the roster', () => roster.nodes().some(view => view.nodeId == 'node-1' && view.role == 'mirror'))

    async function session(token?: string) {
        const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
        connect!(serverEnd)
        const read = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
        await read.readyStrict()
        const write = token ? createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token}) : null
        if (write) await write.readyStrict()
        return {read, write, kill}
    }

    // anonymous over the node: the public menu line, and NO raw replica line
    const anon = await session()
    const anonStrict = (anon.read.strict as any)[name]
    ok(anonStrict.replica == undefined && anonStrict.views?.menu != undefined,
        'the node serves the public menu line ungated and NOT the raw replica line')
    const menuLine = createStoreFollower<{items: unknown[]}>({remote: anon.read.func[name].views.menu})
    await menuLine.ready
    ok(menuLine.store.state.items.length == 2 && !hasKey(menuLine.store.snapshot(), 'secret') && !hasKey(menuLine.store.snapshot(), 'accounts'),
        'an anonymous follower receives the menu projection only')

    // the cook over the node: pruned facade, kitchen line without contacts, command through the corridor
    const chef = await session(chefToken)
    const chefFacade = (chef.write!.strict as any)[name]
    ok(chefFacade.commands?.placeOrder == undefined && typeof chefFacade.commands?.startCooking == 'function' && chefFacade.views?.myOrders == undefined && chefFacade.views?.kitchen != undefined,
        'the cook facade on the node has no placeOrder and no myOrders — pruned, not refused')
    const kitchen = createStoreFollower<{orders: Record<string, any>}>({remote: chef.write!.func[name].views.kitchen})
    await kitchen.ready
    ok(kitchen.store.state.orders[orderId]?.state == 'placed' && !hasKey(kitchen.store.snapshot(), 'phone') && !hasKey(kitchen.store.snapshot(), 'address'),
        'the kitchen line carries the open order WITHOUT the customer contacts')
    const cooking = await chef.write!.func[name].commands.startCooking('c1', {orderId})
    ok(cooking.state == 'cooking' && cooking.cook == 'chef', 'startCooking forwards through the node to the authority as the verified cook')
    await waitFor('the kitchen line advances through the node mirror', () => kitchen.store.state.orders[orderId]?.state == 'cooking')

    // the customer over the node: her own line follows the cook's action; another customer's line does not
    const dana = await session(danaToken)
    const mine = createStoreFollower<{orders: Record<string, any>}>({remote: dana.write!.func[name].views.myOrders})
    await mine.ready
    ok(mine.store.state.orders[orderId]?.state == 'cooking', 'myOrders on the node shows the order already cooking')
    const aliceToken = await login('alice', DEMO_LOGINS.alice)
    const alice = await session(aliceToken)
    const aliceMine = createStoreFollower<{orders: Record<string, any>}>({remote: alice.write!.func[name].views.myOrders})
    await aliceMine.ready
    ok(Object.keys(aliceMine.store.state.orders).length == 0, "alice's myOrders line does not contain dana's order")
    const forgedOverNode = await dana.write!.func[name].commands.startCooking('c9', {orderId}).then(() => 'executed', (error: any) => String(error?.message ?? error))
    ok(forgedOverNode != 'executed', `a forged path call to a pruned member on the node is refused (${forgedOverNode})`)

    // ============== the full flow: ready → dispatch (with contacts) → delivered → revenue ==============
    const ready = await chef.write!.func[name].commands.markReady('c2', {orderId})
    ok(ready.state == 'ready', 'markReady by the same cook')
    const riderToken = await login('rider', DEMO_LOGINS.rider)
    const dispatchBefore = await get(api + '/views/dispatch', riderToken)
    ok(dispatchBefore.body.ok && dispatchBefore.body.value.orders[orderId]?.address == '12 Elm St' && dispatchBefore.body.value.orders[orderId]?.phone == '+1-555-0111',
        'the dispatch view gives the courier the address and phone of a READY order')
    const kitchenAsRider = await get(api + '/views/kitchen', riderToken)
    ok(kitchenAsRider.body.ok == false, 'the courier cannot read the kitchen view')
    const picked = await post(api + '/commands/pickUp', ['r1', {orderId}], riderToken)
    ok(picked.body.ok && picked.body.value.state == 'delivering', 'pickUp by the courier')
    await waitFor('the kitchen line drops the order once it left the kitchen', () => kitchen.store.state.orders[orderId] == undefined)
    const delivered = await post(api + '/commands/markDelivered', ['r2', {orderId}], riderToken)
    ok(delivered.body.ok && delivered.body.value.total == 21, 'markDelivered by the same courier')
    const ownerToken = await login('owner', DEMO_LOGINS.owner)
    const revenue = await get(api + '/views/revenue', ownerToken)
    ok(revenue.body.ok && revenue.body.value.delivered == 1 && revenue.body.value.total == 21, `the owner sees the revenue (${JSON.stringify(revenue.body.value)})`)
    const revenueAsManager = await get(api + '/views/revenue', await login('manager', DEMO_LOGINS.manager))
    ok(revenueAsManager.body.ok == false, 'the manager cannot read the revenue view')
    const staff = await get(api + '/views/staff', ownerToken)
    ok(staff.body.ok && staff.body.value.accounts['dana']?.roles[0] == 'customer' && !hasKey(staff.body.value, 'secret') && !hasKey(staff.body.value, 'hash'),
        'the staff view lists every account WITHOUT its secret')

    // ============== roles are state: the owner promotes dana, her rights change without a new token ==============
    const promoted = await post(api + '/commands/setRoles', ['o1', {account: 'dana', roles: ['customer', 'cook']}], ownerToken)
    ok(promoted.body.ok && JSON.stringify(promoted.body.value.roles) == '["customer","cook"]', 'setRoles by the owner')
    const danaMeAfter = await get(api + '/me', danaToken)
    ok(danaMeAfter.body.value.commands.includes('startCooking') && danaMeAfter.body.value.views.includes('kitchen'), 'the same bearer now carries the cook rights — roles are read from state per call')
    const unknownRole = await post(api + '/commands/setRoles', ['o2', {account: 'dana', roles: ['admin']}], ownerToken)
    ok(unknownRole.body.ok == false && /unknown role/.test(unknownRole.body.error?.message ?? ''), 'an unknown role name is refused')
    const dropOwner = await post(api + '/commands/setRoles', ['o3', {account: 'owner', roles: ['manager']}], ownerToken)
    ok(dropOwner.body.ok == false && /cannot drop the owner role/.test(dropOwner.body.error?.message ?? ''), 'an owner cannot lock everyone out')

    // ============== revocation reaches REST and sockets alike; login lifts it ==============
    let chefCut = false
    chef.write!.onAuthState(function onChefAuth(event: any) { if (event.state == 'revoked') chefCut = true })
    leader.control.revoke('chef')
    const chefMeRevoked = await get(api + '/me', chefToken)
    ok(chefMeRevoked.body.ok == false && /revoked/.test(chefMeRevoked.body.error?.message ?? ''), 'a revoked account is refused on REST at once')
    await waitFor('the deny-list fact cuts the live socket session on the node', () => chefCut)
    const chefAgain = await login('chef', DEMO_LOGINS.chef)
    ok((await get(api + '/me', chefAgain)).body.ok, 'an explicit login lifts the revocation')

    // ============== pages and the document ==============
    for (const suffix of ['/panel', '/docs', '/openapi.json']) {
        const answer = await fetch(base + suffix)
        ok(answer.status == 200, `${suffix} answers 200`)
        await answer.text()
    }
    const spec = await fetch(base + '/openapi.json').then(answer => answer.json()) as any
    const placeRoute = spec.paths[api + '/commands/placeOrder']?.post
    ok(placeRoute?.security?.[0]?.bearerAuth != undefined && JSON.stringify(placeRoute?.requestBody?.content?.['application/json']?.schema?.oneOf?.[0]?.properties?.args?.prefixItems?.[1]?.required) == '["items","address"]',
        'the document carries the bearer requirement and the real input tuple of placeOrder')
    ok(spec.paths[api + '/login']?.post != undefined && spec.paths[api + '/signup']?.post != undefined && spec.paths[api + '/views/menu']?.get != undefined && spec.paths[api + '/me']?.get?.security != undefined,
        'login, signup, the views and /me are documented')
    ok(spec.paths[api + '/views/menu']?.get?.summary == 'Public projection' && spec.paths[api + '/views/revenue']?.get?.summary == 'Roles: owner (bearer)',
        'view summaries state the audience')

    anon.kill(); chef.kill(); dana.kill(); alice.kill()
    menuLine.close(); kitchen.close(); mine.close(); aliceMine.close()
    node.close()
    roster.close()
    leader.control.close()
    httpServer.close()
    clearTimeout(watchdog)
    console.log(fails == 0 ? '\npizzeria self-check: ALL GREEN' : `\npizzeria self-check: ${fails} FAILURES`)
    setTimeout(function exitNow() { process.exit(fails ? 1 : 0) }, 100)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})


