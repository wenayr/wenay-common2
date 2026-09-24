// oracle-ends: own watchdog timer — a stall exits 3
// ============================================================
//  observe/scale-audience.test.ts
//
//  The audience seam of the serving corners: a node's `serve.audience`
//  and the authority's `serve.connection({principal})` let the HOST decide
//  what each connection is served — public projections instead of the raw
//  line, a facade pruned by role (RPC-AUTH rule 3: absent, not checked),
//  a per-account line released when the session is gone. Legs ride REAL
//  RPC over the in-process loopback. The negative control is the default
//  node: with no shaping the raw line and every command are served, which
//  is exactly what a private application must not do.
//  Run: npx tsx observe/scale-audience.test.ts
// ============================================================

import {listen} from '../src/Common/events/Listen'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {deriveStore} from '../src/Common/Observe/store-derive'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {createStoreNode, type StoreNodeAudience, type StoreNodePrincipal} from '../src/Common/Observe/store-node'
import {createAuthority, type AuthorityUpstream} from '../src/Common/scale/scale-authority'
import type {CommandCtx} from '../src/Common/command/command-host'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
async function waitFor(message: string, check: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 15))
    }
    ok(false, message + ' (timed out)')
}

type Order = {id: string, customer: string, phone: string, state: 'placed' | 'cooking'}
type State = {
    menu: Record<string, {id: string, price: number}>
    accounts: Record<string, {roles: string[], secret: string}>
    orders: Record<string, Order>
}
const commands = {
    place(ctx: CommandCtx, input: {phone: string}) {
        const order: Order = {id: 'o-' + ctx.requestId, customer: ctx.account, phone: input.phone, state: 'placed'}
        return order
    },
    cook(ctx: CommandCtx, input: {orderId: string}) {
        return {orderId: input.orderId, by: ctx.account}
    },
}
type Cmds = typeof commands

// the tokens of this oracle are plain strings; a real host verifies a codec token
const tokenOf = (account: string) => 'tok:' + account
const accountOf = (presented: unknown) => String(presented ?? '').slice(4)

function rolesOf(state: State, account: string) {
    return state.accounts[account]?.roles ?? []
}

// library type: the strict facade of an untyped client (ClientAPIStrict<any>) maps every member to a
// function | object union and cannot be navigated, while func of the same client is any; the probes
// below only read members that the audience seam may prune
type SessionProbe = {svc: {replica?: unknown, node?: unknown, views?: {menu?: unknown}, commands?: {cook?: unknown}}}
function strictProbe(client: {strict: unknown}) {
    return client.strict as SessionProbe
}

/** The read policy of this oracle, shared by the authority and the node (one function, two corners). */
function shapeFor(store: () => import('../src/Common/Observe/store').Store<State>, released: {count: number}) {
    // public projection: the menu only — built once per process, shared by every anonymous reader
    const menu = deriveStore(store(), state => ({menu: state.menu}), {keys: ['menu']})
    const menuLine = exposeStoreReplay(menu.store, {describe: {view: 'menu'}})
    function principal(who: StoreNodePrincipal, defaults: {commands?: Record<string, unknown>, whoami: () => string}, session: {onGone: (cb: () => void) => () => void}) {
        const roles = rolesOf(store().snapshot(), who.account)
        const allow = (...needed: string[]) => needed.some(role => roles.includes(role)) ? true : null
        // one line per SESSION: my orders, released when the socket is gone
        const mine = deriveStore(store(), function projectMine(state) {
            const orders: Record<string, Order> = {}
            for (const order of Object.values(state.orders)) if (order.customer == who.account) orders[order.id] = order
            return {orders}
        }, {keys: ['orders']})
        const mineLine = exposeStoreReplay(mine.store, {describe: {view: 'mine', account: who.account}})
        session.onGone(function releaseMine() { mineLine.close(); mine.close(); released.count++ })
        const served = defaults.commands ?? {}
        return {
            whoami: defaults.whoami,
            roles: () => roles,
            // pruned facade (rule 3): a customer has NO cook member, not a refused one
            commands: {
                place: served['place'],
                cook: allow('cook') && served['cook'],
            },
            views: {mine: mineLine.api.replay},
        }
    }
    return {
        reader: () => ({views: {menu: menuLine.api.replay}}),
        principal,
        close() { menuLine.close(); menu.close() },
    }
}

