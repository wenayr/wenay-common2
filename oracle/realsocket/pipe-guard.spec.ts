// ============================================================
//  oracle/realsocket/pipe-guard.spec.ts — REAL-SOCKET oracle for the two
//  route-resolution guards in rpc-server.ts.
//
//  Guard 1 — PIPE steps pass the same isSafeKey filter as the path in `ref`.
//    Without it `[{get:'constructor'},{call:[src]},{call:[]}]` starting from
//    fn.bind(ctx) compiles and runs arbitrary source inside the server process.
//  Guard 2 — the string-path fallback resolves OWN members only. `in` walked the
//    prototype chain while the schema is built from Object.keys, so every
//    Object.prototype member (and every prototype method of a class-shaped facade)
//    was callable without ever being indexed. doc/RPC-AUTH.md Rule 3 depends on it.
//
//  Two layers on purpose:
//    • RAW WIRE — a bare socket.io client emitting Pkt.PIPE / Pkt.CALL frames the
//      official client would never build (non-object step, unknown type, non-array
//      args). Only this layer can reach the guard's edges.
//    • REAL CLIENT — createRpcClientHub over the same port, proving legitimate
//      traffic is untouched, including bulk rich-type payloads through multi-stage
//      chains, binary, and callbacks used as pipe call arguments.
//
//  Binary envelope (measured here, not assumed). Two facts, both pinned in §6/§8:
//    • the DEFAULT socket.io parser drops the connection with "parse error" at the
//      11th binary attachment in ONE packet — 10 is the last count that survives.
//      Reproduced with bare socket.io and no RPC layer in the path, so the ceiling
//      is the parser's, not this library's. Bulk cases below stay under it.
//    • socket.io-msgpack-parser carries 200 of the same buffers, bytes intact, but
//      does not preserve the carrier type: a Uint8Array arrives as a bare
//      ArrayBuffer (a Buffer still arrives as Buffer). Consumers that branch on
//      ArrayBuffer.isView must normalise.
// ============================================================
import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import msgpackParser from 'socket.io-msgpack-parser'
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {Pkt} from '../../src/Common/rcp/rpc-protocol'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import {noStrict} from '../../src/Common/rcp/rpc-dynamic'
import {listen as createListenPair} from '../../src/Common/events/Listen'

const PORT_PLAIN = 4130   // plain closure-factory facade (the project's normal shape)
const PORT_CLASS = 4131   // class instance: methods live on the prototype
const PORT_MSGPACK = 4132 // same facade, msgpack parser — binary attachment ceiling

// last binary-attachment count the default socket.io parser survives in one packet
const DEFAULT_PARSER_BINARY_MAX = 10

// ===================================================================
// rich-value fingerprint — distinguishes what JSON.stringify would flatten
// ===================================================================
// Date vs number, Map vs object, Set vs array, BigInt vs string, RegExp, binary.
// Both sides of the wire run this, so a mismatch means the codec lost something.
function fp(v: any): string {
    if (v === null) return 'null'
    if (v === undefined) return 'undef'
    if (typeof v == 'bigint') return 'big:' + v.toString()
    if (v instanceof Date) return 'date:' + v.valueOf()
    if (v instanceof RegExp) return 're:' + v.source + '/' + v.flags
    if (v instanceof Map) return 'map{' + [...v.entries()].map(([k, x]) => fp(k) + '=>' + fp(x)).join(',') + '}'
    if (v instanceof Set) return 'set{' + [...v.values()].map(fp).join(',') + '}'
    // Bytes are compared by content, not by carrier type: the default parser hands
    // every binary leaf back as Buffer, msgpack hands a Uint8Array back as a bare
    // ArrayBuffer. Both are the same bytes; the carrier difference is asserted
    // separately in section 8 rather than smuggled into every payload comparison.
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        const b = v instanceof ArrayBuffer
            ? new Uint8Array(v)
            : new Uint8Array((v as any).buffer, (v as any).byteOffset, (v as any).byteLength)
        let acc = 0
        for (let i = 0; i < b.length; i++) acc = (acc * 31 + b[i]) >>> 0
        return 'bin:' + b.length + ':' + acc
    }
    if (Array.isArray(v)) return '[' + v.map(fp).join(',') + ']'
    if (typeof v == 'object') return '{' + Object.keys(v).sort().map(k => k + ':' + fp(v[k])).join(',') + '}'
    return typeof v + ':' + String(v)
}

