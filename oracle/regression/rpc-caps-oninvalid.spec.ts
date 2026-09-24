// Regression: the CAPS branch of handleServerPacket must not let a rejecting async hooks.onInvalid
// escape as a process-level unhandledRejection. A remote peer controls the trigger (bad/missing
// client id, foreign session id, too many sessions), so an app whose audit sink rejects would be
// crashable from the wire. The request path already routes onInvalid through reportInvalid; the
// CAPS path must too.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'
import {runOracle} from '../run-oracle'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (detail ?? '')}`)
    if (!cond) failures++
}

async function main() {
    const unhandled: string[] = []
    function onUnhandled(e: any) { unhandled.push(String(e?.message ?? e)) }
    process.on('unhandledRejection', onUnhandled)

    const [c, s] = createInProcSocketPair()
    let generation: number | undefined
    c.on('k', (m: any) => { if (Array.isArray(m) && m[0] == Pkt.CAPS && m[3] != undefined) generation = m[3] })
    createRpcServer({
        socket: s, socketKey: 'k', object: {ping: () => 'pong'},
        hooks: {onInvalid: async () => { throw new Error('audit sink unavailable') }},
    })
    // advertise client caps so the server assigns a generation we can echo back
    c.emit('k', [Pkt.CAPS, 1])
    await delay(20)

    // request path (already guarded): malformed reqId -> reportInvalid
    c.emit('k', [Pkt.CALL, -1, ['ping'], []])
    await delay(20)
    const afterRequest = unhandled.length

    // CAPS path: a correlated session with an invalid client id (0) -> onInvalid
    c.emit('k', [Pkt.CAPS, 1, 5, generation, 0])
    await delay(30)
    const afterCaps = unhandled.length

    check('request-path invalid does not crash the process', afterRequest == 0, 'unhandled=' + unhandled.join('; '))
    check('CAPS-path invalid does not crash the process', afterCaps == 0, 'unhandled=' + unhandled.join('; '))

    process.off('unhandledRejection', onUnhandled)
    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
runOracle(main)
