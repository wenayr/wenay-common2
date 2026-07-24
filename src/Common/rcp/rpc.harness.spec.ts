// ===========================================================================
// RPC HARNESS — real test environment for rcp core (this is GATE from PLAN / II-1).
//
// Runs a real client + real server in one process via in-memory loopback transport
// (emit from one end → on the other) and tests both channels:
//   • CALL  — request/response (client.func.method(args) → Promise result);
//   • CB    — server→client callbacks/streams (function in args = second channel);
//   • PIPE  — server-side chains (client.pipe.method().chain.value).
// Plus round-trip rich types (Date / Map / BigInt) in both directions and error propagation.
//
// Why: rcp core cannot be tested by reading — bugs live in round-trip client↔server.
// With this harness, rcp fixes (pack-in-pipe, client-limits, walk:47, errToObj/MyError,
// auto/hub) can be applied confidently: add a failing case here → fix → green.
//
// TYPING — ALSO UNDER TEST. Client is typed with the real server form
// (`createRpcClient<typeof serverObj>`), not `<any>`: then the COMPILER checks
// that both call signatures (args/return CALL/PIPE) and callback argument types
// and Listen-node subscription surface reach the wire. `check<T>` binds
// actual result to expected (`exp: NoInfer<T>`) — type mismatch fails to compile.
// Spot `as any` is retained ONLY where the test INTENTIONALLY bypasses
// the schema (off-schema path for maxPathLen). Where a value is `any` by contract
// (echo, authAck) — that is the library type, not hidden typing.
//
// Run:   node node_modules/ts-node/dist/bin.js --transpile-only src/Common/rcp/rpc.harness.spec.ts
// Excluded from build (*.spec.ts in tsconfig.exclude) — does NOT reach published lib.
// ===========================================================================

import { createRpcServer } from "./rpc-server"
import { createRpcClient, type RpcClientReturn } from "./rpc-client"
import { createRpcServerAuto } from "./rpc-server-auto"
import { createRpcServerAutoDetect } from "./createRpcServerAutoWithProtocolDetection"
import { createRpcClientHub } from "./rpc-clientHub"
import { listen as createListenPair, isListenOn, getListenByOn } from "../events/Listen"
import { replayListen, exposeReplay, replaySubscribe } from "../events/replay-index"
import { mapListen } from "../events/mapListen"
import { joinListens } from "../events/joinListens"
import { noStrict } from "./rpc-dynamic"
import { Pkt, IS_RPC_LISTEN, type SocketTmpl } from "./rpc-protocol"
import { rpcPathKey } from "./rpc-path"
import { getRpcMemberState, getRpcTransportLifecycle, RPC_TRANSPORT_CONTROL } from "../events/transport-lifecycle"
import type { DeepSocketListen } from "./listen-deep"
import { MyError } from "../../toError/myThrow"
import { createStore, createStoreMirror, exposeStore, exposeStoreReplay, flushReactive, syncStoreReplay } from "../Observe"
import {runRpcCallbackBatchTests} from './rpc-callback-batch.spec'
import {runRpcBinaryCodecTests} from './rpc-binary-codec.spec'
import {runRpcBinarySchemaIntegrationTests} from './rpc-binary-schema-integration.spec'
import {runRpcBinarySchemaTests} from './rpc-binary-schema.spec'
import {runRpcBinaryTests} from './rpc-binary.spec'
import {runRpcBinaryCompatTests} from './rpc-binary-compat.spec'

// --- loopback: emit from one end delivers to on of the other (async, like real socket) ---
// Each message goes through JSON clone: real transport serializes, and raw Date/Map/BigInt
// in payload break exactly as in production. Loopback by reference would mask such bugs.
function createLoopback(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)] // [client, server]
}

// --- Subscription projection of client proxy to server with Listen-nodes ---
// At runtime, the client projects server Listen-nodes into a subscription surface
// (`.callback`/`.on`/`.once` with value types + callable off()-handle) — exactly like
// (listen-deep / createRpcClientAuto. Statically this CANNOT be inferred from ClientAPIAll
// ((callback would become Promise<never>: DeepDataOnly<Function> = never), so
// declare the live contract explicitly. T is taken from the client itself → value types come
// from the REAL server form (test of callback-channel typing propagation).
function webListen<T extends object>(c: RpcClientReturn<T>) {
    return c.func as unknown as DeepSocketListen<T>
}

// --- comparison with Date/Map/BigInt support ---
function eq(a: any, b: any): boolean {
    if (a === b) return true
    if (typeof a === "bigint" || typeof b === "bigint") return a === b
    if (a instanceof Date && b instanceof Date) return a.valueOf() === b.valueOf()
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false
        for (const [k, v] of a) if (!eq(v, b.get(k))) return false
        return true
    }
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => eq(v, b[i]))
    if (a && b && typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a), kb = Object.keys(b)
        return ka.length === kb.length && ka.every(k => eq(a[k], b[k]))
    }
    return false
}

const delay = (ms = 0) => new Promise(r => setTimeout(r, ms))

function proxyRejectingSymbolGet<T extends object>(target: T, stats = { symbolGets: 0, stringGets: 0 }): T {
    return new Proxy(target, {
        get(t, k, r) {
            if (typeof k != "string") {
                stats.symbolGets++
                throw new TypeError("Cannot convert a symbol to a string")
            }
            stats.stringGets++
            return Reflect.get(t, k, r)
        },
    })
}