// Deterministic rich records; the same generator runs on both sides.
// binEvery = 0 keeps the payload binary-free so bulk counts are not bounded by the
// parser's attachment ceiling; binEvery = N attaches a buffer to every Nth record.
function makeRecords(count: number, seed: number, binEvery = 0) {
    const out: any[] = []
    for (let i = 0; i < count; i++) {
        const n = i + seed
        const rec: any = {
            id: i,
            label: 'row-' + n,
            at: new Date(1700000000000 + n * 1000),
            live: (n & 1) == 0,
            ratio: n / 7,
            big: BigInt(n) * 1000000007n,
            tags: new Set([n % 5, n % 9]),
            meta: new Map<string, any>([
                ['seq', n],
                ['deep', {path: ['a', 'b', n], when: new Date(1600000000000 + n)}],
            ]),
            re: /ab+c/gi,
        }
        if (binEvery > 0 && i % binEvery == 0) rec.bin = new Uint8Array([n & 255, (n >> 8) & 255, 7, 42])
        out.push(rec)
    }
    return out
}

// ===================================================================
// facades
// ===================================================================
// stageRuns counts every chain stage that ACTUALLY executed. A rejected chain must
// leave it at zero — that is the observable proving the whole chain is refused up
// front rather than per step during the walk.
let stageRuns = 0

function makePlainObject() {
    function makeSet(rows: any[]): any {
        return {
            rows,
            count: rows.length,
            sum: () => fp(rows),
            filter: (minId: number) => { stageRuns++; return makeSet(rows.filter(r => r.id >= minId)) },
            enrich: (extra: Map<string, any>) => {
                stageRuns++
                return makeSet(rows.map(r => ({...r, meta: new Map([...r.meta, ...extra])})))
            },
        }
    }
    return {
        // --- chain entry points ---
        dataset(seed: number) { stageRuns++; return makeSet(makeRecords(600, seed)) },
        binarySet(seed: number) { stageRuns++; return makeSet(makeRecords(100, seed, 20)) },
        blob(size: number) {
            stageRuns++
            const bytes = new Uint8Array(size)
            for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 255
            return {bytes, size}
        },
        blobs(count: number) {
            stageRuns++
            return {list: Array.from({length: count}, (_, i) => new Uint8Array([i & 255, 1, 2, 3]))}
        },
        // callbacks handed in as a PIPE call argument: the stage invokes them before returning
        stream(onTick: (n: number, at: Date, payload: Map<string, any>) => void, ticks: number) {
            stageRuns++
            for (let i = 0; i < ticks; i++) {
                onTick(i, new Date(1500000000000 + i), new Map<string, any>([['i', BigInt(i)]]))
            }
            return {ticks}
        },
        // --- trace control ---
        resetTrace() { stageRuns = 0; return true },
        readTrace() { return stageRuns },
        // --- plain CALL lane, for the guard-did-not-touch-normal-traffic checks ---
        echoRich(rows: any[]) { return fp(rows) },
        ownMethod() { return 'own' },
        // --- dynamic subtree: the application resolves it, and the schema describes
        // nothing below it (transformTree stops here, serialize marks it "dynamic",
        // buildDispatch does not descend). Own-only resolution must NOT apply inside it
        // or the documented dynamic surface dies — including keys containing dots, which
        // arrive as ONE path segment.
        dyn: noStrict(new Proxy({}, {
            has: (_t, p) => typeof p == 'string',
            get: (_t, p) => p === 'run'
                ? () => 'dynamic-ran'
                : new Proxy({}, {
                    has: (_t2, q) => typeof q == 'string',
                    get: (_t2, q) => q === 'run' ? () => 'dynamic-nested:' + String(p) : undefined,
                }),
        })),
    }
}

// class-shaped facade: `secret` sits on the prototype, `visible` is an own member.
// Object.keys never sees `secret`, so it was never in routeMap — only the string-path
// fallback could reach it, and only because `in` walked the prototype chain.
class ClassFacade {
    visible = () => 'own-arrow'
    secret() { return 'PROTOTYPE-REACHED' }
    nested = {deep: () => 'own-nested'}
    // own property whose VALUE inherits its member — the mid-path case: `bag` is own,
    // `inherited` is not. Object.keys(bag) is empty, so it never entered routeMap and
    // only the fallback could resolve it.
    bag = Object.create({inherited: () => 'INHERITED-VIA-PROTO'})
}

