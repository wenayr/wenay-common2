// Regression: below a noStrict node the RPC string path resolved a member with `in`, so every method a
// value inherits from a builtin prototype was a call target. A peer could plant an accessor on host
// data with __defineGetter__, and mutate it through an array's push/splice, a Map's clear or a Date's
// setTime. The has trap of a proxy and the
// methods of a host class stay reachable: they are the application's own surface.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {runOracle} from '../run-oracle'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`)
    if (!ok) failures++
}

class Strategy {
    started = 0
    start() { return ++this.started }
}

async function main() {
    const accounts: Record<string, any> = {alice: {greet: () => 'hi'}}
    const queue = [1, 2, 3]
    const cache = new Map([['k', 1]])
    const when = new Date(0)
    const strategies = {s1: new Strategy()}
    const ownClear = {clear: () => 'own clear'}
    const gated = new Proxy({}, {
        has: (_target, key) => key == 'bob',
        get: (_target, key) => key == 'bob' ? {ping: () => 'pong'} : undefined,
    })
    const api = {
        accounts: noStrict(accounts),
        queue: noStrict(queue),
        cache: noStrict(cache),
        clock: noStrict({when}),
        strategies: noStrict(strategies),
        ownClear: noStrict(ownClear),
        gated: noStrict(gated),
    }
    const [clientSocket, serverSocket] = createInProcSocketPair()
    createRpcServer({socket: serverSocket, socketKey: 'k', object: api})
    const client = createRpcClient<any>({socket: clientSocket, socketKey: 'k'})
    await client.ready()
    const f = client.func as any

    async function refused(name: string, call: () => Promise<unknown>) {
        const outcome = await call().then(value => ({ok: true, value}), (error: any) => ({ok: false, value: error?.message}))
        check(name, !outcome.ok && String(outcome.value).includes('Not a function'), JSON.stringify(outcome))
    }

    // ---------- inherited builtins are not call targets ----------
    await refused('__defineGetter__ under noStrict is refused', () => f.accounts.__defineGetter__('bob', () => 'planted'))
    check('no accessor planted on the host map', Object.getOwnPropertyDescriptor(accounts, 'bob') == undefined)
    await refused('hasOwnProperty under noStrict is refused', () => f.accounts.hasOwnProperty('alice'))
    await refused('toString below a noStrict node is refused', () => f.accounts.alice.toString())
    await refused("an array's push is refused", () => f.queue.push(4))
    await refused("an array's splice is refused", () => f.queue.splice(0, 3))
    check('the host array is unchanged', JSON.stringify(queue) == '[1,2,3]', JSON.stringify(queue))
    await refused("a Map's clear is refused", () => f.cache.clear())
    check('the host Map is unchanged', cache.size == 1, `size=${cache.size}`)
    await refused("a Date's setTime is refused", () => f.clock.when.setTime(5))
    check('the host Date is unchanged', when.getTime() == 0, String(when.getTime()))

    // ---------- the application's own surface stays reachable (controls) ----------
    check('an own method below noStrict works', await f.accounts.alice.greet() == 'hi')
    check("a host class's prototype method works", await f.strategies.s1.start() == 1)
    check('an own method named like a builtin works', await f.ownClear.clear() == 'own clear')
    check('a member answered only by the has trap works', await f.gated.bob.ping() == 'pong')
    await refused('a key the has trap denies is refused', () => f.gated.eve.ping())

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}

runOracle(main)
