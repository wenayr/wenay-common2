// REAL-SOCKET slimv2: NEW slim Listen v2 (UseListen2) — unit-surface + end-to-end wire. Port 4110.
//
// FINDING (verified against source, see notes in ##RESULT##):
//   isListenCallback() in src/Common/events/Listen.ts identifies a "listen" by
//   STRUCTURAL key-set equality against funcListenCallbackBase's full api
//   (func/isRun/run/close/eventClose/removeEventClose/addListen/removeListen/count/getAllKeys).
//   A slim Listen2 exposes only {on, close, count}, so isListenCallback(listen2) === false
//   and rpc-server-auto's resolveTransform will NOT treat a bare Listen2 as a stream node.
//   Therefore the WIRE part uses the FULL listen handle (the one UseListen2 wraps), while the
//   SLIM surface (on/off/count/close) is unit-asserted directly. We also prove the slim view
//   and the full handle share ONE underlying impl (count() agrees across both faces), so a
//   UseListen2 stream interoperates with the RPC listen-socket layer exactly like UseListen —
//   via its full handle.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {UseListen2, toListen2, funcListenCallbackBase, isListenCallback, UseListen} from '../../src/Common/events/Listen'

const PORT = 4110

// emit fns + full handles created at module scope so makeObject (per-connection) can place
// the FULL listen as the wire stream node while the spec drives emit / inspects slim surface.
const [emitWire, fullWire] = UseListen<number>()          // full handle → goes on the wire
const slimWire = toListen2<number>(fullWire)              // slim VIEW over the SAME impl as fullWire

function makeObject() {
    // Wire a real stream node. isListenCallback only accepts the FULL listen, so place that.
    // The slim Listen2 (slimWire) is a view over this very handle — same subscriber set.
    return {
        ticks: fullWire,
    }
}

async function main() {
    const {check, done} = makeChecker('slimv2')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // ===== 0. Static finding: Listen2 is NOT detected as a listen by isListenCallback =====
    const [, slimStandalone] = UseListen2<number>()
    await check('isListenCallback(full UseListen) === true', () => isListenCallback(fullWire), true)
    await check('isListenCallback(slim Listen2) === false', () => isListenCallback(slimStandalone as any), false)

    // ===== 1. Slim surface unit tests (on/off/count/close) on a standalone UseListen2 =====
    {
        const [emit, listen] = UseListen2<number>()
        const got: number[] = []
        await check('count() starts at 0', () => listen.count(), 0)

        const off = listen.on(v => got.push(v))
        await check('count() === 1 after on()', () => listen.count(), 1)
        await check('on() returns a function (off)', () => typeof off, 'function')

        emit(10); emit(20)
        await check('on(cb) receives ticks', () => got.slice(), [10, 20])

        off()
        await check('count() === 0 after off()', () => listen.count(), 0)
        emit(30)
        await check('off() stops delivery', () => got.slice(), [10, 20])

        // re-subscribe two, then close() tears everything down
        const g2: number[] = []
        listen.on(v => g2.push(v))
        listen.on(v => g2.push(v))
        await check('count() === 2 after two on()', () => listen.count(), 2)
        emit(7)
        await check('two subscribers each get tick', () => g2.slice(), [7, 7])
        listen.close()
        await check('count() === 0 after close()', () => listen.count(), 0)
        emit(99)
        await check('close() stops delivery', () => g2.slice(), [7, 7])
    }

    // ===== 2. Slim view interoperates with full handle (shared impl) =====
    // slimWire is toListen2(fullWire); a subscription via the full handle must be visible
    // through slim.count(), proving they are ONE Listen (the same impl UseListen2 wraps).
    {
        const offFull = fullWire.addListen(() => {})
        await check('slim.count() reflects full.addListen', () => slimWire.count(), 1)
        offFull()
        await check('slim.count() reflects full off()', () => slimWire.count(), 0)
    }

    // ===== 3. END-TO-END wire: full handle (the one UseListen2 wraps) over a REAL socket =====
    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})
    const api = cli.api

    const received: number[] = []
    const sub: any = api.ticks.callback((v: number) => received.push(v))
    await delay(150) // let the subscription round-trip over the real WebSocket

    // server-side subscriber present (the wire created a listen-socket subscriber on fullWire)
    await check('wire: server has >=1 subscriber on the listen', () => fullWire.count() >= 1, true)

    emitWire(101)
    emitWire(202)
    emitWire(303)
    await delay(200) // real WS latency for emitted ticks to arrive

    await check('wire: ticks arrive end-to-end', () => received.slice(), [101, 202, 303])
    // slim view sees the SAME live subscriber count as the full wire handle
    await check('wire: slim view agrees with full handle count', () => slimWire.count(), fullWire.count())

    // unsubscribe over the wire and confirm no further ticks
    sub()
    await delay(150)
    emitWire(404)
    await delay(150)
    await check('wire: off() stops end-to-end delivery', () => received.slice(), [101, 202, 303])

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
