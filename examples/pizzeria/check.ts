// The installed-project oracle of the pizzeria example: a real stand (leader +
// one node as OS processes) through public package imports only. REST proves
// the identity and role rules; a socket to the NODE proves that every corner
// serves the same pruned facades and the same view lines.
import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createStoreFollower} from 'wenay-common2/observe'
import {createRpcClient} from 'wenay-common2/rpc'
import {DEMO_LOGINS} from './service'

async function waitFor(what: string, check: () => boolean) {
    const deadline = Date.now() + 10_000
    while (!check()) {
        if (Date.now() > deadline) throw new Error(what + ' did not happen in time')
        await new Promise(function tick(resolve) { setTimeout(resolve, 25) })
    }
}

async function main() {
    const {startStand} = await import('./run.mjs')
    const stand = await startStand({nodes: 1})
    const api = stand.url + '/api/pizzeria'
    const sockets: ReturnType<typeof io>[] = []
    const watchdog = setTimeout(function expired() {
        for (const socket of sockets) socket.disconnect()
        void stand.close()
        process.exitCode = 1
    }, 60_000)

    async function get(pathname: string, bearer?: string) {
        const answer = await fetch(api + pathname, {headers: bearer ? {authorization: 'Bearer ' + bearer} : {}})
        return {status: answer.status, body: await answer.json() as any}
    }
    async function post(pathname: string, args: unknown[], bearer?: string) {
        const answer = await fetch(api + pathname, {
            method: 'POST',
            headers: {'content-type': 'application/json', ...(bearer ? {authorization: 'Bearer ' + bearer} : {})},
            body: JSON.stringify({args}),
        })
        return {status: answer.status, body: await answer.json() as any}
    }
    async function login(account: string, password: string) {
        const answer = await post('/login', [{account, password}])
        assert(answer.body.ok, 'login ' + account + ': ' + answer.body.error?.message)
        return answer.body.value.token as string
    }
    async function session(url: string, token?: string) {
        const socket = io(url, {transports: ['websocket'], forceNew: true, reconnection: false})
        sockets.push(socket)
        const read = createRpcClient<any>({socket, socketKey: 'app'})
        await read.readyStrict()
        const write = token ? createRpcClient<any>({socket, socketKey: 'scale', token}) : null
        if (write) await write.readyStrict()
        return {read, write, socket}
    }

    try {
        // ============== pages ==============
        for (const suffix of ['/panel', '/docs', '/openapi.json']) {
            const response = await fetch(stand.url + suffix, {signal: AbortSignal.timeout(5000)})
            assert.equal(response.status, 200, suffix)
            await response.arrayBuffer()
        }
        const spec = await fetch(stand.url + '/openapi.json').then(response => response.json())
        assert(spec.paths['/api/pizzeria/commands/placeOrder'].post.security, 'placeOrder documented as bearer-gated')
        assert(spec.paths['/api/pizzeria/login'].post && spec.paths['/api/pizzeria/views/menu'].get, 'login and the public menu documented')

        // ============== identity and roles over REST ==============
        const menu = await get('/views/menu')
        assert(menu.body.ok && menu.body.value.items.length == 2, 'public menu')
        assert.equal((await get('/views/kitchen')).body.ok, false, 'kitchen refused without a bearer')
        assert.equal((await get('/me')).status, 401, '/me without a bearer')
        assert.equal((await post('/login', [{account: 'chef', password: 'nope'}])).body.error?.message, 'login refused')
        const chef = await login('chef', DEMO_LOGINS.chef)
        const chefMe = (await get('/me', chef)).body.value
        assert.deepEqual(chefMe.roles, ['cook'])
        assert.deepEqual(chefMe.commands, ['startCooking', 'markReady'])
        const signup = await post('/signup', ['s1', {account: 'dana', name: 'Dana', phone: '+1-555-0111', password: 'dana-pass'}])
        assert(signup.body.ok && signup.body.value.roles[0] == 'customer', 'signup')
        const dana = await login('dana', 'dana-pass')
        const placed = await post('/commands/placeOrder', ['p1', {items: ['margherita', 'diavola'], address: '12 Elm St'}], dana)
        const orderId = placed.body.value?.id as string
        assert(placed.body.ok && placed.body.value.total == 21 && placed.body.value.customer == 'dana', 'placeOrder')
        const forbidden = await post('/commands/startCooking', ['p2', {orderId}], dana)
        assert.match(forbidden.body.error?.message ?? '', /forbidden: startCooking/)
        const retry = await post('/commands/placeOrder', ['p1', {items: ['margherita', 'diavola'], address: '12 Elm St'}], dana)
        assert.equal(retry.body.value.id, orderId, 'the same requestId answers the receipt')
        console.log('PASS identity, roles and the command corridor over REST')

        // ============== the NODE serves the same shaped facades and lines ==============
        const nodeUrl = stand.nodeUrls[0]
        const anon = await session(nodeUrl)
        assert.equal((anon.read.strict as any).pizzeria.replica, undefined, 'no raw line on the node')
        const menuLine = createStoreFollower<{items: unknown[]}>({remote: anon.read.func.pizzeria.views.menu})
        await menuLine.ready
        assert.equal(menuLine.store.state.items.length, 2, 'the public menu line from the node mirror')
        const cook = await session(nodeUrl, chef)
        assert.equal((cook.write!.strict as any).pizzeria.commands.placeOrder, undefined, 'placeOrder pruned from the cook facade')
        const kitchen = createStoreFollower<{orders: Record<string, any>}>({remote: cook.write!.func.pizzeria.views.kitchen})
        await kitchen.ready
        assert.equal(kitchen.store.state.orders[orderId]?.state, 'placed')
        assert.equal(kitchen.store.state.orders[orderId]?.phone, undefined, 'the kitchen line hides the phone')
        const cooking = await cook.write!.func.pizzeria.commands.startCooking('c1', {orderId})
        assert.equal(cooking.state, 'cooking', 'a command through the node')
        await waitFor('kitchen line update', () => kitchen.store.state.orders[orderId]?.state == 'cooking')
        const customer = await session(nodeUrl, dana)
        const mine = createStoreFollower<{orders: Record<string, any>}>({remote: customer.write!.func.pizzeria.views.myOrders})
        await mine.ready
        assert.equal(mine.store.state.orders[orderId]?.state, 'cooking', 'myOrders on the node follows the kitchen')
        const alice = await session(nodeUrl, await login('alice', DEMO_LOGINS.alice))
        const aliceMine = createStoreFollower<{orders: Record<string, any>}>({remote: alice.write!.func.pizzeria.views.myOrders})
        await aliceMine.ready
        assert.equal(Object.keys(aliceMine.store.state.orders).length, 0, "alice's line has no order of dana's")
        for (const line of [menuLine, kitchen, mine, aliceMine]) line.close()
        console.log('PASS the node serves pruned facades and per-principal view lines')

        // ============== the rest of the flow, and roles as state ==============
        const rider = await login('rider', DEMO_LOGINS.rider)
        assert((await post('/commands/markReady', ['c2', {orderId}], chef)).body.ok)
        const dispatch = (await get('/views/dispatch', rider)).body.value
        assert.equal(dispatch.orders[orderId]?.phone, '+1-555-0111', 'the courier sees the phone of a ready order')
        assert((await post('/commands/pickUp', ['r1', {orderId}], rider)).body.ok)
        assert((await post('/commands/markDelivered', ['r2', {orderId}], rider)).body.ok)
        const owner = await login('owner', DEMO_LOGINS.owner)
        assert.equal((await get('/views/revenue', owner)).body.value.total, 21, 'revenue for the owner')
        assert.equal((await get('/views/revenue', rider)).body.ok, false, 'revenue refused for the courier')
        assert((await post('/commands/setRoles', ['o1', {account: 'dana', roles: ['customer', 'cook']}], owner)).body.ok)
        assert((await get('/me', dana)).body.value.commands.includes('startCooking'), 'the same bearer gained the cook rights')
        console.log('PASS the order flow across four roles; roles are state')
        console.log('pizzeria check: ALL GREEN')
    } finally {
        clearTimeout(watchdog)
        for (const socket of sockets) socket.disconnect()
        await stand.close()
    }
}

main().catch(function failed(error) {
    console.error(error)
    process.exitCode = 1
})