async function main() {
    const watchdog = setTimeout(function oracleTimedOut() { console.error('scale-audience timed out'); process.exit(3) }, 60_000)
    const initial: State = {
        menu: {margherita: {id: 'margherita', price: 9}},
        accounts: {
            alice: {roles: ['customer'], secret: 'alice-hash'},
            bob: {roles: ['customer'], secret: 'bob-hash'},
            chef: {roles: ['cook'], secret: 'chef-hash'},
        },
        orders: {},
    }
    const released = {count: 0}
    const authority = createAuthority<State, Cmds>({
        line: {storeId: 'aud-line', originId: 'aud-origin', initial},
        roster: {url: () => 'mem://authority', heartbeatMs: 50},
        identity: {issue: tokenOf, verify: presented => ({account: accountOf(presented)})},
        corridor: {
            commands: {
                // the authority enforces the role at EXECUTION: a relay asserts nothing
                place: commands.place,
                cook(ctx, input) {
                    if (!rolesOf(authority.line.control.store.snapshot(), ctx.account).includes('cook')) throw new Error('forbidden: cook needs the cook role')
                    const receipt = commands.cook(ctx, input)
                    authority.line.control.store.state.orders[input.orderId].state = 'cooking'
                    return receipt
                },
            },
        },
        log: () => {},
    })
    // commands mutate the authority store (the oracle's apply is inline)
    const authorityShape = shapeFor(() => authority.line.control.store, released)
    authority.start()

    // ============== the authority corner: serve.connection({principal}) ==============
    {
        const gate = authority.serve.connection({principal: authorityShape.principal})
        const customer = gate.auth.resolveAuth(tokenOf('alice')).object as any
        const cook = gate.auth.resolveAuth(tokenOf('chef')).object as any
        ok(customer.commands.cook == null && typeof customer.commands.place == 'function', 'authority: a customer facade has NO cook member (pruned, rule 3)')
        ok(typeof cook.commands.cook == 'function' && typeof cook.commands.place == 'function', 'authority: the cook facade carries both')
        ok(!('store' in customer) && !('store' in cook), 'the store handed to the shaper never leaks into the served object')
        const placed = await customer.commands.place('r1', {phone: '+1'})
        authority.line.control.store.state.orders[placed.id] = placed
        ok(placed.customer == 'alice', 'the customer command executes through the shaped facade')
        const before = released.count
        gate.close()
        ok(released.count == before + 2, `closing the gated connection releases the per-session lines (${released.count - before} released)`)
        // the default, unshaped connection still serves the plain trio
        const plain = authority.serve.connection().auth.resolveAuth(tokenOf('alice')).object as any
        ok(typeof plain.commands.cook == 'function' && typeof plain.revoke == 'function' && !('store' in plain), 'control: the unshaped connection serves the default {whoami, commands, revoke}')
    }

    // ============== the node corner: serve.audience ==============
    const serveOf = new Map<string, (socket: SocketTmpl) => void>()
    function linkTo(asNode: string) {
        const [fail, onFail] = listen<[]>()
        const link = authority.serve.nodeLink(asNode)
        const upstream: AuthorityUpstream & {commandsByToken: any} = {
            replica: link.replica, control: link.control, commandsByToken: link.commandsByToken,
            register: link.register, heartbeat: link.heartbeat, goodbye: link.goodbye,
            onFail: {on: (cb: () => void) => onFail.on(cb)},
        }
        return {upstream, fail}
    }
    // assigned inside the audience callbacks: the initializer must not narrow it to null for close below
    let nodeShape = null as ReturnType<typeof shapeFor> | null
    const audience: StoreNodeAudience<State, Cmds> = {
        reader(defaults) {
            nodeShape ??= shapeFor(() => defaults.store, released)
            return nodeShape.reader()
        },
        principal(who, defaults, session) {
            nodeShape ??= shapeFor(() => defaults.store, released)
            return nodeShape.principal(who, defaults as any, session)
        },
    }
    function bootNode(nodeId: string, shaped: boolean) {
        const link = linkTo(nodeId)
        const node = createStoreNode<State, Cmds>({
            line: {nodeId, storeId: 'aud-line', originId: 'aud-origin'},
            roster: {url: () => 'mem://' + nodeId, heartbeatMs: 50, graceMs: 60},
            auth: {verify: presented => ({account: accountOf(presented)})},
            commands: ['place', 'cook'],
            upstream: () => link.upstream as any,
            serve: {
                onConnection(handler) { serveOf.set(nodeId, handler) },
                wrap: (fragment: Record<string, unknown>) => ({svc: fragment}),
                ...(shaped ? {audience} : {}),
            },
            onLeave() {},
            log: () => {},
        })
        return node
    }
    const node = bootNode('n1', true)
    await node.start()

    async function openSession(nodeId: string, token?: string) {
        const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
        serveOf.get(nodeId)!(serverEnd)
        const read = createRpcClient<any>({socket: clientEnd, socketKey: 'app'})
        await read.readyStrict()
        const write = token ? createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token}) : null
        if (write) await write.readyStrict()
        return {read, write, kill}
    }

    // anonymous: the menu projection, and NO raw line
    const anon = await openSession('n1')
    ok(strictProbe(anon.read).svc.replica == undefined && strictProbe(anon.read).svc.node == undefined && strictProbe(anon.read).svc.views?.menu != undefined, 'node: the ungated key serves the projection ONLY — no raw replica line, no node id (strict schema)')
    const menuFollower = createStoreFollower<{menu: State['menu']}>({remote: anon.read.func.svc.views.menu})
    await menuFollower.ready
    ok(JSON.stringify(menuFollower.store.snapshot()) == JSON.stringify({menu: initial.menu}) && !JSON.stringify(menuFollower.store.snapshot()).includes('hash'),
        'node: an anonymous follower receives the menu and nothing else')
    authority.line.control.store.state.menu.calzone = {id: 'calzone', price: 11}
    await waitFor('node: the public projection stays live through the node (authority → node mirror → derived line)', () => menuFollower.store.state.menu.calzone?.price == 11)

    // a customer: own orders only, no cook member, place forwards to the authority
    const alice = await openSession('n1', tokenOf('alice'))
    const roles = await alice.write!.func.svc.roles()
    ok(JSON.stringify(roles) == '["customer"]', 'node: the principal facade is shaped from the local mirror (roles from state)')
    ok(strictProbe(alice.write!).svc.commands?.cook == undefined, 'node: strict short-circuits the pruned cook member without a packet')
    const forged = await alice.write!.func.svc.commands.cook('r9', {orderId: 'o-r1'}).then(() => 'executed', (error: any) => String(error?.message ?? error))
    ok(forged != 'executed', `node: a forged path call to the pruned member is refused (${forged})`)
    const placed = await alice.write!.func.svc.commands.place('r2', {phone: '+2'})
    authority.line.control.store.state.orders[placed.id] = placed
    ok(placed.customer == 'alice' && placed.id == 'o-r2', 'node: the allowed command forwards to the authority as the verified account')

    // bob's order must not reach alice's line
    const bob = await openSession('n1', tokenOf('bob'))
    const bobOrder = await bob.write!.func.svc.commands.place('r3', {phone: '+3'})
    authority.line.control.store.state.orders[bobOrder.id] = bobOrder
    const mine = createStoreFollower<{orders: Record<string, Order>}>({remote: alice.write!.func.svc.views.mine})
    await mine.ready
    await waitFor('node: the per-session line carries only MY orders', () => Object.keys(mine.store.state.orders).length == 2 && Object.values(mine.store.state.orders).every(order => order.customer == 'alice'))
    ok(!JSON.stringify(mine.store.snapshot()).includes('+3'), 'bob\'s phone never rode alice\'s line')

    // the cook: the member exists AND the authority accepts it
    const chef = await openSession('n1', tokenOf('chef'))
    const cooked = await chef.write!.func.svc.commands.cook('r4', {orderId: 'o-r2'})
    ok(cooked.by == 'chef', 'node: the cook role reaches the cook command through the corridor')
    await waitFor('...and the effect replicates back into alice\'s per-session line', () => mine.store.state.orders['o-r2']?.state == 'cooking')

    // defense in depth: a customer who somehow reaches the authority's corridor is still refused there
    const link = authority.serve.nodeLink('rogue')
    const relayed = await link.commandsByToken.cook(tokenOf('bob'), 'r5', {orderId: 'o-r2'}).then(() => 'executed', (error: any) => String(error?.message ?? error))
    ok(relayed.includes('forbidden'), `authority: the corridor refuses the role at execution even for a relayed call (${relayed})`)

    // the session line is released when the socket is gone
    const before = released.count
    mine.close()
    alice.kill()
    await waitFor('node: closing the socket releases the per-session line (onGone fired once)', () => released.count == before + 1)

    // ============== negative control: the unshaped node serves everything ==============
    const plainNode = bootNode('n2', false)
    await plainNode.start()
    const plain = await openSession('n2', tokenOf('alice'))
    ok(strictProbe(plain.read).svc.replica != undefined && await plain.read.func.svc.node() == 'n2', 'control: without shaping the read key serves the raw replica line')
    ok(typeof strictProbe(plain.write!).svc.commands?.cook == 'function', 'control: without shaping a customer sees the cook member — visibility is the seam\'s job')

    plain.kill()
    bob.kill()
    chef.kill()
    anon.kill()
    menuFollower.close()
    nodeShape?.close()
    authorityShape.close()
    plainNode.close()
    node.close()
    authority.close()
    clearTimeout(watchdog)
    console.log(fails ? `\nFAIL scale-audience: ${fails} check(s)` : '\nPASS scale-audience')
    process.exit(fails ? 1 : 0)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
