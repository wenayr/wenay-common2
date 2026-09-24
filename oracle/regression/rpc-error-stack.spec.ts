// Regression: an RPC error reached the peer with the server's stack frames (file paths and
// internals), the same leak the HTTP facade had. A peer now gets name/message/code/data/cause;
// the server's frames travel only when the server runs with `debug: true` (opt-in for development).
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {runOracle} from '../run-oracle'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`)
    if (!ok) failures++
}

function serverOnlyFrame(): never {
    const cause = new Error('inner cause')
    throw Object.assign(new Error('server failure', {cause}), {code: 'E_SERVER'})
}

async function failureSeenByClient(debug: boolean) {
    const [c, s] = createInProcSocketPair()
    const api = {fail: () => serverOnlyFrame()}
    createRpcServer({socket: s, socketKey: 'k', object: api, debug})
    const client = createRpcClient<typeof api>({socket: c, socketKey: 'k'})
    await client.ready()
    return await (client.func as any).fail().then(() => null, (error: any) => error)
}

async function main() {
    const plain = await failureSeenByClient(false)
    check('the peer still gets the error facts', plain?.message == 'server failure' && plain?.code == 'E_SERVER', JSON.stringify({message: plain?.message, code: plain?.code}))
    check('no server frame reaches the peer', !String(plain?.stack ?? '').includes('serverOnlyFrame'), String(plain?.stack).split('\n').slice(0, 3).join(' | '))
    check('no server frame in the cause either', !String(plain?.cause?.stack ?? '').includes('rpc-error-stack'), String(plain?.cause?.stack).split('\n').slice(0, 2).join(' | '))

    const originalLog = console.log
    console.log = () => undefined // debug mode logs every packet
    const debugged = await failureSeenByClient(true)
    console.log = originalLog
    check('debug: true still sends the server frames (development opt-in)', String(debugged?.stack ?? '').includes('serverOnlyFrame'), String(debugged?.stack).split('\n').slice(0, 2).join(' | '))

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exitCode = failures == 0 ? 0 : 1
}

runOracle(main)
