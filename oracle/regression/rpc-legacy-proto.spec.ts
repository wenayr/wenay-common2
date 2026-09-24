// Regression: the legacy promiseServer path (reachable through the public
// createRpcServerAutoDetect) must resolve OWN members only and filter every key segment, so a
// crafted `key` cannot walk the prototype chain and install a process-wide setter.
// Repro r3: {key:['__proto__','__defineSetter__'], request:['password','___FUNC']} reached
// Object.prototype.__defineSetter__ and turned a later `user.password = ...` into wire exfiltration.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServerAutoDetect} from '../../src/Common/rcp/createRpcServerAutoWithProtocolDetection'
import {runOracle} from '../run-oracle'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (detail ?? '')}`)
    if (!cond) failures++
}

async function main() {
    try {
        const [attacker, s] = createInProcSocketPair()
        createRpcServerAutoDetect({socket: s, socketKey: 'k', object: {ping: () => 'pong'}})
        const received: any[] = []
        attacker.on('k', (m: any) => received.push(m))

        // 1) prototype-descent attack: '__proto__' then a prototype method
        attacker.emit('k', {mapId: 1, data: {key: ['__proto__', '__defineSetter__'], request: ['password', '___FUNC']}, callbacksId: [2]})
        // 2) direct prototype-method attack: isSafeKey allows the name, own-member must reject it
        attacker.emit('k', {mapId: 2, data: {key: ['__defineSetter__'], request: ['password', '___FUNC']}, callbacksId: [3]})
        await delay(30)

        const user: any = {name: 'alice'}
        user.password = 's3cret'
        await delay(20)

        const protoDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'password')
        check('no setter installed on Object.prototype', protoDesc == undefined,
            'descriptor=' + JSON.stringify(protoDesc))
        check('assignment lands as an own value (not hijacked)', user.password === 's3cret',
            'user.password=' + user.password)
        const stole = received.some(m => m && typeof m == 'object' && JSON.stringify(m).includes('s3cret'))
        check('attacker received no exfiltrated value', !stole, 'received=' + JSON.stringify(received))

        // positive control: a legitimate own method still resolves over the legacy wire
        received.length = 0
        attacker.emit('k', {mapId: 9, data: {key: ['ping'], request: []}})
        await delay(20)
        const pong = received.find(m => m && m.mapId == 9)
        check('legitimate legacy call still works', !!pong && pong.data == 'pong', 'reply=' + JSON.stringify(pong))
    } finally {
        delete (Object.prototype as any).password
    }

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
runOracle(main)
