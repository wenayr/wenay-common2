// Regression: a PIPE `get` step followed by a `call` step must keep the method bound to the
// object it was read from. The server walked `current = current[step.prop]` and later invoked
// `current(...args)` unbound, so any this-dependent method (a class instance method, a built-in
// like Date.prototype.toISOString) failed with "Cannot read properties of undefined" or an
// incompatible-receiver TypeError. Only the ROOT method was bound.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {runOracle} from '../run-oracle'

let failures = 0
function check(name: string, got: any, exp: any) {
    const ok = got === exp
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`}`)
    if (!ok) failures++
}

class User {
    constructor(public name: string) {}
    getName() { return this.name }
}

async function main() {
    const [c, s] = createInProcSocketPair()
    const api = {
        closure: (id: number) => ({getName: () => 'closure ' + id}), // this-free: worked before too
        model: (id: number) => new User('model ' + id),              // class instance: needs `this`
        when: () => new Date(0),                                     // built-in receiver
    }
    createRpcServer({socket: s, socketKey: 'k', object: api})
    const client = createRpcClient<typeof api>({socket: c, socketKey: 'k'})
    await client.ready()
    const p: any = client.pipe

    check('pipe: closure method', await p.closure(1).getName().catch((e: any) => 'ERR ' + e.message), 'closure 1')
    check('pipe: class instance method keeps its receiver', await p.model(1).getName().catch((e: any) => 'ERR ' + e.message), 'model 1')
    check('pipe: built-in Date method keeps its receiver', await p.when().toISOString().catch((e: any) => 'ERR ' + e.message), '1970-01-01T00:00:00.000Z')

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
runOracle(main)
