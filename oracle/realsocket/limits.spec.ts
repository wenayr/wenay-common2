// ============================================================
//  oracle/realsocket/limits.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY: limits — server-side incoming payload caps (serverOpts.limits).
//
//  The server resolves limits via resolveLimits(serverOpts.limits) and runs
//  every incoming CALL's args through unpack(..., lim). A violation throws a
//  PayloadLimitError (rpc-limits.ts), which the CALL try/catch sends back as a
//  Pkt.RESP error → the client promise rejects with an Error whose name is
//  "PayloadLimitError" and message "Payload limit exceeded: <reason>".
//  Under-limit calls of the same method round-trip normally.
//
//  Direction note: the configurable cap on a real socket goes through
//  serverOpts.limits → INCOMING (client→server) only. The client-side response
//  cap (unpackResult lim) is opt-in via the client `limits` option, which the
//  shared substrate (startRealClient) does not expose — so we exercise the
//  incoming direction, covering several distinct limit dimensions.
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'

const PORT = 4109

// echo bounces its single arg straight back; sink takes many args and reports count.
function makeObject() {
    return {
        echo: (x: any) => x,
        sink: (...xs: any[]) => xs.length,
    }
}

// classify a call as 'ok'(+value) / 'limit'(PayloadLimitError) / 'other'(unexpected reject)
async function verdict(p: Promise<any>) {
    try {
        const v = await p
        return {tag: 'ok', value: v}
    } catch (e: any) {
        const name = e?.name
        const msg = String(e?.message ?? e)
        if (name == 'PayloadLimitError' || /Payload limit exceeded/.test(msg)) return {tag: 'limit'}
        return {tag: 'other', error: msg}
    }
}

async function main() {
    const {check, done} = makeChecker('limits')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 40000)

    // Tight incoming caps. Defaults (rpc-limits.ts) are huge; we shrink several
    // dimensions so each is easy to cross with a deliberately oversized payload.
    const limits = {
        maxArgs: 3,
        maxStringLen: 10,
        maxDepth: 4,
        maxKeys: 5,
        maxArrayLen: 4,
    }

    const srv = await startRealServer({port: PORT, makeObject, serverOpts: {limits}})
    const cli = await startRealClient({port: PORT})
    const api = cli.api
    await delay(30) // let the strict handshake settle over the real socket

    // ---- sanity: a plainly under-limit call works end-to-end ----
    await check('under-limit echo round-trips', () => api.echo('short'), 'short')

    // ===== maxArgs (incoming) =====
    await check('maxArgs: 3 args ok (count)', () => api.sink(1, 2, 3), 3)
    await check('maxArgs: 4 args -> limit', async () => (await verdict(api.sink(1, 2, 3, 4))).tag, 'limit')

    // ===== maxStringLen (incoming) =====
    await check('maxStringLen: 10-char ok', () => api.echo('0123456789'), '0123456789')
    await check('maxStringLen: 11-char -> limit', async () => (await verdict(api.echo('0123456789X'))).tag, 'limit')

    // ===== maxDepth (incoming) =====
    // depth counted by walk(): each nested object level is +1. {a:{b:{c:{d:1}}}} = depth 4 → ok; +1 level → limit.
    await check('maxDepth: depth 4 ok', () => api.echo({a: {b: {c: {d: 1}}}}), {a: {b: {c: {d: 1}}}})
    await check('maxDepth: depth 6 -> limit', async () =>
        (await verdict(api.echo({a: {b: {c: {d: {e: {f: 1}}}}}}))).tag, 'limit')

    // ===== maxKeys (incoming) =====
    await check('maxKeys: 5 keys ok', () => api.echo({a: 1, b: 2, c: 3, d: 4, e: 5}), {a: 1, b: 2, c: 3, d: 4, e: 5})
    await check('maxKeys: 6 keys -> limit', async () =>
        (await verdict(api.echo({a: 1, b: 2, c: 3, d: 4, e: 5, f: 6}))).tag, 'limit')

    // ===== maxArrayLen (incoming) =====
    await check('maxArrayLen: len 4 ok', () => api.echo([1, 2, 3, 4]), [1, 2, 3, 4])
    await check('maxArrayLen: len 5 -> limit', async () => (await verdict(api.echo([1, 2, 3, 4, 5]))).tag, 'limit')

    // ===== rejection carries the typed error shape (name + message) =====
    await check('over-limit rejects, under-limit still works after', async () => {
        const over = await verdict(api.echo('this-is-way-too-long'))
        const under = await api.echo('ok')
        return [over.tag, under]
    }, ['limit', 'ok'])

    clearTimeout(watchdog); cli.close(); await srv.close(); process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
