// Regression: two deduplicated wire subscriptions to ONE Listen node that differ only by
// args/opts must be independent. Stopping the last consumer of one sent a node-wide
// `removeCallback` (server unsubscribeAll), which killed the sibling too.
// Repro r2: consumer A (plain) and B ({current:true}); A.off() ended B's stream.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (detail ?? '')}`)
    if (!cond) failures++
}

async function main() {
    const [c, s] = createInProcSocketPair()
    const [emit, prices] = createListenPair<[number]>()
    createRpcServerAuto({socket: s, socketKey: 'k', object: {prices}})
    const client = createRpcClient<any>({socket: c, socketKey: 'k'})
    await client.ready()

    const gotA: number[] = [], gotB: number[] = []
    const subA: any = client.func.prices.on((v: number) => gotA.push(v))
    const subB: any = client.func.prices.on((v: number) => gotB.push(v), {current: true})
    let bEnded = false
    Promise.resolve(subB).then(() => { bEnded = true })
    await delay(10)

    check('two independent wire subscriptions on one node', client.api.subscriptions().length == 2,
        JSON.stringify(client.api.subscriptions()))

    emit(1); await delay(10)
    check('both receive the first event', gotA.join() == '1' && gotB.join() == '1',
        'A=' + gotA + ' B=' + gotB)

    subA() // A leaves; B never asked to stop
    await delay(10)
    emit(2); await delay(10)

    check('sibling B keeps receiving after A.off', gotB.join() == '1,2', 'B=' + gotB)
    check('A stopped receiving after its own off', gotA.join() == '1', 'A=' + gotA)
    check('sibling B stream did not end', bEnded == false, 'bEnded=' + bEnded)
    check('one wire subscription remains', client.api.subscriptions().length == 1,
        JSON.stringify(client.api.subscriptions()))

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
main()