export async function runHarness() {
    let fails = 0
    const fmt = (v: any) => v instanceof Date ? `Date(${v.valueOf()})` : v instanceof Map ? `Map(${[...v]})` : typeof v === "bigint" ? `${v}n` : JSON.stringify(v)
    // check<T>: expected type is BOUND to actual run() result (exp: NoInfer<T>) —
    // if the wrong type reaches the wire, file won't compile. Where run() returns any
    // (echo/auth) there are no restrictions — this is the library contract.
    async function check<T>(name: string, run: () => T | Promise<T>, exp: NoInfer<T>) {
        try {
            const got = await run()
            const ok = eq(got, exp)
            if (!ok) fails++
            console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} got=${fmt(got)}  exp=${fmt(exp)}`)
        } catch (e: any) {
            fails++
            console.log(`FAIL  ${name.padEnd(34)} threw: ${e?.message ?? e}`)
        }
    }

    const streamed: number[] = []
    type tBox = { value: number; add: (m: number) => tBox } // recursive type for PIPE chain
    const serverObj = {
        add: (a: number, b: number) => a + b,
        echo: (x: any) => x,
        throwErr: () => { throw new Error("boom") },
        throwMyErr: () => { throw new MyError("payload", "E_TEST", { x: 1 }) },
        stream: (n: number, cb: (i: number) => void) => { for (let i = 0; i < n; i++) cb(i); return "done" },
        streamRich: (cb: (d: Date, m: Map<string, number>) => void) => { cb(new Date(777), new Map([["k", 1]])); return "ok" },
        nested: { mul: (a: number, b: number) => a * b },
        makeBox(n: number): tBox { return { value: n, add: (m: number) => serverObj.makeBox(n + m) } },
    }

    const [clientSocket, serverSocket] = createLoopback()
    // Client typed with server form → F.add(2,3): Promise<number>, F.streamRich(cb)
    // knows (d: Date, m: Map<...>), P.makeBox(n).add(m).value continues the chain — all under tsc.
    const c = createRpcClient<typeof serverObj>({ socket: clientSocket, socketKey: "rpc" })
    createRpcServer({ socket: serverSocket, object: serverObj, socketKey: "rpc" })
    await delay(0) // wait for MAP handshake to arrive
    const F = c.func
    const P = c.pipe

    console.log("--- CALL (запрос/ответ) ---")
    await check("add(2,3)", () => F.add(2, 3), 5)
    await check("nested.mul(6,7)", () => F.nested.mul(6, 7), 42)

    console.log("--- round-trip богатых типов (оба направления) ---")
    const d = new Date(1700000000000)
    await check("echo Date", () => F.echo(d), d)
    const m = new Map<string, any>([["a", 1], ["b", new Date(123)]])
    await check("echo Map", () => F.echo(m), m)
    await check("echo BigInt", () => F.echo(123456789012345n), 123456789012345n)
    await check("echo nested {date,map}", () => F.echo({ when: d, tags: m, n: 7 }), { when: d, tags: m, n: 7 })

    console.log("--- маркер-коллизия: объект с ключом-маркером не должен ломаться ---")
    // object whose FIRST key matches packing marker ($_d/$_f/...), but this is regular data:
    // previously walk treated it as a packed leaf by first key and lost other keys.
    await check("multi-key $_d preserved", () => F.echo({ $_d: 5, name: "x" }), { $_d: 5, name: "x" })
    await check("multi-key $_f preserved", () => F.echo({ $_f: 7, label: "y" }), { $_f: 7, label: "y" })
    await check("marker-key + nested Date", () => F.echo({ $_d: 5, when: new Date(123) }), { $_d: 5, when: new Date(123) })

    console.log("--- ошибки (server→client) ---")
    await check("throwErr -> message", () => F.throwErr().catch((e: any) => e?.message ?? e?.error?.message), "boom")
    await check("MyError: instance+code+data", () => F.throwMyErr().catch((e: any) => [e instanceof Error, e?.name, e?.code, e?.data?.x]), [true, "MyError", "E_TEST", 1])

    console.log("--- CB: server→client колбэки/стрим (второй канал) ---")
    await check("stream(3,cb) returns", () => F.stream(3, (i) => streamed.push(i)), "done")
    await delay(0)
    await check("stream collected [0,1,2]", async () => streamed, [0, 1, 2])
    // (d: Date, m: Map<string,number>) inferred FROM serverObj.streamRich signature — no annotations.
    const richCall: (Date | Map<string, number>)[] = []
    await check("CALL cb rich args returns", () => F.streamRich((d, m) => richCall.push(d, m)), "ok")
    await delay(0)
    await check("CALL cb got Date+Map", async () => richCall, [new Date(777), new Map([["k", 1]])])

    console.log("--- PIPE (серверные цепочки) ---")
    // .makeBox(n)/.add(m) are typed (PipeAPI stores method chain); reading a primitive leaf
    // .value is NOT modeled by PipeAPI (only functions/objects remain in chain) — spot as any.
    await check("pipe makeBox(10).value", () => (P.makeBox(10) as any).value, 10)
    await check("pipe makeBox(10).add(5).value", () => (P.makeBox(10).add(5) as any).value, 15)
    const richPipe: (Date | Map<string, number>)[] = []
    await check("PIPE cb rich args returns", () => P.streamRich((d, m) => richPipe.push(d, m)), "ok")
    await delay(0)
    await check("PIPE cb got Date+Map", async () => richPipe, [new Date(777), new Map([["k", 1]])])

    console.log("--- лимиты: сервер (maxArgs/maxPathLen), клиент (opt-in limits) ---")
    // separate pair: server with strict limits, client with opt-in limits on responses
    const [cs2, ss2] = createLoopback()
    const limServerObj = {
        echo: (x: any) => x,
        many: (...xs: number[]) => xs.length,
    }
    const c2 = createRpcClient<typeof limServerObj>({ socket: cs2, socketKey: "rpc", limits: { maxDepth: 3 } })
    createRpcServer({ socket: ss2, object: limServerObj, socketKey: "rpc", limits: { maxArgs: 2, maxPathLen: 3 } })
    await delay(0)
    const F2 = c2.func
    const verdict = (p: Promise<any>, re: RegExp) =>
        p.then(() => "accepted").catch((e) => re.test(e?.message) ? "rejected" : "other: " + (e?.message ?? e))

    await check("maxArgs: many(1,2) ok", () => F2.many(1, 2), 2)
    await check("maxArgs: many(1,2,3) rejected", () => verdict(F2.many(1, 2, 3), /too many args/), "rejected")
    // path bypassing routeMap (numeric ref limit is not bypassed — it's validated at handshake).
    // INTENTIONALLY off-schema path → one spot `as any` (no schema for such method, shouldn't be).
    await check("maxPathLen: 5-сегментный путь", () => verdict((F2 as any).q.w.e.r.t(), /path too long/), "rejected")
    await check("client lim: глубокий ответ отбит", () => verdict(F2.echo({ a: { b: { c: { d: { e: 1 } } } } }), /max depth/), "rejected")
    await check("client lim: мелкий ответ ok", () => F2.echo({ a: 1 }), { a: 1 })

    console.log("--- teardown: id-reuse / double-init / dispose ---")
    const slowObj = { slow: (v: string, ms: number) => new Promise<string>(r => setTimeout(() => r(v), ms)), add: (a: number, b: number) => a + b }

    { // id-reuse: cancelled request id is not returned to pool until its late RESP arrives
        const [cs, ss] = createLoopback()
        const c = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: slowObj, socketKey: "rpc" })
        await delay(0)
        const F = c.func
        const pOld = F.slow("old", 40).then(() => "resolved", () => "aborted")
        await delay(10) // request sent, server still thinking
        c.abortAll("test")
        const pNew = F.slow("new", 120) // if bug: takes same id → old RESP resolves as "old"
        await check("id-reuse: отменённый отбит", () => pOld, "aborted")
        await check("id-reuse: поздний RESP не угоняет новый", () => pNew, "new")
    }
    { // double-init server: last wins, side effects not duplicated
        const [cs, ss] = createLoopback()
        let hits = 0
        const obj = { hit: () => ++hits }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: obj, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: obj, socketKey: "rpc" }) // hot-reload / re-init
        await delay(0)
        await c.func.hit()
        await check("double-init server: вызов один", async () => hits, 1)
    }
    { // double-init client: shared id pool on socket+key — concurrent requests from two clients don't collide
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: slowObj, socketKey: "rpc" })
        const cA = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const pa = cA.func.slow("A", 20)
        const cB = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        const pb = cB.func.slow("B", 40) // if bug: takes id of first → RESP "A" resolves both
        await check("double-init client: первый получает своё", () => pa, "A")
        await check("double-init client: второй получает своё", () => pb, "B")
    }
    { // proxy-regression: createRpcServer does not read symbol via Proxy.get on root facade
        const [cs, ss] = createLoopback()
        const stats = { symbolGets: 0, stringGets: 0 }
        const api = proxyRejectingSymbolGet({ ping: () => "pong", nested: { add: (a: number, b: number) => a + b } }, stats)
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await check("proxy/root: прямой сервер вызывает метод", () => c.func.ping(), "pong")
        await check("proxy/root: nested метод жив", () => c.func.nested.add(2, 4), 6)
        await check("proxy/root: symbol-get не было", async () => stats.symbolGets, 0)
    }
    { // proxy-regression: createRpcServerAuto does not read symbol via Proxy.get on root facade
        const [cs, ss] = createLoopback()
        const stats = { symbolGets: 0, stringGets: 0 }
        const api = proxyRejectingSymbolGet({ ping: () => "pong", nested: { add: (a: number, b: number) => a + b } }, stats)
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await check("proxy/root-auto: вызывает метод", () => c.func.ping(), "pong")
        await check("proxy/root-auto: nested метод жив", () => c.func.nested.add(3, 4), 7)
        await check("proxy/root-auto: symbol-get не было", async () => stats.symbolGets, 0)
    }
    { // proxy-regression: nested Proxy next to Listen doesn't break MAP and subscriptions
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const stats = { symbolGets: 0, stringGets: 0 }
        const proxied = proxyRejectingSymbolGet({ ping: () => "pong" }, stats)
        const obj = { proxied, stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).stream.on((v) => got.push(v))
        await delay(10)
        emit(11)
        await delay(10)
        await check("proxy/nested-auto: обычный метод", () => c.func.proxied.ping(), "pong")
        await check("proxy/nested-auto: Listen работает", async () => got, [11])
        await check("proxy/nested-auto: symbol-get не было", async () => stats.symbolGets, 0)
    }
    { // proxy-regression: proxied own-marker IS_RPC_LISTEN is determined without Proxy.get(symbol)
        const [, ss] = createLoopback()
        const stats = { symbolGets: 0, stringGets: 0 }
        const marked: any = { callback: () => true }
        marked[IS_RPC_LISTEN] = true
        const obj = { stream: proxyRejectingSymbolGet(marked, stats) }
        let listenPaths: any[] | undefined
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.MAP) listenPaths = d[3]; origEmit(e, d) }
        createRpcServer({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        await check("proxy/marker: listen path объявлен", async () => listenPaths, [rpcPathKey(["stream"])])
        await check("proxy/marker: symbol-get не было", async () => stats.symbolGets, 0)
    }
    { // rpc-server-auto: second subscription to same Listen doesn't overwrite first
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c)
        const got1: number[] = [], got2: number[] = []
        L.stream.callback((v) => got1.push(v))
        await delay(10)
        L.stream.callback((v) => got2.push(v))
        await delay(10)
        emit(7)
        await delay(10)
        await check("server-auto: первый подписчик жив", async () => got1, [7])
        await check("server-auto: второй подписчик жив", async () => got2, [7])
    }
    { // rpc-server-auto: callback() without function doesn't create broken subscription
        const [cs, ss] = createLoopback()
        let wireSubs = 0
        const [emit, listen] = createListenPair<number>({ event: (_t, count) => { wireSubs = count } })
        const obj = { stream: listen }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c)
        const bad = (L.stream.callback as any)()
        const outcome = await Promise.race([
            Promise.resolve(bad).then(() => "resolved", (e: any) => e?.message ?? String(e)),
            delay(60).then(() => "hung"),
        ])
        await check("server-auto: callback без fn отвергнут", async () => outcome, "Listen callback expects a function")
        await check("server-auto: пустой callback не подписал", async () => wireSubs, 0)
        emit(9)
        await delay(10)
        await check("server-auto: emit после bad безопасен", async () => wireSubs, 0)
    }
    { // rpc-server-auto: custom Proxy may not support symbol keys in get()
        const [cs, ss] = createLoopback()
        const target = { ping: () => "pong" }
        const proxied = new Proxy(target, {
            get(t, k, r) {
                if (typeof k != "string") throw new TypeError("Cannot convert a symbol to a string")
                return Reflect.get(t, k, r)
            },
        })
        const obj = { proxied }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        await check("server-auto: Proxy без symbol-get", () => c.func.proxied.ping(), "pong")
    }
    { // dedup subscriptions: 1 network connection per client per Listen; unsubscribe via function; stats
        const [cs, ss] = createLoopback()
        let wireSubs = 0
        const [emit, listen] = createListenPair<number>({ event: (_t, count) => { wireSubs = count } })
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" }) // client listens BEFORE server MAP
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c)
        const got1: number[] = [], got2: number[] = []
        const s1 = L.stream.callback((v) => got1.push(v))
        await delay(10)
        const s2 = L.stream.callback((v) => got2.push(v))
        await delay(10)
        emit(5)
        await delay(10)
        await check("дедуп: оба потребителя получают", async () => [got1, got2], [[5], [5]])
        await check("дедуп: сетевая подписка ОДНА", async () => wireSubs, 1)
        await check("дедуп: stats потребителей", async () => c.api.subscriptions()[0]?.consumers, 2)
        s1.unsubscribe()
        emit(6)
        await delay(10)
        await check("unsubscribe: снят только первый", async () => [got1, got2], [[5], [5, 6]])
        await check("unsubscribe: сеть ещё жива", async () => wireSubs, 1)
        s2.unsubscribe()
        await delay(10)
        await check("последний ушёл: сетевая подписка снята", async () => wireSubs, 0)
        await check("stats пуст", async () => c.api.subscriptions().length, 0)
    }
    { // NOT-Listen method named `callback` should not be deduped (server declares Listen addresses in MAP)
        const [cs, ss] = createLoopback()
        let calls = 0
        const obj = { thing: { callback: (cb: (x: number) => void) => { calls++; cb(calls); return calls } } }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" }) // client listens BEFORE server MAP
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const r1: number[] = [], r2: number[] = []
        // this is ORDINARY CALL with callback arg (not subscription) — go via c.func, types reach wire:
        // thing.callback(cb): Promise<number>, cb knows (x: number). Concurrent, no await —
        // window where heuristic would wrongly share the call.
        const p1 = c.func.thing.callback((x) => r1.push(x))
        const p2 = c.func.thing.callback((x) => r2.push(x))
        await Promise.all([p1, p2])
        await delay(10)
        await check("не-Listen callback: два реальных вызова", async () => calls, 2)
        await check("не-Listen callback: каждому — своё", async () => [r1, r2], [[1], [2]])
    }
    { // numeric-ref vs string-path: both paths resolve one indexed method identically and share state.
      // string-path goes before MAP arrives (routeCache empty), numeric — after.
        const [cs, ss] = createLoopback()
        const stateful = { _n: 0, bump() { return ++this._n }, read() { return this._n } }
        const c = createRpcClient<typeof stateful>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: stateful, socketKey: "rpc" })
        const F = c.func
        const pStr = F.bump()       // routeCache empty → string ref ["bump"]
        await delay(0)              // MAP arrived → routeCache populated
        const pNum = F.bump()       // numeric ref
        await check("ref: string-path bump", () => pStr, 1)
        await check("ref: numeric-ref bump", () => pNum, 2)
        await check("ref: общее состояние (read)", () => F.read(), 2)
    }
    { // transient disconnect: ignored calls do not become process-level unhandled rejections
        const socket: SocketTmpl = {on: function onWire() {}, emit: function emitWire() {}}
        const c = createRpcClient<any>({socket, socketKey: 'rpc'})
        const control = (c as any)[RPC_TRANSPORT_CONTROL]
        const unhandled: unknown[] = []
        function rememberUnhandled(reason: unknown) { unhandled.push(reason) }
        process.on('unhandledRejection', rememberUnhandled)
        const ignored = c.func.neverSettles()
        const awaited = c.func.neverSettles()
        const awaitedResult = awaited.then(
            function unexpectedResolve() { return 'resolved' },
            function observeDisconnectReject(error) { return String(error?.message ?? error) },
        )
        control.disconnect('intentional test disconnect')
        const rejection = await awaitedResult
        await delay(0)
        process.off('unhandledRejection', rememberUnhandled)
        ignored.catch(function consumeIgnoredTestPromise() {})
        await check('disconnect: awaited ordinary call rejects', async () =>
            rejection.includes('RPC transport disconnected: intentional test disconnect'), true)
        await check('disconnect: ignored ordinary call is not unhandled', async () => unhandled.length, 0)
    }
    { // client wire: dotted dynamic segment goes as one path array element
        const emitted: any[] = []
        const socket: SocketTmpl = {
            on: () => {},
            emit: (e, d) => { if (e === "rpc") emitted.push(JSON.parse(JSON.stringify(d))) },
        }
        const c = createRpcClient<any>({ socket, socketKey: "rpc" })
        const pending = c.func.map["mystrategy.2020"].start()
        pending.catch(() => {})
        await check("wire: dotted segment path array", async () => {
            const call = emitted.find(m => Array.isArray(m) && m[0] === Pkt.CALL)
            return call?.[2]
        }, ["map", "mystrategy.2020", "start"])
        c.close("wire test done", { socketAlive: false })
    }
    { // dotted path keys: ordinary object doesn't mix segment "a.b" with path a.b
        const [cs, ss] = createLoopback()
        const seenKeys: string[][] = []
        const api = {
            "a.b": { c: () => "dotted" },
            a: { b: { c: () => "nested" } },
        }
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "rpc" })
        createRpcServer({
            socket: ss,
            object: api,
            socketKey: "rpc",
            hooks: { onRequest: ({ key }) => { seenKeys.push([...key]); return true } },
        })
        await delay(0)
        await check("path-key: dotted segment call", () => c.func["a.b"].c(), "dotted")
        await check("path-key: nested segment call", () => c.func.a.b.c(), "nested")
        await check("path-key: hook key exact", async () => seenKeys, [["a.b", "c"], ["a", "b", "c"]])
    }
    { // dotted path keys: pipe supports dotted segment as initial server method
        const [cs, ss] = createLoopback()
        const api = {
            "a.b": () => ({ c: () => "dotted" }),
            a: () => ({ b: { c: () => "nested" } }),
        }
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await check("path-key: pipe dotted segment", () => (c.pipe["a.b"]() as any).c(), "dotted")
        await check("path-key: pipe nested branch", () => (c.pipe.a() as any).b.c(), "nested")
    }
    { // dotted path keys: listen dedup doesn't mix "a.b".events and a.b.events
        const [cs, ss] = createLoopback()
        const [emitDotted, listenDotted] = createListenPair<string>()
        const [emitNested, listenNested] = createListenPair<string>()
        const obj = {
            "a.b": { events: listenDotted },
            a: { b: { events: listenNested } },
        }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c) as any
        const dotted: string[] = [], nested: string[] = []
        const offDotted = L["a.b"].events.on((v: string) => dotted.push(v))
        const offNested = L.a.b.events.on((v: string) => nested.push(v))
        await delay(10)
        const keys = c.api.subscriptions().map(s => s.key)
        emitDotted("dotted")
        emitNested("nested")
        await delay(10)
        await check("path-key: listen subscriptions distinct", async () => ({ count: keys.length, unique: new Set(keys).size }), { count: 2, unique: 2 })
        await check("path-key: listen events isolated", async () => [dotted, nested], [["dotted"], ["nested"]])
        offDotted(); offNested()
    }
    { // dotted path keys: dynamic proxy receives "mystrategy.2020" as one prop, start next
        const [cs, ss] = createLoopback()
        const seen: string[] = []
        const strategy = new Proxy({}, {
            has: (_t, p) => p === "start",
            get: (_t, p) => {
                if (p === "start") { seen.push(String(p)); return () => seen.slice() }
                return undefined
            },
        })
        const map = noStrict(new Proxy({}, {
            has: (_t, p) => typeof p == "string",
            get: (_t, p) => { seen.push(String(p)); return strategy },
        }))
        const api = { map }
        const c = createRpcClient<any>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await check("path-key: dynamic dotted prop", () => c.func.map["mystrategy.2020"].start(), ["mystrategy.2020", "start"])
    }
    { // strict proxy: schema refresh changes path type, but not identity
        const [cs, ss] = createLoopback()
        const api: { node: any } = { node: { child: () => "before" } }
        const c = createRpcClient<any>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await c.initStrict({ node: { child: "func" } })
        const node = c.strict.node as any
        await check("strict/cache: object path rejects call", async () => {
            try { await node(); return false }
            catch { return true }
        }, true)
        api.node = () => "after"
        await c.initStrict({ node: "func" })
        await check("strict/cache: identity after type flip", async () => node == c.strict.node, true)
        await check("strict/cache: call follows fresh schema", () => node(), "after")
    }
    { // old permissive RPC Proxy must not impersonate internal symbol metadata
        const fakeMember = new Proxy(function fakeRpcMember() {}, {})
        const legacyProxy = new Proxy(function legacyRpcProxy() {}, {get: () => fakeMember})
        await check("rpc/metadata: unbranded proxy ignored", async () => [
            getRpcMemberState(legacyProxy, "frame") == undefined,
            getRpcTransportLifecycle(legacyProxy) == undefined,
        ], [true, true])
    }
    { // lazy RPC proxy: optional replay members use the actual MAP, not Proxy truthiness
        const [cs, ss] = createLoopback()
        const [emit, line] = createListenPair<any>()
        const journal = [
            {seq: 1, ts: 1, event: [11]},
            {seq: 2, ts: 2, event: [22]},
        ]
        const oldReplay = {
            line,
            since: (seq: number) => journal.filter(event => event.seq > seq),
            keyframe: async function oldKeyframe() { return null },
        }
        const c = createRpcClient<any>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: {oldReplay}, socketKey: "rpc" })
        await delay(0)
        const values: number[] = []
        const errors: string[] = []
        const sub = replaySubscribe<[number]>(c.func.oldReplay as any, value => values.push(value), {
            since: 0,
            policy: "frame",
            onError: error => errors.push(String(error)),
        })
        await sub.ready
        emit({seq: 3, ts: 3, event: [33]})
        await delay(10)
        await check("replay/old-rpc: frame fallbacks", async () => ({values, errors}), {
            values: [11, 22, 33], errors: [],
        })
        sub()
    }
    { // mixed-version (P4): client ignores EXTRA (future) Pkt.MAP elements — forward-compat.
      // Old server sends MAP with 4 elements (as in all other cases); here we add
      // 5th/6th (future authAck/version), new client should work as if nothing happened.
        const [cs, ss] = createLoopback()
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => origEmit(e, Array.isArray(d) && d[0] === Pkt.MAP ? [...d, { ok: true }, { v: 2 }] : d)
        const obj = { add: (a: number, b: number) => a + b }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        await check("mixed-version: лишние MAP-элементы игнорятся", () => c.func.add(2, 3), 5)
    }
    { // clientHub: token rotation disconnects old clients and updates promise
        const [csA, ssA] = createLoopback()
        const [csB, ssB] = createLoopback()
        createRpcServer({ socket: ssA, object: slowObj, socketKey: "main" })
        createRpcServer({ socket: ssB, object: slowObj, socketKey: "main" })
        const made = [csA, csB]; let i = 0
        const hub = createRpcClientHub(() => Object.assign(made[i++], { disconnect: () => {} }), r => ({ main: r<typeof slowObj>() }))
        const p1 = hub.setToken("t1")
        ssA.emit("connect", 1)
        await p1
        const firstPromise = hub.promise
        const pOld = hub.facade.main.func.slow("x", 500).then(() => "resolved", () => "rejected")
        hub.setToken("t2")
        ssB.emit("connect", 1)
        await hub.promise
        await check("hub: висящий запрос старого токена отклонён", () => Promise.race([pOld, delay(100).then(() => "hung")]), "rejected")
        await check("hub: promise свежий после ротации", async () => hub.promise !== firstPromise, true)
        await check("hub: новый клиент работает", () => hub.facade.main.func.add(1, 2), 3)
    }
    { // dispose: pending rejected, new calls rejected
        const [cs, ss] = createLoopback()
        const c = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: slowObj, socketKey: "rpc" })
        await delay(0)
        const F = c.func
        const p = F.slow("x", 50).then(() => "resolved", () => "rejected")
        c.dispose("bye")
        await check("dispose: висящие отклонены", () => p, "rejected")
        await check("dispose: новые вызовы отбиты", () => F.add(1, 2).then(() => "accepted", () => "rejected"), "rejected")
        await check("dispose: pending пуст", async () => c.api.pending(), 0)
    }

    console.log("--- Stage 1: in-band auth (HELLO / authAck / gate / reauth) ---")
    { // verify→facade: principal-specific routeMap, gate, rejection for bad token
        const [cs, ss] = createLoopback()
        // client sees superset facade (admin): read + write — both under tsc.
        type Admin = { read: () => string; write: (x: number) => number }
        const facades: Record<string, Partial<Admin>> = {
            "tok-admin": { read: () => "r", write: (x: number) => x * 2 },
            "tok-user":  { read: () => "r" }, // no write
        }
        const resolveAuth = (token: string) => {
            const object = facades[token]
            if (!object) throw new Error("bad token")
            return { object, ack: { ok: true, who: token } }
        }
        createRpcServer({ socket: ss, object: {} as any, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<Admin>({ socket: cs, socketKey: "rpc", token: "tok-admin" })
        await c.initStrict()
        await check("auth: admin authAck ok+who", async () => { const a = await c.auth(); return [a?.ok, a?.who] }, [true, "tok-admin"])
        await check("auth: admin видит write", () => c.func.write(21), 42)
    }
    { // gate: bad token → authAck.ok=false, calls rejected
        const [cs, ss] = createLoopback()
        const resolveAuth = (t: string) => { if (t !== "good") throw new Error("nope"); return { object: { ping: () => "pong" }, ack: { ok: true } } }
        createRpcServer({ socket: ss, object: {} as any, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<{ ping: () => string }>({ socket: cs, socketKey: "rpc", token: "bad" })
        await c.initStrict()
        await check("gate: плохой токен ok=false", async () => (await c.auth())?.ok, false)
        await check("gate: вызов до auth отклонён", () => c.func.ping().then(() => "ok", () => "rejected"), "rejected")
    }
    { // reauth: principal change on LIVE socket — subscription survives, new method appears
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const mk = (who: string) => who === "admin" ? { stream: listen, write: (x: number) => x } : { stream: listen }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        // client typed with superset facade (admin): stream-subscription + write.
        type Princ = { stream: typeof listen; write: (x: number) => number }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        emit(1)
        await delay(10)
        await c.reauth("admin")
        await check("reauth: authAck who=admin", async () => (await c.auth())?.who, "admin")
        emit(2)
        await delay(10)
        await check("reauth: подписка пережила reauth", async () => got, [1, 2])
        await check("reauth: новый principal видит write", () => c.func.write(7), 7)
    }
    { // proxy-regression: reauth rebuilds dispatch on Proxy facade without symbol-get
        const [cs, ss] = createLoopback()
        const statsByWho: Record<string, { symbolGets: number; stringGets: number }> = {}
        const mk = (who: string) => {
            const stats = { symbolGets: 0, stringGets: 0 }
            statsByWho[who] = stats
            return proxyRejectingSymbolGet({ who: () => who, write: (x: number) => `${who}:${x}` }, stats)
        }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        type Princ = { who: () => string; write: (x: number) => string }
        createRpcServerAuto({ socket: ss, object: mk("initial"), socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await check("proxy/reauth: initial auth facade", () => c.func.who(), "user")
        await c.reauth("admin")
        await check("proxy/reauth: новый facade", () => c.func.write(5), "admin:5")
        await check("proxy/reauth: symbol-get не было", async () => Object.values(statsByWho).reduce((n, s) => n + s.symbolGets, 0), 0)
    }
    { // backward-compat: client WITH token vs server WITHOUT auth — works, no authAck
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const c = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc", token: "ignored" })
        await c.initStrict()
        await check("no-auth server: вызов работает", () => c.func.add(2, 3), 5)
    }
    const raced = (p: Promise<any>) => Promise.race([p.then(() => "settled", () => "settled"), delay(60).then(() => "hung")])
    { // no-auth/old server: auth() and reauth() RESOLVE (don't hang) — drain on 4-element MAP
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: { ping: () => "p" }, socketKey: "rpc" })
        const c = createRpcClient<{ ping: () => string }>({ socket: cs, socketKey: "rpc", token: "x" })
        await c.initStrict()
        await check("no-auth: auth() резолвится (null)", async () => [await raced(c.auth()), await c.auth()], ["settled", null])
        await check("no-auth: reauth() резолвится", () => raced(c.reauth("y")), "settled")
    }
    { // dispose: pending reauth rejected with {ok:false,reason}, calls AFTER dispose don't hang
        const [cs] = createLoopback()
        const c = createRpcClient<{}>({ socket: cs, socketKey: "rpc", token: "x" })
        const p = c.reauth("x") // no server → MAP won't arrive; dispose must clean up
        c.dispose("bye")
        const r = await Promise.race([p, delay(60).then(() => ({} as any))])
        await check("dispose: reauth снят с ok:false", async () => [r?.ok, r?.reason], [false, "bye"])
        await check("dispose: reauth после dispose отбит", () => Promise.race([c.reauth("y"), delay(60).then(() => "hung")]).then((x: any) => x?.ok), false)
        await check("dispose: auth после dispose отбит", () => Promise.race([c.auth(), delay(60).then(() => "hung")]).then((x: any) => x?.ok), false)
    }
    { // reauth-throw does NOT drop live session: call old principal, subscription alive, ok:false
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const mk = (who: string) => ({ stream: listen, write: (x: number) => x, who: () => who })
        const resolveAuth = (t: string) => { if (t === "boom") throw new Error("transient"); return { object: mk(t), ack: { ok: true, who: t } } }
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { stream: typeof listen; write: (x: number) => number; who: () => string }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        const ack = await c.reauth("boom") // resolveAuth throws on server
        await check("reauth-throw: ok=false", async () => ack?.ok, false)
        emit(2); await delay(10)
        await check("reauth-throw: подписка жива", async () => got, [1, 2])
        await check("reauth-throw: прежний principal вызываем", () => c.func.write(9), 9)
    }
    { // gate-reject carries machine-readable code E_UNAUTHORIZED
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: {} as any, socketKey: "rpc", auth: { resolveAuth: () => { throw new Error("no") }, gate: true } })
        // dummy method `any` in client type: server doesn't route it (gate strikes first),
        // but call remains typed (no sprinkling of as any) — test of rejection code itself.
        const c = createRpcClient<{ any: () => void }>({ socket: cs, socketKey: "rpc", token: "x" })
        await c.initStrict()
        await check("gate: код ошибки E_UNAUTHORIZED", () => c.func.any().catch((e: any) => e?.code), "E_UNAUTHORIZED")
    }
    { // hub: token reaches client (HELLO on connect) + soft hub.reauth on live socket
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const mk = (who: string) => who === "admin" ? { stream: listen, write: (x: number) => x } : { stream: listen }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "main", auth: { resolveAuth } })
        // hub schema typed with superset facade → facade.main.func.stream / .write under tsc.
        type Princ = { stream: typeof listen; write: (x: number) => number }
        const hub = createRpcClientHub(() => Object.assign(cs, { disconnect: () => {} }), r => ({ main: r<Princ>() }))
        const p = hub.setToken("user")
        ss.emit("connect", 1)
        await p
        await check("hub auth: who=user", async () => (await hub.facade.main.auth())?.who, "user")
        const got: number[] = []
        hub.facade.main.func.stream.callback((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        await hub.reauth("admin")
        await check("hub reauth: who=admin", async () => (await hub.facade.main.auth())?.who, "admin")
        emit(2); await delay(10)
        await check("hub reauth: подписка жива", async () => got, [1, 2])
        await check("hub reauth: admin видит write", () => hub.facade.main.func.write(7), 7)
    }

    console.log("--- S0.3: protocol-detection lifecycle (auto-detect dispose/reset) ---")
    { // v2-detection, reset (re-detection), dispose (router inert), idempotency
        const [cs, ss] = createLoopback()
        const auto = createRpcServerAutoDetect({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const cA = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        await check("auto-detect: v2 вызов", () => cA.func.add(2, 3), 5)
        await check("auto-detect: протокол v2", async () => auto.getProtocol(), "v2")
        auto.reset()
        await check("auto-detect: reset сбросил латч", async () => auto.getProtocol(), null)
        const cB = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        await check("auto-detect: после reset снова v2", () => cB.func.add(4, 5), 9)
        // dispose: router inert — incoming messages don't generate response
        let out = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { out++; origEmit(e, d) }
        auto.dispose("bye")
        out = 0
        cs.emit("rpc", Pkt.STRICT)
        await delay(10)
        await check("auto-detect: dispose инертен (нет ответа)", async () => out, 0)
        auto.dispose()
        await check("auto-detect: повторный dispose без эффекта", async () => out, 0)
    }
    { // auto-detect + token: first HELLO recognized as v2 (else client auth() would hang)
        const [cs, ss] = createLoopback()
        createRpcServerAutoDetect({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const c = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc", token: "tok" })
        await c.initStrict()
        await check("auto-detect+token: auth() резолвится (null)", () => Promise.race([c.auth(), delay(60).then(() => "hung")]), null)
        await check("auto-detect+token: вызов работает", () => c.func.add(2, 3), 5)
    }
    { // auto-detect delegates .once to base listenSocket.once: first event should send CB_END
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        createRpcServerAutoDetect({ socket: ss, object: obj, socketKey: "rpc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        const done = webListen(c).stream.once((v) => got.push(v))
        await delay(10)
        emit(1); await delay(3); emit(2)
        await check("auto-detect once: ровно одно событие", async () => got, [1])
        await check("auto-detect once: handle завершился", () => Promise.race([done.then(() => "ended"), delay(60).then(() => "hung")]), "ended")
    }

    console.log("--- adaptive подписочное уплотнение (Pkt.SHAPE/CBV: частая форма → компакт) ---")
    { // frequent object of single form gets standardized after threshold; values (incl. Date) intact
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<{ a: number; when: Date; tag: string }>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: { a: number; when: Date; tag: string }[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        let cbv = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.CBV) cbv++; origEmit(e, d) }
        for (let i = 0; i < 8; i++) { emit({ a: i, when: new Date(i), tag: "x" }); await delay(2) }
        await delay(10)
        await check("уплотнение: все 8 тиков целы", async () => got.length, 8)
        await check("уплотнение: значения верны (8-й тик)", async () => [got[7].a, got[7].tag, got[7].when], [7, "x", new Date(7)])
        await check("уплотнение: перешли на компакт (CBV>0)", async () => cbv > 0, true)
    }
    { // polymorphic/rare form NOT compacted — threshold not reached, all full CB (no CBV)
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<Record<string, number>>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: Record<string, number>[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        let cbv = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.CBV) cbv++; origEmit(e, d) }
        emit({ a: 1 }); await delay(2); emit({ b: 2 }); await delay(2); emit({ c: 3 }); await delay(2)
        await delay(10)
        await check("полиморф: все тики целы", async () => [got[0]["a"], got[1]["b"], got[2]["c"]], [1, 2, 3])
        await check("полиморф: без уплотнения (CBV==0)", async () => cbv, 0)
    }
    { // back-compat: OLD client (without Pkt.CAPS) ↔ NEW server with compaction.
      // Emulate old client — transport swallows CAPS, server doesn't see it → compactOk=false
      // → server MUST send plain Pkt.CB, not SHAPE/CBV. Fix P4 invariant with test.
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<{ a: number; when: Date; tag: string }>()
        const obj = { stream: listen }
        const origCsEmit = cs.emit.bind(cs)
        cs.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.CAPS) return; origCsEmit(e, d) }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: { a: number; when: Date; tag: string }[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        let cbv = 0, cb = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d)) { if (d[0] === Pkt.CBV) cbv++; if (d[0] === Pkt.CB) cb++ } origEmit(e, d) }
        for (let i = 0; i < 8; i++) { emit({ a: i, when: new Date(i), tag: "x" }); await delay(2) }
        await delay(10)
        await check("старый клиент: все 8 тиков целы", async () => got.length, 8)
        await check("старый клиент: значения целы (вкл. Date, 8-й тик)", async () => [got[7].a, got[7].tag, got[7].when], [7, "x", new Date(7)])
        await check("старый клиент: НЕ уплотняли (CBV==0)", async () => cbv, 0)
        await check("старый клиент: сервер слал обычный CB (CB>0)", async () => cb > 0, true)
    }

    console.log("--- negotiation: opt.compact (договорное уплотнение через рукопожатие caps) ---")
    { // client opt:{compact:false} → does NOT declare COMPACT (silent) → server on plain Pkt.CB
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<{ a: number; when: Date; tag: string }>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc", opt: { compact: false } })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: { a: number; when: Date; tag: string }[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        let cbv = 0, cb = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d)) { if (d[0] === Pkt.CBV) cbv++; if (d[0] === Pkt.CB) cb++ } origEmit(e, d) }
        for (let i = 0; i < 8; i++) { emit({ a: i, when: new Date(i), tag: "x" }); await delay(2) }
        await delay(10)
        await check("opt client-off: все 8 тиков целы", async () => got.length, 8)
        await check("opt client-off: значения целы (Date)", async () => [got[7].a, got[7].when], [7, new Date(7)])
        await check("opt client-off: НЕ уплотняли (CBV==0)", async () => cbv, 0)
        await check("opt client-off: сервер слал обычный CB (CB>0)", async () => cb > 0, true)
    }
    { // server opt:{compact:false} → doesn't declare COMPACT → no compaction, even if client can
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<{ a: number; when: Date; tag: string }>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc", opt: { compact: false } })
        await delay(0)
        const got: { a: number; when: Date; tag: string }[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        let cbv = 0, cb = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d)) { if (d[0] === Pkt.CBV) cbv++; if (d[0] === Pkt.CB) cb++ } origEmit(e, d) }
        for (let i = 0; i < 8; i++) { emit({ a: i, when: new Date(i), tag: "x" }); await delay(2) }
        await delay(10)
        await check("opt server-off: все 8 тиков целы", async () => got.length, 8)
        await check("opt server-off: НЕ уплотняли (CBV==0)", async () => cbv, 0)
        await check("opt server-off: сервер слал обычный CB (CB>0)", async () => cb > 0, true)
    }

    console.log("--- .on(cb) через веб — идиоматичный алиас .callback(cb) ---")
    { // subscription by mere fact of callback setup via client.func.stream.on(cb)
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        const off = webListen(c).stream.on((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 5; i++) { emit(i); await delay(2) }
        await delay(10)
        await check("on-web: .on(cb) подписал + стримит", async () => got, [0, 1, 2, 3, 4])
        await check("on-web: вернулся off()-хендл", async () => typeof off == "function", true)
        off?.()
        await delay(5)
        const before = got.length
        emit(99); await delay(5)
        await check("on-web: off() отписал", async () => got.length, before)
    }
    { // genuine: with dedupe:false `.on(fn)` goes DIRECT wire call to stream.on (no subscribe-magic
      // of client) → proves server route `on` actually works over network.
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc", dedupeListen: false })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).stream.on((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 4; i++) { emit(i); await delay(2) }
        await delay(10)
        await check("on-web: genuine .on (dedupe off) стримит", async () => got, [0, 1, 2, 3])
    }
    { // .on and .callback on ONE node share one network subscription (dedup by node address)
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        const srv = createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c)
        const a: number[] = [], b: number[] = []
        L.stream.on((v) => a.push(v))
        L.stream.callback((v) => b.push(v))
        await delay(10)
        emit(7); await delay(5)
        await check("on+callback: оба потребителя получили", async () => [a[0], b[0]], [7, 7])
        await check("on+callback: одна серверная подписка (дедуп по узлу)", async () => srv.api.subscriptions()[0]?.consumers, 1)
    }

    console.log("--- реестр идентичности on→api (WeakMap) + once + bare-on exposure ---")
    { // registry: isListenOn / getListenByOn
        const [, listen] = createListenPair<number>()
        await check("isListenOn(listen.on) === true", async () => isListenOn(listen.on), true)
        await check("getListenByOn(listen.on) === api", async () => getListenByOn(listen.on) === listen, true)
        await check("isListenOn(чужая fn) === false", async () => isListenOn(() => {}), false)
    }
    { // .once(cb) delivers EXACTLY one event over web, then stream closed
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).stream.once((v) => got.push(v))
        await delay(10)
        emit(1); await delay(3); emit(2); await delay(3); emit(3); await delay(5)
        await check("once: ровно одно событие через веб", async () => got, [1])
    }
    { // bare-on: object contains ONLY listen.on (branded function) — server by registry
      // unfolds subscription, and DeepSocketListen by ListenOn brand projects {on, once, close}.
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { stream: listen.on }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const L = webListen(c)
        const got: number[] = []
        L.stream.on((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 4; i++) { emit(i); await delay(2) }
        await delay(10)
        await check("bare-on: { stream: listen.on } стримит через веб", async () => got, [0, 1, 2, 3])
        await check("bare-on: .once тоже работает", async () => {
            const one: number[] = []
            L.stream.once((v) => one.push(v))
            await delay(10); emit(42); await delay(3); emit(43); await delay(5)
            return one
        }, [42])
    }
    { // bare-on BY STRING: noStrict subtree has no routeMap → resolve by string path
      // (fallback bypass of currentTarget). resolveTransform applied on-the-fly → isListenOn catches on.
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { dyn: noStrict({ stream: listen.on }) }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).dyn.stream.on((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 3; i++) { emit(i); await delay(2) }
        await delay(10)
        await check("bare-on ПО СТРОКЕ (noStrict): стримит", async () => got, [0, 1, 2])
    }
    { // and Listen-OBJECT by string (noStrict) — both ways supported, by reference and string
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = { dyn: noStrict({ stream: listen }) }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).dyn.stream.on((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 3; i++) { emit(i * 10); await delay(2) }
        await delay(10)
        await check("Listen-объект ПО СТРОКЕ (noStrict): стримит", async () => got, [0, 10, 20])
    }

    // ===========================================================================
    // wenay-common2 NETWORK LAYER: events + Observe.
    //
    // Contract for RPC is same: server node returns real Listen, client
    // gets typed subscription surface via listen-deep/webListen,
    // off() removes server subscription. Test current public package surfaces.
    // ===========================================================================
    console.log("--- wenay-common2 сеть: events + Observe через боевой сокет ---")

    { // events.listen — value stream over network + teardown (0↔1 subscriptions)
        const [cs, ss] = createLoopback()
        const [emit, stream] = createListenPair<number>()
        const obj = {stream}
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        const sub = webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        emit(1); emit(2); emit(3)
        await delay(10)
        await check("listen: значения по сети", async () => got, [1, 2, 3])
        await check("listen: одна сетевая подписка", async () => stream.count(), 1)
        sub.unsubscribe()
        await delay(10)
        const n = got.length
        emit(99)
        await delay(10)
        await check("listen: после отписки источник холодный (0)", async () => stream.count(), 0)
        await check("listen: после отписки тиков нет", async () => got.length, n)
    }
    { // Observe.store.each — stream of [key,value] changed top keys over network
        const [cs, ss] = createLoopback()
        const rows = createStore<Record<string, number>>({a: 1, b: 2}, {drain: "micro"})
        const obj = {rows: rows.each()}
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: [string, any][] = []
        webListen(c).rows.callback((k, v) => got.push([k, v]))
        await delay(10)
        rows.state.a = 10
        rows.state.c = 3
        delete rows.state.b
        await flushReactive(rows.state); await delay(10)
        await check("store.each: [key,value] дельты по сети", async () => got, [["a", 10], ["c", 3], ["b", null]])
        await check("store.each: одна сетевая подписка", async () => obj.rows.count(), 1)
    }
    { // events.mapListen — map+filter (null skips event) over network
        const [cs, ss] = createLoopback()
        const [emit, src] = createListenPair<number>()
        const [, evenDoubled] = mapListen<[number], [number]>(src, (n) => n % 2 == 0 ? [n * 2] : null)
        const obj = { stream: evenDoubled }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 5; i++) { emit(i); await delay(2) } // evens ×2: 0,4,8; odds — filtered out
        await delay(10)
        await check("mapListen: map+filter по сети", async () => got, [0, 4, 8])
    }
    { // events.joinListens — zip by key: group streams ONLY when all ports gathered
        const [cs, ss] = createLoopback()
        // tuple form listen<[X]> → port matches ListenMap (T[K] extends any[]).
        // T set explicitly: via mapped-type param (ListenMap<T>) inference doesn't work, and without
        // hint joinListens would fall to array overload.
        const [emitA, portA] = createListenPair<[{ id: string, a: number }]>()
        const [emitB, portB] = createListenPair<[{ id: string, b: number }]>()
        const joined = joinListens<{ A: [{ id: string, a: number }], B: [{ id: string, b: number }] }>(
            { A: portA, B: portB }, (d: any) => d.id)
        const obj = { zip: joined.listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        // (res, tid) inferred from listen<[R, string]> — res: gathered group, tid: string.
        const got: [string, unknown][] = []
        webListen(c).zip.callback((res, tid) => got.push([tid, res]))
        await delay(10)
        emitA({ id: "t1", a: 1 })
        await delay(10)
        await check("joinListens: неполная группа не стримит", async () => got.length, 0)
        emitB({ id: "t1", b: 2 })
        await delay(10)
        await check("joinListens: zip по ключу собрался по сети", async () => got,
            [["t1", { A: { id: "t1", a: 1 }, B: { id: "t1", b: 2 } }]])
    }

    // ===========================================================================
    // COOKBOOK — effective patterns "as in life". Each is working check (meaning,
    // simultaneously live example AND regression test). Typing is real: client knows
    // server form, subscriptions via webListen. Domain — trading (for clarity).
    // ===========================================================================
    console.log("--- COOKBOOK: реальные паттерны использования ---")

    { // Observe store mirror over the real RPC loopback: get() stays a normal call, changedPaths stays a normal Listen.
        const [cs, ss] = createLoopback()
        const serverStore = createStore<any>({strategies: {a: {status: false}}, meta: {status: "ok"}}, {drain: "micro"})
        const facade = exposeStore(serverStore)
        createRpcServerAuto({ socket: ss, object: facade, socketKey: "store2" })
        const c = createRpcClient<typeof facade>({ socket: cs, socketKey: "store2" })
        await delay(0)

        const listen = webListen(c)
        const remote = {
            get: (mask?: any) => c.func.get(mask),
            changed: listen.changed,
            changedPaths: listen.changedPaths,
        }
        const mirror = createStoreMirror<any>(remote, {strategies: {}, meta: {}}, {drain: "micro"})
        const stop = await mirror.sync({strategies: true, meta: {status: true}}, {current: true, drain: "micro"})

        serverStore.state.strategies.a.status = true
        await flushReactive(serverStore.state); await delay(10)
        serverStore.state.strategies.b = {status: true}
        await flushReactive(serverStore.state); await delay(10)
        delete serverStore.state.strategies.b
        serverStore.state.meta.status = "warn"
        await flushReactive(serverStore.state); await delay(10)
        stop()

        await check("cookbook: Observe mirror по RPC", async () => ({
            a: mirror.state.strategies.a.status,
            hasB: "b" in mirror.state.strategies,
            meta: mirror.state.meta.status,
        }), {a: true, hasB: false, meta: "warn"})
    }

    { // Replay-line of store over RPC: keyframe + seq-deltas; reconnect by since = patch tail, NOT snapshot.
      //   Wire NOT changed: line — plain Listen, since/keyframe — plain methods (exposeStoreReplay).
        const [cs, ss] = createLoopback()
        const world = createStore<any>({units: {a: {hp: 100}}, tick: 0}, {drain: "micro"})
        const exposed = exposeStoreReplay(world, {history: 64})
        const counters = {keyframe: 0}
        const facade = {...exposed.api, replay: {...exposed.api.replay, keyframe: () => { counters.keyframe++; return exposed.api.replay.keyframe() }}}
        createRpcServerAuto({ socket: ss, object: facade, socketKey: "replay" })
        const c = createRpcClient<typeof facade>({ socket: cs, socketKey: "replay" })
        await delay(0)

        const listen = webListen(c)
        const remote = {
            line: (listen as any).replay.line,
            since: (s: number) => c.func.replay.since(s),
            keyframe: () => c.func.replay.keyframe(),
        }
        const mirror = createStore<any>({})
        let lastSeq = -1
        const sub = syncStoreReplay(mirror, remote as any, {onSeq: (s: number) => lastSeq = s})
        await sub.ready
        world.state.tick = 1
        await flushReactive(world.state); await delay(10)
        const liveOk = eq(mirror.snapshot(), world.snapshot())

        // break: mirror offline, world continues — reconnect reaches by TAIL
        sub()
        world.state.units.a.hp = 50
        await flushReactive(world.state)
        world.state.tick = 2
        await flushReactive(world.state); await delay(10)
        const kfBefore = counters.keyframe
        let tailPatches = 0
        const sub2 = syncStoreReplay(mirror, remote as any, {since: lastSeq, onSeq: (s: number) => { lastSeq = s; tailPatches++ }})
        await sub2.ready
        await delay(10)
        sub2()
        exposed.close()
        await check("cookbook: replay-линия — live-патчи + реконнект хвостом без снапшота", async () => ({
            live: liveOk,
            converged: eq(mirror.snapshot(), world.snapshot()),
            tailOnly: counters.keyframe === kfBefore,
            tail: tailPatches,
        }), {live: true, converged: true, tailOnly: true, tail: 2})
    }

    { // Replay staleness over wire: delivery CONSISTENT, but silent on freshness — arrival gap
      //   (client local clock) catches dead producer via real socket: no envelopes
      //   → stale-edge once. Reconnect via {since} reaches tail — and line fresh.
      //   Mechanism — replaySubscribe option, not manual consumer watchdog.
        const [cs, ss] = createLoopback()
        const [tick, replayLine] = replayListen<[number]>({history: 64})
        const exposedReplay = exposeReplay(replayLine)
        createRpcServerAuto({ socket: ss, object: {replay: exposedReplay}, socketKey: "stale" })
        const c = createRpcClient<{replay: typeof exposedReplay}>({ socket: cs, socketKey: "stale" })
        await delay(0)

        const listen = webListen(c)
        const remote = {
            line: (listen as any).replay.line,
            since: (s: number) => c.func.replay.since(s),
            keyframe: () => c.func.replay.keyframe(),
        }
        const edges: boolean[] = []
        const seen: number[] = []
        let lastSeq = -1
        const sub = replaySubscribe<[number]>(remote as any, v => seen.push(v),
            {staleMs: 60, onStale: i => edges.push(i.stale), onSeq: s => lastSeq = s})
        await sub.ready
        tick(1); tick(2)
        await delay(20)
        const freshAfterLive = !sub.isStale()
        await delay(150)                          // producer silent → arrival gap triggers
        const staleAfterSilence = sub.isStale()
        sub()                                     // "break": client offline, world continues
        tick(3); tick(4)
        const edges2: boolean[] = []
        const seen2: number[] = []
        const sub2 = replaySubscribe<[number]>(remote as any, v => seen2.push(v),
            {since: lastSeq, staleMs: 60, onStale: i => edges2.push(i.stale)})
        await sub2.ready
        tick(5)
        await delay(20)
        const fresh2 = !sub2.isStale()
        sub2()
        await check("cookbook: replay-тухлость — arrival gap + реконнект {since}", async () => ({
            data: seen.join(","), edges: edges.join(","), freshAfterLive, staleAfterSilence,
            tail: seen2.join(","), edges2: edges2.join(","), fresh2,
        }), {data: "1,2", edges: "true", freshAfterLive: true, staleAfterSilence: true, tail: "3,4,5", edges2: "", fresh2: true})
    }

    { // 1) ORDINARY REQUEST-RESPONSE (REST/fetch-endpoint replacement, but typed and no URL).
      //    Do: call server function as local — c.func.setLimit("BTC",100), but it executes
      //    ON SERVER and returns result. Use when: save setting, ask
      //    value, trigger action. Most common case "just pass/get data".
        const [cs, ss] = createLoopback()
        const m = new Map<string, number>()
        const limits = {
            setLimit: (sym: string, v: number) => { m.set(sym, v); return v },
            getLimit: (sym: string) => m.get(sym) ?? 0,
        }
        createRpcServer({ socket: ss, object: limits, socketKey: "cfg" })
        const c = createRpcClient<typeof limits>({ socket: cs, socketKey: "cfg" })
        await delay(0)
        await c.func.setLimit("BTC", 100)
        await check("cookbook: stateful-сервис по сети", () => c.func.getLimit("BTC"), 100)
    }
    { // 2) WATCH CHANGING VALUE in real time (push, not polling).
      //    Do: server holds plain listen stream, client .on(cb) receives
      //    each new value. off() — stop watching (server subscription drops).
      //    Use when: price ticker, task status, progress, online counter.
        const [cs, ss] = createLoopback()
        const [emitPrice, price] = createListenPair<number>()
        const obj = { price }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "md" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "md" })
        await delay(0)
        const ticks: number[] = []
        const off = webListen(c).price.on((v) => ticks.push(v))
        await delay(5)
        emitPrice(101); emitPrice(102)
        await delay(10)
        off() // unsubscribe — server subscription drops, feed stops
        const after = ticks.length
        emitPrice(103); await delay(10)
        await check("cookbook: live-фид + off()", async () => [ticks, ticks.length == after], [[101, 102], true])
    }
    { // 3) KEEP UP-TO-DATE COPY of server collection on client (freely add/change/delete).
      //    Do: Observe store on server; modify as plain object
      //    (`book.state.BTC = 2`, `delete book.state.BTC`) — but only deltas reach client
      //    of changed keys. delete arrives as null after JSON-wire.
      //    store.each() — stream of per-key deltas. Use when: table/list lives on server.
        const [cs, ss] = createLoopback()
        const book = createStore<Record<string, number>>({}, {drain: "micro"})
        const obj = { positions: book.each() }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "pos" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "pos" })
        await delay(0)
        const mirror = new Map<string, number>()
        webListen(c).positions.callback((k, v) => { if (v == null) mirror.delete(k); else mirror.set(k, v) })
        await delay(5)
        book.state.BTC = 2; book.state.ETH = 5; delete book.state.BTC
        await flushReactive(book.state); await delay(10)
        await check("cookbook: зеркало коллекции по сети", async () => [...mirror], [["ETH", 5]])
    }
    { // 4) COMPUTE DERIVED on SERVER, send ready result to client.
      //    Do: notional = price*qty computed on server on input change,
      //    client gets only result. Use when: don't want to pull raw data and compute
      //    on client (aggregates, sums, PnL) — logic and recalc live in one place.
        const [cs, ss] = createLoopback()
        const [emitNotional, notional] = createListenPair<number>()
        let price = 10
        let qty = 3
        const send = () => emitNotional(price * qty)
        const obj = { notional }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "calc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "calc" })
        await delay(0)
        const got: number[] = []
        webListen(c).notional.callback((v) => got.push(v))
        await delay(5)
        price = 20; send(); await delay(5); qty = 4; send()
        await delay(10)
        await check("cookbook: derived-метрика по сети", async () => got, [60, 80])
    }
    { // 5) IN ONE SERVER CALL fetch object and immediately apply method/get field (pipe).
      //    Do: instead of two calls (fetch order → then addFee) — one chain
      //    c.pipe.order(id).addFee(5), all executes on server, only final goes over network.
      //    Use when: intermediate result unneeded, final matters — save network round-trips.
        const [cs, ss] = createLoopback()
        const api = { order: (id: string) => ({ id, addFee: (f: number) => ({ id, total: 70 + f }) }) }
        createRpcServer({ socket: ss, object: api, socketKey: "ord" })
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "ord" })
        await delay(0)
        await check("cookbook: pipe — серверная цепочка", () => c.pipe.order("x").addFee(5), { id: "x", total: 75 })
    }
    { // 6) DIFFERENT RIGHTS — one endpoint serves DIFFERENT method set depending on who's logged in.
      //    Do: present token (init with token) → server returns facade for role. viewer sees only
      //    quote, trader — also cancel. reauth("trader") changes rights DIRECTLY on live connection, no
      //    reconnection, no subscription loss. Use when: roles/access, privilege escalation on-the-fly.
        const [cs, ss] = createLoopback()
        const facades: Record<string, { quote: () => number; cancel?: () => string }> = {
            viewer: { quote: () => 42 },
            trader: { quote: () => 42, cancel: () => "ok" },
        }
        const resolveAuth = (t: string) => { const o = facades[t]; if (!o) throw new Error("bad token"); return { object: o, ack: { ok: true, who: t } } }
        createRpcServer({ socket: ss, object: {} as any, socketKey: "sess", auth: { resolveAuth, gate: true } })
        type Trader = { quote: () => number; cancel: () => string } // client knows superset facade
        const c = createRpcClient<Trader>({ socket: cs, socketKey: "sess", token: "viewer" })
        await c.init()
        await check("cookbook: логин — кто я", async () => (await c.auth())?.who, "viewer")
        await check("cookbook: viewer видит quote", () => c.func.quote(), 42)
        await c.reauth("trader")
        await check("cookbook: reauth — появился cancel", () => c.func.cancel(), "ok")
    }
    { // 7) FILTER/TRANSFORM STREAM BEFORE sending to client (mapListen).
      //    Do: from all orders only BUY go out and only their qty (SELL cut on server,
      //    null = skip event). Use when: don't want to send extra over network and filter on
      //    client — reduce volume and serve ready form.
        const [cs, ss] = createLoopback()
        type tOrder = { side: "BUY" | "SELL"; qty: number }
        const [emit, orders] = createListenPair<tOrder>()
        const [, buysQty] = mapListen<[tOrder], [number]>(orders, (o) => o.side == "BUY" ? [o.qty] : null)
        const obj = { buys: buysQty }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "flt" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "flt" })
        await delay(0)
        const got: number[] = []
        webListen(c).buys.callback((q) => got.push(q))
        await delay(5)
        emit({ side: "BUY", qty: 1 }); emit({ side: "SELL", qty: 9 }); emit({ side: "BUY", qty: 2 })
        await delay(10)
        await check("cookbook: серверный фильтр (только BUY)", async () => got, [1, 2])
    }
    { // 8) WAIT FOR EXACTLY ONE next event and immediately unsubscribe (once).
      //    Do: "give next fill and done" — callback fires once, then stream closed.
      //    Use when: one-time wait — operation confirmation, first tick, readiness signal.
        const [cs, ss] = createLoopback()
        const [emit, fills] = createListenPair<number>()
        const obj = { fills }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "fill" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "fill" })
        await delay(0)
        const got: number[] = []
        webListen(c).fills.once((v) => got.push(v))
        await delay(5)
        emit(11); await delay(3); emit(12); await delay(5)
        await check("cookbook: once() — только следующий fill", async () => got, [11])
    }
    { // 9) ERROR WITH MACHINE CODE, not just text (MyError arrives intact: code + data).
      //    Do: server throws MyError("...", "E_LIMIT", {max:100}); client catches and branches by
      //    e.code / e.data — reliable, no string parsing. Use when: predictable error handling
      //    (show right message, retry, highlight field) — this is error contract of API.
        const [cs, ss] = createLoopback()
        const api = {
            withdraw: (amount: number) => {
                if (amount > 100) throw new MyError("limit exceeded", "E_LIMIT", { max: 100 })
                return amount
            },
        }
        createRpcServer({ socket: ss, object: api, socketKey: "bank" })
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "bank" })
        await delay(0)
        await check("cookbook: ok-путь", () => c.func.withdraw(50), 50)
        await check("cookbook: ошибка по коду + data", () => c.func.withdraw(500).catch((e: any) => [e?.code, e?.data?.max]), ["E_LIMIT", 100])
    }
    { // 10) THROTTLE TOO-FREQUENT STREAM on server — don't drown network and client.
      //    Do: source ticks often, server returns first value immediately (leading) and last
      //    in window (trailing), collapses intermediate. Use when: noisy feeds — prices, telemetry,
      //    mouse events — where "first and last" matter, not every intermediate tick.
        const [cs, ss] = createLoopback()
        const [emit, ticks] = createListenPair<number>()
        const obj = { ticks }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "hz", throttle: 30 })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "hz" })
        await delay(0)
        const got: number[] = []
        webListen(c).ticks.on((v) => got.push(v))
        await delay(5)
        for (let i = 1; i <= 5; i++) { emit(i); await delay(2) } // 5 emissions in one window
        await delay(50) // wait for trailing
        // first (leading=1) arrives immediately, last (5) — at window edge; intermediate collapsed
        await check("cookbook: throttle — leading+trailing, не все тики", async () => [got[0], got[got.length - 1], got.length < 5], [1, 5, true])
    }

    await runRpcCallbackBatchTests()
    fails += await runRpcBinaryCodecTests()
    fails += await runRpcBinarySchemaTests()
    fails += await runRpcBinarySchemaIntegrationTests()
    fails += await runRpcBinaryTests()
    fails += await runRpcBinaryCompatTests()
    console.log(`\n${fails === 0 ? "ALL GREEN ✅" : fails + " FAILURE(S) ❌"}`)
    return fails
}

// auto-run only on direct file call (no side effects on import)
if (require.main === module) {
    runHarness().then(f => process.exit(f === 0 ? 0 : 1))
}