// ===================================================================
// msgpack pair — same RPC layers, different socket.io parser
// ===================================================================
// _rs.ts intentionally has no parser knob (it is the shared harness for ~20 specs),
// so this spec wires its own pair rather than widening it for one case.
async function startMsgpackPair(port: number) {
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8, parser: msgpackParser as any})
    ioServer.on('connection', socket => {
        const [disconnect, disconnectListen] = createListenPair()
        socket.on('disconnect', () => disconnect())
        const adapter = {
            emit: (key: string, data: any) => socket.emit(key, data),
            on: (key: string, cb: any) => socket.on(key, cb),
        }
        createRpcServerAuto({socket: adapter, socketKey: 'rpc', object: makePlainObject(), disconnectListen})
    })
    await new Promise<void>(resolve => { httpServer.listen(port, resolve) })

    const hub = createRpcClientHub(
        () => io(`http://localhost:${port}`, {transports: ['websocket'], forceNew: true, parser: msgpackParser as any}),
        (r) => ({api: r<any>('rpc')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.api.readyStrict()
    return {
        api: clients.api.func as any,
        pipe: clients.api.pipe as any,
        close: async () => {
            hub.socket?.disconnect?.()
            ioServer.close()
            await new Promise<void>(resolve => httpServer.close(() => resolve()))
        },
    }
}

// ===================================================================
// raw wire client — frames the official client would never build
// ===================================================================
async function openRaw(port: number, key = 'rpc') {
    const sock = io(`http://localhost:${port}`, {transports: ['websocket'], forceNew: true})
    await new Promise<void>(resolve => { sock.on('connect', () => resolve()) })
    let seq = 0
    const waiters = new Map<number, (m: any[]) => void>()

    function deliver(msg: any) {
        if (!Array.isArray(msg)) return
        // a batching peer would wrap responses; this client advertises no caps, but
        // unwrapping keeps the oracle honest if that ever changes
        if (msg[0] === Pkt.BATCH && Array.isArray(msg[1])) { for (const m of msg[1]) deliver(m); return }
        if (msg[0] !== Pkt.RESP) return
        const waiter = waiters.get(msg[1])
        if (waiter) { waiters.delete(msg[1]); waiter(msg) }
    }
    sock.on(key, deliver)

    function roundTrip(build: (reqId: number) => any[]) {
        const reqId = ++seq
        const answer = new Promise<any[]>((resolve, reject) => {
            waiters.set(reqId, resolve)
            setTimeout(() => { if (waiters.delete(reqId)) reject(new Error('no RESP for req ' + reqId)) }, 5000)
        })
        sock.emit(key, build(reqId))
        return answer
    }

    return {
        // resolved value, or the string 'ERR:<message>' — one shape keeps assertions flat
        async pipe(ref: any, steps: any[]) {
            const msg = await roundTrip(reqId => [Pkt.PIPE, reqId, ref, steps, true])
            return msg.length > 3 ? 'ERR:' + String(msg[3]?.message ?? msg[3]) : msg[2]
        },
        async call(ref: any, args: any[]) {
            const msg = await roundTrip(reqId => [Pkt.CALL, reqId, ref, args, true])
            return msg.length > 3 ? 'ERR:' + String(msg[3]?.message ?? msg[3]) : msg[2]
        },
        // fire-and-forget: nothing comes back, the only observable is the side effect
        fireAndForget(ref: any, steps: any[]) { sock.emit(key, [Pkt.PIPE, 0, ref, steps, false]) },
        close: () => sock.disconnect(),
    }
}

const startsWith = (v: any, prefix: string) => typeof v == 'string' && v.startsWith(prefix) ? prefix : v

async function main() {
    const {check, done} = makeChecker('pipe-guard')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 120000)

    const srvPlain = await startRealServer({port: PORT_PLAIN, makeObject: makePlainObject})
    const srvClass = await startRealServer({port: PORT_CLASS, makeObject: () => new ClassFacade()})
    const raw = await openRaw(PORT_PLAIN)
    const rawClass = await openRaw(PORT_CLASS)
    const cli = await startRealClient({port: PORT_PLAIN})
    const P = cli.client.pipe as any
    const api = cli.api

    await delay(30)

    // ===============================================================
    // 1. The exploit itself — the chain that executed arbitrary code
    // ===============================================================
    // Mechanism control first: the same three steps applied locally to a bound
    // function DO reach code execution. Without this the blocked-chain assertions
    // below could pass against a primitive that never worked.
    await check('control: constructor→call→call is a real primitive locally', () => {
        const bound = (function target() { return 0 }).bind(null)
        const Fn = (bound as any)['constructor']
        return Fn('return 40 + 2')()
    }, 42)

    await check('constructor step is refused', async () => {
        const r = await raw.pipe(['dataset'], [
            {type: 'get', prop: 'constructor'},
            {type: 'call', args: ['return 40 + 2']},
            {type: 'call', args: []},
        ])
        return startsWith(r, 'ERR:pipe step 0: forbidden path segment')
    }, 'ERR:pipe step 0: forbidden path segment')

    // the same escape reached from a value the application returned, not from the
    // bound method — a legitimate first stage followed by the gadget
    await check('constructor refused mid-chain, after a legal call stage', async () => {
        const r = await raw.pipe(['dataset'], [
            {type: 'call', args: [1]},
            {type: 'get', prop: 'rows'},
            {type: 'get', prop: 'constructor'},
            {type: 'call', args: ['return 7']},
            {type: 'call', args: []},
        ])
        return startsWith(r, 'ERR:pipe step 2: forbidden path segment')
    }, 'ERR:pipe step 2: forbidden path segment')

    await check('__proto__ step is refused', async () => {
        const r = await raw.pipe(['dataset'], [{type: 'get', prop: '__proto__'}])
        return startsWith(r, 'ERR:pipe step 0: forbidden path segment')
    }, 'ERR:pipe step 0: forbidden path segment')

    await check('prototype step is refused', async () => {
        const r = await raw.pipe(['dataset'], [{type: 'get', prop: 'prototype'}])
        return startsWith(r, 'ERR:pipe step 0: forbidden path segment')
    }, 'ERR:pipe step 0: forbidden path segment')

    // ===============================================================
    // 2. The whole chain is refused BEFORE anything runs
    // ===============================================================
    await check('reset trace', () => api.resetTrace(), true)
    await check('rejected chain executed no stage (trace stays 0)', async () => {
        await raw.pipe(['dataset'], [
            {type: 'call', args: [5]},                    // would bump the counter
            {type: 'call', args: []},
            {type: 'get', prop: 'constructor'},           // rejected — so nothing above ran
        ])
        return api.readTrace()
    }, 0)

    // fire-and-forget carries no response, so the side effect is the ONLY observable
    await check('fire-and-forget bad chain runs nothing', async () => {
        raw.fireAndForget(['dataset'], [
            {type: 'call', args: [5]},
            {type: 'get', prop: 'constructor'},
        ])
        await delay(120)
        return api.readTrace()
    }, 0)

    // and the same chain minus the bad step DOES run — proves the counter can move
    await check('control: same chain without the bad step does run', async () => {
        await raw.pipe(['dataset'], [{type: 'call', args: [5]}, {type: 'get', prop: 'count'}])
        return api.readTrace()
    }, 1)

    // ===============================================================
    // 3. Malformed step shapes the official client cannot produce
    // ===============================================================
    await check('non-object step refused', async () => {
        const r = await raw.pipe(['dataset'], ['not-a-step'])
        return startsWith(r, 'ERR:pipe step 0: not an object')
    }, 'ERR:pipe step 0: not an object')

    await check('null step refused', async () => {
        const r = await raw.pipe(['dataset'], [null])
        return startsWith(r, 'ERR:pipe step 0: not an object')
    }, 'ERR:pipe step 0: not an object')

    await check('array step refused', async () => {
        const r = await raw.pipe(['dataset'], [['get', 'constructor']])
        return startsWith(r, 'ERR:pipe step 0: not an object')
    }, 'ERR:pipe step 0: not an object')

    await check('unknown step type refused', async () => {
        const r = await raw.pipe(['dataset'], [{type: 'delete', prop: 'rows'}])
        return startsWith(r, 'ERR:pipe step 0: unknown step type')
    }, 'ERR:pipe step 0: unknown step type')

    await check('non-string get prop refused', async () => {
        const r = await raw.pipe(['dataset'], [{type: 'get', prop: 5}])
        return startsWith(r, 'ERR:pipe step 0: get prop must be a string')
    }, 'ERR:pipe step 0: get prop must be a string')

    await check('non-array call args refused', async () => {
        const r = await raw.pipe(['dataset'], [{type: 'call', args: {0: 1}}])
        return startsWith(r, 'ERR:pipe step 0: call args must be an array')
    }, 'ERR:pipe step 0: call args must be an array')

    // ===============================================================
    // 4. String-path fallback resolves OWN members only
    // ===============================================================
    await check('Object.prototype member is not callable', async () => {
        const r = await rawClass.call(['hasOwnProperty'], ['visible'])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    await check('__defineGetter__ is not callable', async () => {
        const r = await rawClass.call(['__defineGetter__'], ['x'])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    await check('toString is not callable', async () => {
        const r = await rawClass.call(['toString'], [])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    await check('class prototype method is not reachable', async () => {
        const r = await rawClass.call(['secret'], [])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    await check('own arrow member still reachable', () => rawClass.call(['visible'], []), 'own-arrow')
    await check('own nested member still reachable', () => rawClass.call(['nested', 'deep'], []), 'own-nested')
    await check('own member on plain facade still reachable', () => raw.call(['ownMethod'], []), 'own')

    // Object.prototype must stay unreachable on the plain facade too, not only the class one
    await check('toString on the plain facade is not callable', async () => {
        const r = await raw.call(['toString'], [])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    // --- the documented exception: a noStrict subtree answers `in` from its own trap ---
    await check('dynamic subtree: direct member resolves', () => raw.call(['dyn', 'run'], []), 'dynamic-ran')

    await check('dynamic subtree: dotted key is one segment and still resolves', () =>
        raw.call(['dyn', 'my.strategy.2020', 'run'], []), 'dynamic-nested:my.strategy.2020')

    await check('dynamic subtree: arbitrary depth still resolves', () =>
        raw.call(['dyn', 'anything', 'run'], []), 'dynamic-nested:anything')

    // the dynamic opt-in does not lift the path filter
    await check('dynamic subtree does not lift the isSafeKey filter', async () => {
        const r = await raw.call(['dyn', 'constructor', 'run'], [])
        return startsWith(r, 'ERR:Forbidden path segment')
    }, 'ERR:Forbidden path segment')

    // mid-path: `bag` is an own member, `inherited` lives on bag's prototype. The walk
    // over intermediate segments must refuse it too, not only the final one.
    await check('inherited member under an own segment is not reachable', async () => {
        const r = await rawClass.call(['bag', 'inherited'], [])
        return startsWith(r, 'ERR:Not a function')
    }, 'ERR:Not a function')

    // the pre-existing ref filter still covers banned names in the path itself
    await check('banned segment in the path is still refused', async () => {
        const r = await rawClass.call(['__proto__', 'secret'], [])
        return startsWith(r, 'ERR:Forbidden path segment')
    }, 'ERR:Forbidden path segment')

    // ===============================================================
    // 5. Legitimate PIPE traffic is untouched — complex rich payloads
    // ===============================================================
    const extra = new Map<string, any>([
        ['tag', 'enriched'],
        ['stamp', new Date(1650000000000)],
        ['nested', new Map<string, any>([['k', new Set([1, 2, 3])]])],
    ])
    const enrichLocal = (rows: any[]) => rows.map(r => ({...r, meta: new Map([...r.meta, ...extra])}))
    const expectedBulk = enrichLocal(makeRecords(600, 7).filter(r => r.id >= 500))

    await check('3-stage chain over 600 rich records: count', () =>
        P.dataset(7).filter(500).enrich(extra).count, 100)

    // fingerprint computed ON THE SERVER after three stages — the rich Map argument
    // crossed the wire INTO a call stage and was applied there
    await check('3-stage chain: server-side fingerprint matches locally computed', () =>
        P.dataset(7).filter(500).enrich(extra).sum(), fp(expectedBulk))

    // the same 100 records pulled back whole and fingerprinted on the CLIENT —
    // Date / Map / Set / BigInt / RegExp survive both directions
    await check('3-stage chain: full rich payload round-trips identical', async () => {
        const rows = await P.dataset(7).filter(500).enrich(extra).rows
        return fp(rows)
    }, fp(expectedBulk))

    // without the argument the fingerprint must differ — proves the Map was not silently dropped
    await check('rich Map argument actually reached the enrich stage', async () => {
        const plain = await P.dataset(7).filter(500).sum()
        const rich = await P.dataset(7).filter(500).enrich(extra).sum()
        return plain === rich ? 'argument-was-lost' : 'argument-applied'
    }, 'argument-applied')

    // ===============================================================
    // 6. Binary through a chain, inside the default-parser envelope
    // ===============================================================
    const expectedBinary = enrichLocal(makeRecords(100, 3, 20).filter(r => r.id >= 20))
    const binaryLeaves = expectedBinary.filter(r => r.bin).length

    await check('binary payload stays inside the measured parser envelope', () =>
        binaryLeaves <= DEFAULT_PARSER_BINARY_MAX, true)

    await check('records carrying binary round-trip through a 2-stage chain', async () => {
        const rows = await P.binarySet(3).filter(20).enrich(extra).rows
        return fp(rows)
    }, fp(expectedBinary))

    await check('256 KiB single blob through a pipe get', async () => {
        const bytes = await P.blob(262144).bytes
        const expect = new Uint8Array(262144)
        for (let i = 0; i < expect.length; i++) expect[i] = (i * 7 + 13) & 255
        return fp(bytes) === fp(expect) ? 'identical' : 'differs'
    }, 'identical')

    await check(`${DEFAULT_PARSER_BINARY_MAX} binary leaves in one packet survive`, async () => {
        const list = await P.blobs(DEFAULT_PARSER_BINARY_MAX).list
        return fp(list)
    }, fp(Array.from({length: DEFAULT_PARSER_BINARY_MAX}, (_, i) => new Uint8Array([i & 255, 1, 2, 3]))))

    await check('callback as a pipe call argument receives rich args', async () => {
        const seen: string[] = []
        const ticks = await P.stream((n: number, at: Date, payload: Map<string, any>) => {
            seen.push(`${n}|${at instanceof Date ? at.valueOf() : 'NOT-DATE'}|${payload instanceof Map ? String(payload.get('i')) : 'NOT-MAP'}`)
        }, 5).ticks
        await delay(60)
        return `${ticks}:${seen.join(';')}`
    }, '5:0|1500000000000|0;1|1500000000001|1;2|1500000000002|2;3|1500000000003|3;4|1500000000004|4')

    // ===============================================================
    // 7. The ordinary CALL lane is unaffected by the pipe guard
    // ===============================================================
    await check('plain CALL with 600 rich records still round-trips', () =>
        api.echoRich(makeRecords(600, 3)), fp(makeRecords(600, 3)))

    await check('plain CALL is not subject to pipe step validation', () =>
        raw.call(['echoRich'], [[]]), fp([]))

    // ===============================================================
    // 8. The binary ceiling is the PARSER, not this library
    // ===============================================================
    // Same RPC layers, same facade, same buffers — only the socket.io parser differs.
    // If this ever fails, the ceiling moved and the note at the top of this file is stale.
    const mp = await startMsgpackPair(PORT_MSGPACK)
    await check('msgpack parser carries 200 binary leaves in one packet', async () => {
        const list = await mp.pipe.blobs(200).list
        return fp(list)
    }, fp(Array.from({length: 200}, (_, i) => new Uint8Array([i & 255, 1, 2, 3]))))

    await check('msgpack parser carries the same rich payload', () =>
        mp.pipe.dataset(7).filter(500).enrich(extra).sum(), fp(expectedBulk))

    // Carrier type, not bytes: pinned because doc/wenay-common2-rare.md promises
    // "TypedArray/ArrayBuffer leaves pass through natively" and under msgpack a
    // Uint8Array stops being a view. Bytes survive either way (checked above).
    await check('default parser hands a Uint8Array back as a view', async () => {
        const bytes = await P.blob(8).bytes
        return ArrayBuffer.isView(bytes) ? 'view' : bytes instanceof ArrayBuffer ? 'raw-arraybuffer' : 'other'
    }, 'view')

    await check('msgpack parser hands the same Uint8Array back as a bare ArrayBuffer', async () => {
        const bytes = await mp.pipe.blob(8).bytes
        return ArrayBuffer.isView(bytes) ? 'view' : bytes instanceof ArrayBuffer ? 'raw-arraybuffer' : 'other'
    }, 'raw-arraybuffer')

    clearTimeout(watchdog)
    raw.close(); rawClass.close(); cli.close()
    await mp.close()
    await srvPlain.close(); await srvClass.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
