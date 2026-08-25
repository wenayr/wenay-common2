// =====================================================================
//  An async onInvalid hook that rejects must not crash the process.
//
//  Production shape: an application that ships malformed-input telemetry —
//  `onInvalid: async ctx => reportToSentry(ctx)` — and the report fails (network down,
//  quota, a bad await inside). onInvalid is typed `void | Promise<void>` and fires on
//  input from the wire, so the rejected promise is created by a REMOTE peer's packet.
//
//  The CAPS branch of the packet handler already awaited its onInvalid calls; the
//  request branch could not (it sits inside early returns) and simply dropped the
//  promise. On Node an unhandled rejection terminates the process by default, which
//  makes it a remote kill switch for any server that installs such a hook.
//
//  This test fails against that code (the rejection reaches the process handler) and
//  passes against the fix.
// =====================================================================
import {io} from 'socket.io-client'
import {startRealServer, makeChecker, delay} from './_rs'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'

const PORT = 4134

function makeObject() {
    return {ping: () => 'pong'}
}

async function main() {
    const {check, done} = makeChecker('invalid-hook')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    const unhandled: string[] = []
    function onUnhandled(reason: any) { unhandled.push(String(reason?.message ?? reason)) }
    process.on('unhandledRejection', onUnhandled)

    let hookCalls = 0
    const srv = await startRealServer({
        port: PORT,
        makeObject,
        serverOpts: {
            hooks: {
                async onInvalid() {
                    hookCalls++
                    throw new Error('telemetry sink is down')
                },
            },
        },
    })

    // Raw wire: the official client cannot build these frames, and that is the point —
    // onInvalid exists precisely for peers that do not follow the protocol.
    const sock = io(`http://localhost:${PORT}`, {transports: ['websocket'], forceNew: true})
    await new Promise<void>(resolve => { sock.on('connect', () => resolve()) })

    sock.emit('rpc', [Pkt.CALL, 'not-a-number', ['ping'], [], true])   // reqId is not a number
    sock.emit('rpc', [Pkt.CALL, 1, 7, [], true])                       // ref is neither number nor array
    sock.emit('rpc', [Pkt.CALL, 2, ['ping'], 'not-an-array', true])    // args is not an array

    // Give the hook, the microtask queue and Node's unhandled-rejection detection time to run.
    await delay(300)

    await check('the hook did fire for every malformed frame', () => hookCalls, 3)
    await check('a rejecting async onInvalid produces no unhandled rejection',
        () => unhandled.filter(m => m.includes('telemetry sink is down')).length, 0)

    // and the connection is still usable afterwards
    const alive = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 2000)
        sock.on('rpc', function onAnswer(msg: any) {
            if (Array.isArray(msg) && msg[0] === Pkt.RESP && msg[1] === 9) { clearTimeout(timer); resolve(msg[2] === 'pong') }
        })
        sock.emit('rpc', [Pkt.CALL, 9, ['ping'], [], true])
    })
    await check('the connection still serves valid calls', () => alive, true)

    clearTimeout(watchdog)
    process.off('unhandledRejection', onUnhandled)
    sock.disconnect()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
