// ============================================================
//  oracle/realsocket/errors.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "errors": error propagation across a real WebSocket.
//   - plain Error -> client rejects with the message
//   - MyError with code+data -> code + data preserved over the wire
//   - a rejected CALL does not kill the connection (next call still works)
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {MyError} from '../../src/toError/myThrow'

const PORT = 4104

function makeObject() {
    return {
        // happy path — used to prove the socket survives rejections
        add: (a: number, b: number) => a + b,
        ping: () => 'pong',

        // ===== error-throwing handlers =====
        throwPlain: () => { throw new Error('boom-plain') },
        throwMyErr: () => { throw new MyError('payload-msg', 'E_TEST', {x: 1, tag: 'rich'}) },
        // MyError carrying structured (wire-safe) data — verify nested data survives
        throwNested: () => {
            throw new MyError('nested-data', 'E_NESTED', {list: [1, 2, 3], meta: {ok: true, deep: {y: 9}}})
        },
        // async rejection
        rejectAsync: async () => { await delay(5); throw new MyError('async-fail', 'E_ASYNC', {k: 'v'}) },
        // MyError whose data carries a BigInt — probes errToObj pack behavior.
        // FINDING: errToObj copies e.data RAW (no pack walk), so a BigInt here is
        // handed to socket.io's JSON.stringify and throws server-side, killing
        // the connection. Rich types round-trip in normal RESULTS but NOT in errors.
        throwBigErr: () => { throw new MyError('big-fail', 'E_BIG', {n: 42n}) },
    }
}

// The server runs in THIS same process. The BigInt-in-error-data probe makes the
// server's socket emit throw synchronously OUTSIDE the rpc try/catch, which would
// otherwise crash the whole process before ##RESULT## prints. Swallow it so the
// finding is recorded as a FAIL by the client-side race below, not a hard crash.
let sawSerializeCrash = false
process.on('uncaughtException', (e: any) => {
    if (String(e?.message ?? e).includes('BigInt')) { sawSerializeCrash = true; return }
    console.error('UNEXPECTED uncaughtException', e); process.exit(2)
})

async function main() {
    const {check, done} = makeChecker('errors')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})
    const api = cli.api

    await delay(20)

    // sanity: happy call works before we start throwing
    await check('sanity: add(2,3)=5', () => api.add(2, 3), 5)

    // plain Error -> client rejects with the same message
    await check('plain Error -> message',
        () => api.throwPlain().then(() => '__no_throw__', (e: any) => e?.message), 'boom-plain')

    // connection survives a rejected call: a subsequent call still works
    await check('socket alive after plain reject', () => api.ping(), 'pong')

    // MyError -> revived as a real Error instance on the client
    await check('MyError -> instanceof Error',
        () => api.throwMyErr().then(() => false, (e: any) => e instanceof Error), true)

    // MyError -> name preserved
    await check('MyError -> name',
        () => api.throwMyErr().then(() => '', (e: any) => e?.name), 'MyError')

    // MyError -> message preserved
    await check('MyError -> message',
        () => api.throwMyErr().then(() => '', (e: any) => e?.message), 'payload-msg')

    // MyError -> machine code preserved across the wire
    await check('MyError -> code',
        () => api.throwMyErr().then(() => '', (e: any) => e?.code), 'E_TEST')

    // MyError -> arbitrary data payload preserved across the wire
    await check('MyError -> data',
        () => api.throwMyErr().then(() => null, (e: any) => e?.data), {x: 1, tag: 'rich'})

    // socket still alive after the MyError reject
    await check('socket alive after MyError reject', () => api.add(10, 20), 30)

    // nested/structured (wire-safe) data inside MyError.data survives intact
    await check('MyError -> nested data',
        () => api.throwNested().then(() => null, (e: any) => e?.data),
        {list: [1, 2, 3], meta: {ok: true, deep: {y: 9}}})

    // async rejection: code + data preserved
    await check('async MyError -> [code, data]',
        () => api.rejectAsync().then(() => null, (e: any) => [e?.code, e?.data]),
        ['E_ASYNC', {k: 'v'}])

    // final liveness BEFORE probing the BigInt-in-error crash
    await check('socket alive before big-err probe', () => api.ping(), 'pong')

    // FINDING probe: BigInt inside MyError.data. errToObj copies data raw, so the
    // server's socket emit throws "Do not know how to serialize a BigInt" and the
    // connection dies. We RACE the call against a short timeout so a server-side
    // crash surfaces here as a recorded FAIL instead of taking down the process
    // before ##RESULT## prints. Expected (correct) behavior would be a clean
    // rejection with code E_BIG; anything else is the bug.
    await check('MyError BigInt data -> clean reject (FINDING)',
        () => Promise.race([
            api.throwBigErr().then(() => 'resolved', (e: any) => 'rejected:' + e?.code),
            delay(800).then(() => 'no-response(connection-killed)'),
        ]),
        'rejected:E_BIG')

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
