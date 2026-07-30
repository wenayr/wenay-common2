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
// Run:   npx tsx src/Common/rcp/rpc.harness.spec.ts
// Excluded from build (*.spec.ts in tsconfig.exclude) — does NOT reach published lib.
// ===========================================================================

import { createRpcServer, type RpcServerControl } from "./rpc-server"
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
import { Caps, type RpcOpt } from "./rpc-caps"
import { createShapeRegistry, createShapeDecoder } from "./rpc-shape"
import { rpcPathKey } from "./rpc-path"
import { getRpcMemberState, getRpcTransportLifecycle, RPC_TRANSPORT_CONTROL } from "../events/transport-lifecycle"
import type { DeepSocketListen } from "./listen-deep"
import { MyError } from "../../toError/myThrow"
import { createStore, createStoreMirror, exposeStore, exposeStoreReplay, flushReactive, syncStoreReplay } from "../Observe"
import {runRpcCallbackBatchTests} from './rpc-callback-batch.spec'

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
        const ignored = c.func['neverSettles']()
        const awaited = c.func['neverSettles']()
        const awaitedResult = awaited.then(
            function unexpectedResolve() { return 'resolved' },
            function observeDisconnectReject(error: any) { return String(error?.message ?? error) },
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
        const pending = c.func['map']["mystrategy.2020"].start()
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
        await check("path-key: dynamic dotted prop", () => c.func['map']["mystrategy.2020"].start(), ["mystrategy.2020", "start"])
    }
    { // strict proxy: schema refresh changes path type, but not identity
        const [cs, ss] = createLoopback()
        const api: { node: any } = { node: { child: () => "before" } }
        const c = createRpcClient<any>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: api, socketKey: "rpc" })
        await delay(0)
        await c.initStrict({ node: { child: "func" } })
        const node = c.strict['node'] as any
        await check("strict/cache: object path rejects call", async () => {
            try { await node(); return false }
            catch { return true }
        }, true)
        api.node = () => "after"
        await c.initStrict({ node: "func" })
        await check("strict/cache: identity after type flip", async () => node == c.strict['node'], true)
        await check("strict/cache: call follows fresh schema", () => node(), "after")
    }
    {
        await check('proxy/cache: Node weak mode', async function verifyNodeWeakCache() {
            if (typeof globalThis.WeakRef != 'function' || typeof globalThis.FinalizationRegistry != 'function') {
                return [false, false, false]
            }
            const [cs, ss] = createLoopback()
            const api = {node: {ping: () => 'pong'}}
            const c = createRpcClient<typeof api>({socket: cs, socketKey: 'rpc'})
            createRpcServer({socket: ss, object: api, socketKey: 'rpc'})
            try {
                const node = c.func.node
                const ping = node.ping
                await c.initStrict()
                return [
                    node == c.func.node,
                    ping == c.func.node.ping,
                    c.strict.node == c.strict.node,
                ]
            } finally {
                c.close('Node weak-cache test complete')
            }
        }, [true, true, true])
    }
    {
        await check('proxy/cache: Hermes strong fallback', async function verifyHermesFallback() {
            const weakRefDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WeakRef')
            const finalizationRegistryDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FinalizationRegistry')
            let c: RpcClientReturn<{node: {ping: () => string}}> | undefined
            try {
                Object.defineProperty(globalThis, 'WeakRef', {
                    configurable: true,
                    writable: true,
                    value: undefined,
                })
                Object.defineProperty(globalThis, 'FinalizationRegistry', {
                    configurable: true,
                    writable: true,
                    value: undefined,
                })

                const [cs, ss] = createLoopback()
                const api = {node: {ping: () => 'pong'}}
                c = createRpcClient<typeof api>({socket: cs, socketKey: 'rpc'})
                createRpcServer({socket: ss, object: api, socketKey: 'rpc'})
                const node = c.func.node
                const ping = node.ping
                const sameNode = node == c.func.node
                const samePing = ping == c.func.node.ping
                await c.initStrict()
                const sameStrictNode = c.strict.node == c.strict.node
                const result = await c.strict.node.ping()
                c.close('Hermes fallback test complete')
                c.dispose()
                return [sameNode, samePing, sameStrictNode, result]
            } finally {
                c?.close('Hermes fallback test cleanup')
                if (weakRefDescriptor) Object.defineProperty(globalThis, 'WeakRef', weakRefDescriptor)
                else delete (globalThis as any).WeakRef
                if (finalizationRegistryDescriptor) {
                    Object.defineProperty(globalThis, 'FinalizationRegistry', finalizationRegistryDescriptor)
                } else {
                    delete (globalThis as any).FinalizationRegistry
                }
            }
        }, [true, true, true, 'pong'])
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
        const sub = replaySubscribe<[number]>(c.func['oldReplay'] as any, value => values.push(value), {
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

    console.log("--- Stage 2: динамические токены (Pkt.AUTH / expiry / revoke) ---")
    { // lifetime: expiring → expired; principal откатан к базовому, исчезнувший поток обрезан
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const base = { who: () => "anon" }                          // анонимный facade: без stream
        const princ = { who: () => "user", stream: listen }
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const resolveAuth = (t: string) => ({
            object: princ,
            ack: { ok: true, who: t },
            expiresAt: Date.now() + 200,
            renewBeforeMs: 100,
        })
        createRpcServerAuto({ socket: ss, object: base, socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { who: () => string; stream: typeof listen }   // клиент знает надмножество
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        const sub = webListen(c).stream.on((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        await check("expiry: до дедлайна поток идёт", async () => got, [1])
        await delay(260) // expiring (+100) и expired (+200) уже отработали
        emit(2); await delay(10)
        await check("expiry: состояния expiring→expired", async () => notices.map((n) => n.state), ["expiring", "expired"])
        await check("expiry: поток обрезан", async () => got, [1])
        await check("expiry: principal откатан к базовому", () => c.func.who(), "anon")
        await check("expiry: подписка завершена (не висит)", () => Promise.race([sub.then(() => "ended"), delay(60).then(() => "hung")]), "ended")
    }
    { // auth БЕЗ expiresAt: reauth сохраняет узел → провод как раньше (ни CB_END, ни AUTH)
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const mk = (who: string) => who === "admin" ? { stream: listen, write: (x: number) => x } : { stream: listen }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        const wire = { ends: 0, auth: 0 }
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => {
            if (Array.isArray(d)) { if (d[0] === Pkt.CB_END) wire.ends++; if (d[0] === Pkt.AUTH) wire.auth++ }
            origEmit(e, d)
        }
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { stream: typeof listen; write: (x: number) => number }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        webListen(c).stream.on((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        await c.reauth("admin")
        emit(2); await delay(10)
        await check("reauth-keep: подписка не тронута", async () => got, [1, 2])
        await check("reauth-keep: ни CB_END, ни AUTH", async () => [wire.ends, wire.auth], [0, 0])
        await check("reauth-keep: новый principal видит write", () => c.func.write(7), 7)
    }
    { // revoke vs transient: только явный revoke роняет живую сессию
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const base = { who: () => "anon" }
        const princ = { who: () => "user", stream: listen }
        function resolveAuth(t: string) {
            if (t === "revoked") throw Object.assign(new Error("token revoked"), { revoke: true })
            if (t === "flaky") throw new Error("transient")
            return { object: princ, ack: { ok: true, who: t } }
        }
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        createRpcServerAuto({ socket: ss, object: base, socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { who: () => string; stream: typeof listen }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        const sub = webListen(c).stream.on((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        const soft = await c.reauth("flaky")
        emit(2); await delay(10)
        await check("reauth-fail: ok=false, сессия жива", async () => [soft?.ok, got, await c.func.who()], [false, [1, 2], "user"])
        await check("reauth-fail: AUTH не отправлялся", async () => notices.length, 0)
        const hard = await c.reauth("revoked")
        emit(3); await delay(10)
        await check("revoke: состояние revoked", async () => notices.map((n) => n.state), ["revoked"])
        await check("revoke: ack ok=false", async () => hard?.ok, false)
        await check("revoke: поток обрезан", async () => got, [1, 2])
        await check("revoke: principal откатан к базовому", () => c.func.who(), "anon")
        await check("revoke: подписка завершена (не висит)", () => Promise.race([sub.then(() => "ended"), delay(60).then(() => "hung")]), "ended")
    }

    console.log("--- Stage 2+: провайдер токенов (single-flight / soft renew / один ретрай) ---")
    { // провайдер: ОДИН вызов на волну (2 фасада), 'expiring' продлевает сессию, подписка жива
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const mk = (who: string) => ({ stream: listen, who: () => who })
        // первый принципал живёт коротко (ждём 'expiring'), обновлённый — долго
        const grant = (t: string) => ({
            object: mk(t),
            ack: { ok: true, who: t },
            expiresAt: Date.now() + (t === "t1" ? 160 : 60_000),
            renewBeforeMs: 120,
        })
        createRpcServerAuto({ socket: ss, object: mk("anon"), socketKey: "main", auth: { resolveAuth: grant } })
        createRpcServerAuto({ socket: ss, object: mk("anon"), socketKey: "side", auth: { resolveAuth: grant } })
        let calls = 0
        const seen: string[] = []
        type Princ = { stream: typeof listen; who: () => string }
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<Princ>(), side: r<Princ>() }),
            { token: async () => { calls++; await delay(20); return "t" + calls } },
        )
        hub.authListen((e) => seen.push(e.state))
        ss.emit("connect", 1)
        await hub.promise
        await check("провайдер: один вызов на хендшейк двух фасадов",
            async () => [calls, (await hub.facade.main.auth())?.who, (await hub.facade.side.auth())?.who], [1, "t1", "t1"])
        const got: number[] = []
        hub.facade.main.func.stream.callback((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        await delay(240) // 'expiring' с обоих фасадов (+40) и бывший дедлайн (+160) уже позади
        emit(2); await delay(10)
        await check("провайдер: две тревоги 'expiring' → один вызов", async () => [calls, seen.filter((s) => s === "expiring").length], [2, 2])
        await check("провайдер: продление мягкое — подписка жива", async () => got, [1, 2])
        await check("провайдер: новый principal у обоих фасадов",
            async () => [(await hub.facade.main.auth())?.who, (await hub.facade.side.auth())?.who], ["t2", "t2"])
        await check("провайдер: до истечения не дошло", async () => seen.filter((s) => s !== "expiring" && s !== "renewed"), [])
    }
    { // клиентский шов: ровно один ретрай, и только для «чистого» ожидающего вызова
        const [cs, ss] = createLoopback()
        const princ = { ping: () => "pong", boom: (cb: (v: number) => void) => { cb(1); return "s" } }
        function resolveAuth(t: string) {
            if (t !== "good") throw new Error("bad token")
            return { object: princ, ack: { ok: true } }
        }
        createRpcServer({ socket: ss, object: {} as typeof princ, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<typeof princ>({ socket: cs, socketKey: "rpc", token: "stale" })
        let issued = 0
        // на хендшейке токена ещё нет → сессия стартует отклонённой, как у протухшего клиента
        c.setTokenRenew(async () => { issued++; await delay(5); return issued === 1 ? null : "good" })
        await c.initStrict()
        await check("ретрай: старт с отклонённым токеном", async () => [issued, (await c.auth())?.ok], [1, false])
        c.space.ping()
        await delay(20)
        await check("ретрай: fire-and-forget не повторяется", async () => issued, 1)
        await check("ретрай: вызов с колбэком не повторяется", () => c.func.boom(() => {}).catch((e: any) => e?.code), "E_UNAUTHORIZED")
        await check("ретрай: колбэк не дёрнул обновление", async () => issued, 1)
        await check("ретрай: три параллельных вызова прошли",
            () => Promise.all([c.func.ping(), c.func.ping(), c.func.ping()]), ["pong", "pong", "pong"])
        await check("ретрай: обновление ровно одно на волну", async () => issued, 2)
        await check("ретрай: дальше без обновления", async () => [await c.func.ping(), issued], ["pong", 2])
    }
    { // провайдер отдаёт null: состояние всплывает через authListen, обновление не крутится
        const [cs, ss] = createLoopback()
        const base = { who: () => "anon" }
        const princ = { who: () => "user" }
        const grant = () => ({ object: princ, ack: { ok: true }, expiresAt: Date.now() + 120, renewBeforeMs: 80 })
        createRpcServerAuto({ socket: ss, object: base, socketKey: "main", auth: { resolveAuth: grant } })
        let calls = 0
        const seen: string[] = []
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => { calls++; return calls === 1 ? "short" : null } },
        )
        hub.authListen((e) => seen.push(e.state))
        ss.emit("connect", 1)
        await hub.promise
        await delay(400)
        await check("null-провайдер: поток состояний", async () => seen, ["expiring", "renewFailed", "expired", "renewFailed"])
        await check("null-провайдер: ровно один вызов на тревогу", async () => calls, 3)
        await check("null-провайдер: principal откатан к базовому", () => hub.facade.main.func.who(), "anon")
    }
    { // приоритет: явный connect(token) выигрывает у провайдера на СВОЁМ хендшейке
        const [cs, ss] = createLoopback()
        const mk = (who: string) => ({ who: () => who })
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("anon"), socketKey: "main", auth: { resolveAuth } })
        let calls = 0
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => { calls++; return "fromProvider" } },
        )
        const started = hub.connect("explicit")
        ss.emit("connect", 1)
        await started
        await check("приоритет: явный токен важнее провайдера",
            async () => [await hub.facade.main.func.who(), calls], ["explicit", 0])
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
        rows.state['a'] = 10
        rows.state['c'] = 3
        delete rows.state['b']
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
        book.state['BTC'] = 2; book.state['ETH'] = 5; delete book.state['BTC']
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

    console.log("--- Stage 3: харденинг динамических токенов (noStrict / ack / таймеры / часы) ---")
    { // noStrict-поддерево в схеме НЕ объявлено, поэтому его нет в keep — но это не доказательство
      // недостижимости: при истечении токена режется только объявленный узел, динамика живёт
        const [cs, ss] = createLoopback()
        const [emitDecl, declared] = createListenPair<number>()
        const [emitDyn, dynamic] = createListenPair<number>()
        const dyn = noStrict({ stream: dynamic })                   // виден только по строковому пути
        const base = { who: () => "anon", dyn }
        const princ = { who: () => "user", stream: declared, dyn }
        const resolveAuth = (t: string) => ({
            object: princ,
            ack: { ok: true, who: t },
            expiresAt: Date.now() + 80,
            renewBeforeMs: 40,
        })
        createRpcServerAuto({ socket: ss, object: base, socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { who: () => string; stream: typeof declared; dyn: { stream: typeof dynamic } }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const gotDecl: number[] = [], gotDyn: number[] = []
        webListen(c).stream.on((v) => gotDecl.push(v))
        webListen(c).dyn.stream.on((v) => gotDyn.push(v))
        await delay(10); emitDecl(1); emitDyn(1); await delay(10)
        await delay(120) // expiring (+40) и expired (+80) отработали
        emitDecl(2); emitDyn(2); await delay(20)
        await check("noStrict: объявленный узел обрезан", async () => gotDecl, [1])
        await check("noStrict: динамический поток пережил downgrade", async () => gotDyn, [1, 2])
        await check("noStrict: principal откатан к базовому", () => c.func.who(), "anon")
    }
    { // тот же узел при обычном reauth: повышение прав НЕ трогает динамический поток
        const [cs, ss] = createLoopback()
        const [emitDyn, dynamic] = createListenPair<number>()
        const dyn = noStrict({ stream: dynamic })
        const mk = (who: string) => who == "admin"
            ? { who: () => who, write: (x: number) => x, dyn }
            : { who: () => who, dyn }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        const wire = { ends: 0 }
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.CB_END) wire.ends++; origEmit(e, d) }
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { who: () => string; write: (x: number) => number; dyn: { stream: typeof dynamic } }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        webListen(c).dyn.stream.on((v) => got.push(v))
        await delay(10); emitDyn(1); await delay(10)
        await c.reauth("admin")
        emitDyn(2); await delay(10)
        await check("noStrict: reauth с повышением прав не рвёт поток", async () => [got, wire.ends], [[1, 2], 0])
        await check("noStrict: новый principal видит write", () => c.func.write(7), 7)
    }
    { // authAck после downgrade — {ok:false,state}; успешный токен снимает его начисто,
      // включая ответы на последующий STRICT (липкий ok:false пережил бы хороший токен)
        const [cs, ss] = createLoopback()
        const acks: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.MAP) acks.push(d[4]); origEmit(e, d) }
        let lifetime = 60 // второй грант выдаём уже бессрочным
        const resolveAuth = (t: string) => ({
            object: { who: () => t },
            ack: { ok: true, who: t },
            ...(lifetime ? { expiresAt: Date.now() + lifetime, renewBeforeMs: 30 } : {}),
        })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await delay(120)
        await check("ack: после expiry ok=false + state", async () => {
            const a = acks[acks.length - 1]
            return [a?.ok, a?.state]
        }, [false, "expired"])
        lifetime = 0
        const fresh = await c.reauth("user2")
        await check("ack: свежий токен снял ok:false", async () => [fresh?.ok, fresh?.who], [true, "user2"])
        cs.emit("rpc", Pkt.STRICT) // повторный STRICT: липкого ok:false не осталось
        await delay(20)
        await check("ack: STRICT после re-auth несёт ok:true", async () => {
            const a = acks[acks.length - 1]
            return [a?.ok, a?.state]
        }, [true, undefined])
        await check("ack: principal снова живой", () => c.func.who(), "user2")
    }
    { // detach во время проверки токена: отцепленный сервер не меняет principal и не взводит таймер
        const [cs, ss] = createLoopback()
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const seen = { changes: 0, disposes: 0 }
        async function resolveAuth(t: string) {
            await delay(40) // сервер успеют отцепить, пока токен проверяется
            return { object: { who: () => t }, ack: { ok: true, who: t }, expiresAt: Date.now() + 30, renewBeforeMs: 10 }
        }
        createRpcServer({
            socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth },
            hooks: { onPrincipalChange: () => { seen.changes++ }, onDispose: () => { seen.disposes++ } },
        })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        c.initStrict().catch(() => {}) // ответа на HELLO не будет: сервер отцепят раньше
        await delay(10)
        createRpcServer({ socket: ss, object: { who: () => "second" }, socketKey: "rpc" }) // detach первого
        await delay(150)
        await check("detach: principal отцепленного сервера не менялся", async () => [seen.changes, seen.disposes], [0, 1])
        await check("detach: таймер отцепленного сервера не выстрелил", async () => notices.length, 0)
    }
    { // повторные HELLO перевзводят таймеры, а не копят их: ровно одно expiring и одно expired
        const [cs, ss] = createLoopback()
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const resolveAuth = (t: string) => ({
            object: { who: () => t },
            ack: { ok: true, who: t },
            expiresAt: Date.now() + 120,
            renewBeforeMs: 60,
        })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "t1" })
        await c.initStrict()
        await c.reauth("t2"); await delay(20)
        await c.reauth("t3"); await delay(20)
        await delay(220) // дедлайн последнего гранта + запас; утечка дала бы лишние уведомления
        await check("таймеры: повторный HELLO не копит таймеры", async () => notices.map((n) => n.state), ["expiring", "expired"])
        await check("таймеры: после expiry principal базовый", () => c.func.who(), "anon")
    }
    { // часы: дедлайн дальше 24.8 суток не должен читаться как «уже истёк» (32-битный setTimeout)
        const [cs, ss] = createLoopback()
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const MONTH_MS = 30 * 24 * 60 * 60 * 1000
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t }, expiresAt: Date.now() + MONTH_MS })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await delay(60)
        await check("часы: месячный токен не истекает сразу", async () => [notices.length, await c.func.who()], [0, "user"])
    }
    { // часы: битая арифметика дедлайна (NaN) — не безлимит, а немедленный downgrade (fail closed)
        const [cs, ss] = createLoopback()
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const missing: number = undefined as any // «поле ttl не пришло» — типовая ошибка вызывающего
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t }, expiresAt: Date.now() + missing })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await delay(40)
        await check("часы: битый дедлайн падает закрыто", async () => [notices.map((n) => n.state), await c.func.who()], [["expired"], "anon"])
    }
    { // риск анонимного CAPS: Pkt.AUTH — control-пакет, а не переупаковка чужих колбэков.
      // Сырой (некоррелированный) пир на общем socket+key видит байты, но его CALL/RESP прежний
        const [cs, ss] = createLoopback()
        const seen: any[] = []
        cs.on("rpc", (d: any) => { if (Array.isArray(d)) seen.push(d) })
        const resolveAuth = (t: string) => ({
            object: { who: () => "user" },
            ack: { ok: true, who: t },
            expiresAt: Date.now() + 60,
            renewBeforeMs: 30,
        })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        cs.emit("rpc", [Pkt.CAPS, Caps.COMPACT | Caps.CB_BATCH | Caps.AUTH_STATE]) // без session/generation
        cs.emit("rpc", [Pkt.HELLO, "user"])
        await delay(20)
        cs.emit("rpc", [Pkt.CALL, 1, ["who"], [], true])
        await delay(90) // ответ на первый вызов, затем expiring (+30) и expired (+60)
        cs.emit("rpc", [Pkt.CALL, 2, ["who"], [], true])
        await delay(20)
        const resp = (id: number) => seen.filter((d) => d[0] === Pkt.RESP && d[1] === id).map((d) => d[2])
        await check("caps: у сырого пира обычный RESP до и после downgrade", async () => [resp(1), resp(2)], [["user"], ["anon"]])
        await check("caps: анонимный CAPS включает AUTH_STATE", async () => seen.filter((d) => d[0] === Pkt.AUTH).map((d) => d[1].state), ["expiring", "expired"])
    }

    console.log("--- Stage 4: корреляция HELLO ↔ MAP (свой ответ на reauth, а не чужой push) ---")
    { // downgrade прилетает, пока reauth в полёте: он НЕ ответ на этот HELLO — свой придёт позже
        const [cs, ss] = createLoopback()
        const states: string[] = []
        let slow = false
        async function resolveAuth(t: string) {
            if (slow) await delay(120) // истечение первого гранта успеет выстрелить в это окно
            return {
                object: { who: () => t },
                ack: { ok: true, who: t },
                ...(t === "user" ? { expiresAt: Date.now() + 60, renewBeforeMs: 30 } : {}),
            }
        }
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        c.onAuthState((e) => states.push(e.state))
        await c.initStrict()
        slow = true
        const inFlight = c.reauth("user2")
        await delay(80) // downgrade уже прошёл: без корреляции он бы и стал «ответом»
        const early = await Promise.race([inFlight, delay(0).then(() => "pending" as const)])
        const ack = await inFlight
        await check("корреляция: downgrade не резолвит чужой reauth", async () => early, "pending")
        await check("корреляция: reauth получил СВОЙ ответ", async () => [ack?.ok, ack?.who, ack?.state], [true, "user2", undefined])
        await check("корреляция: downgrade дошёл до наблюдателей", async () => states, ["expiring", "expired"])
        await check("корреляция: principal из ответа на reauth", () => c.func.who(), "user2")
    }
    { // отзыв — это ОТВЕТ на HELLO: его downgrade коррелирован, reauth не остаётся без ответа
        const [cs, ss] = createLoopback()
        const states: string[] = []
        const resolveAuth = (t: string) => {
            if (t === "bad") throw Object.assign(new Error("revoked hard"), { revoke: true })
            return { object: { who: () => t }, ack: { ok: true, who: t } }
        }
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        c.onAuthState((e) => states.push(e.state))
        await c.initStrict()
        const ack = await c.reauth("bad")
        await check("отзыв: reauth получил ответ-отказ", async () => [ack?.ok, ack?.state], [false, "revoked"])
        await check("отзыв: наблюдатели увидели revoked", async () => states, ["revoked"])
        await check("отзыв: principal откатан к базовому", () => c.func.who(), "anon")
    }
    { // ответа на HELLO не будет (сервер завис на проверке): reauth завершается, а не виснет
        const hanging = new Promise<any>(function neverAnswers() {})
        const resolveAuth = (t: string) => t === "hang"
            ? hanging
            : { object: { who: () => t }, ack: { ok: true, who: t } }
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const lost = c.reauth("hang")
        await delay(20)
        ;(c as any)[RPC_TRANSPORT_CONTROL].disconnect("link lost")
        await check("обрыв: HELLO без ответа завершается", async () => { const a = await lost; return [a?.ok, a?.reason] }, [false, "link lost"])

        const [cs2, ss2] = createLoopback()
        createRpcServer({ socket: ss2, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c2 = createRpcClient<{ who: () => string }>({ socket: cs2, socketKey: "rpc", token: "user" })
        await c2.initStrict()
        const dropped = c2.reauth("hang")
        await delay(20)
        c2.close("client closed")
        await check("close: HELLO без ответа завершается", async () => { const a = await dropped; return [a?.ok, a?.reason] }, [false, "client closed"])
    }
    { // сервер отцепили, пока он проверял токен: ответа не будет — reauth закрывает смена поколения
        const [cs, ss] = createLoopback()
        const resolveAuth = async (t: string) => {
            if (t === "slow") await delay(200) // сервер успеют отцепить, пока токен проверяется
            return { object: { who: () => t }, ack: { ok: true, who: t } }
        }
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const orphan = c.reauth("slow")
        await delay(20)
        createRpcServer({ socket: ss, object: { who: () => "second" }, socketKey: "rpc" }) // detach первого
        const settled = await Promise.race([orphan, delay(120).then(() => "завис" as const)])
        await check("detach: HELLO отцепленного сервера завершается", async () => settled?.ok ?? settled, false)
    }
    { // сервер без Caps.HELLO_ID (старый): новый клиент не залипает — откат «ответ = следующий MAP»
        const [cs, ss] = createLoopback()
        const maps: number[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.MAP) maps.push(d.length); origEmit(e, d) }
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t } })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth }, opt: { helloId: false } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const ack = await c.reauth("user2")
        await check("старый сервер: reauth всё равно резолвится", async () => [ack?.ok, ack?.who], [true, "user2"])
        await check("старый сервер: 6-го элемента в MAP нет", async () => maps, [5, 5])
    }
    { // провод: id возвращается ТОЛЬКО в ответ на HELLO, который его прислал
        const [cs, ss] = createLoopback()
        const maps: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.MAP) maps.push(d); origEmit(e, d) }
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t } })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        cs.emit("rpc", [Pkt.HELLO, "old"]); await delay(20)               // старый клиент: id нет
        cs.emit("rpc", [Pkt.HELLO, "new", 77]); await delay(20)           // новый клиент: id есть
        cs.emit("rpc", [Pkt.HELLO, "junk", { oops: 1 }]); await delay(20) // мусорный id не эхуется
        cs.emit("rpc", Pkt.STRICT); await delay(20)                       // не ответ на HELLO — id нет
        await check("провод: id только в ответе на свой HELLO", async () => maps.map((m) => m.length), [5, 6, 5, 5])
        await check("провод: вернулся тот же id", async () => maps[1][5], 77)
    }
    { // два HELLO внахлёст (режим по-прежнему не рекомендован): каждый reauth видит СВОЙ ответ
        const [cs, ss] = createLoopback()
        const resolveAuth = async (t: string) => {
            await delay(t === "slow" ? 60 : 5) // ответы приходят в ОБРАТНОМ порядке к запросам
            return { object: { who: () => t }, ack: { ok: true, who: t } }
        }
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const [first, second] = await Promise.all([c.reauth("slow"), c.reauth("fast")])
        await check("внахлёст: каждый HELLO получил свой ack", async () => [first?.who, second?.who], ["slow", "fast"])
    }

    console.log("--- Stage 5: сервер сам рвёт сессию (control.revoke / control.grant) ---")
    { // приложение рвёт сессию само (админ, логаут с другого устройства, сигнал фрода):
      // тот же коридор, что и истечение токена — клиент наблюдает ровно то же состояние
        async function runSession(revoke: boolean, lifetime?: number) {
            const [cs, ss] = createLoopback()
            const [emit, listen] = createListenPair<number>()
            const base = { who: () => "anon" }
            const princ = { who: () => "user", stream: listen, secret: () => "s" }
            const resolveAuth = (t: string) => ({
                object: princ,
                ack: { ok: true, who: t },
                ...(lifetime ? { expiresAt: Date.now() + lifetime, renewBeforeMs: 30 } : {}),
            })
            // так это выглядит у приложения: внутри io.on('connection') — реестр живых сессий
            const sessions = new Map<string, RpcServerControl>()
            const { control } = createRpcServerAuto({ socket: ss, object: base, socketKey: "rpc", auth: { resolveAuth, gate: true } })
            sessions.set("user", control)
            type Princ = { who: () => string; stream: typeof listen; secret: () => string }
            const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
            const states: string[] = []
            c.onAuthState((e) => states.push(e.state))
            await c.initStrict()
            const got: number[] = []
            const sub = webListen(c).stream.on((v) => got.push(v))
            await delay(10); emit(1); await delay(10)
            if (revoke) sessions.get("user")!.revoke("вышел с другого устройства") // клиент ни о чём не просил
            await delay(120) // здесь же истекает дедлайн, если он выдавался
            emit(2); await delay(10)
            const call = await c.func.secret().then(() => "ok", (e: any) => e?.code)
            const ended = await Promise.race([sub.then(() => "ended"), delay(60).then(() => "hung")])
            return { states, got, ok: (await c.auth())?.ok, ended, call }
        }
        const timer = await runSession(false, 60) // истечение токена — прежний путь
        const seam = await runSession(true)       // отзыв из приложения — новый шов
        await check("отзыв: поток обрезан, как при истечении", async () => [seam.got, timer.got], [[1], [1]])
        await check("отзыв: привилегированный вызов отбит", async () => [seam.call, timer.call], ["E_UNAUTHORIZED", "E_UNAUTHORIZED"])
        await check("отзыв: подписка завершена (не висит)", async () => [seam.ended, timer.ended], ["ended", "ended"])
        await check("отзыв: ack ok=false у обоих", async () => [seam.ok, timer.ok], [false, false])
        await check("отзыв: состояния различает только имя", async () => [seam.states, timer.states], [["revoked"], ["expiring", "expired"]])
    }

    { // шов безопасен в любой момент: до HELLO, дважды подряд, после detach — и без утечки таймеров
        const [cs, ss] = createLoopback()
        const notices: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.AUTH) notices.push(d[1]); origEmit(e, d) }
        const resolveAuth = (t: string) => ({
            object: { who: () => t },
            ack: { ok: true, who: t },
            expiresAt: Date.now() + 200,
            renewBeforeMs: 100,
        })
        const first = createRpcServerAuto({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        await check("шов: отзыв до HELLO безвреден", async () => first.control.revoke("никто ещё не пришёл"), true)
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await check("шов: отзыв до HELLO не чернит токен", async () => [(await c.auth())?.who, await c.func.who()], ["user", "user"])
        first.control.revoke("раз")
        await check("шов: второй отзыв подряд безвреден", async () => first.control.revoke("два"), true)
        await delay(260) // и предупреждение (+100), и дедлайн (+200) уже позади: отзыв снял таймеры
        await check("шов: отзыв снял таймеры гранта", async () => notices.map((n) => n.state), ["revoked", "revoked"])
        await check("шов: principal откатан к базовому", () => c.func.who(), "anon")
        createRpcServerAuto({ socket: ss, object: { who: () => "second" }, socketKey: "rpc" }) // detach первого
        await check("шов: после detach — no-op, не бросает",
            async () => [first.control.revoke("поздно"), first.control.grant({ object: { who: () => "late" } })], [false, false])
        await delay(20)
        await check("шов: отцепленный сервер молчит", async () => notices.length, 2)
    }

    { // выдача из приложения: право пришло не от клиента (step-up завершился в другом месте),
      // а коридор тот же — фасад, ack, дедлайн; MAP не коррелирован, потому что вопроса не было
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const anon = { who: () => "anon" }
        const princ = { who: () => "user", stream: listen, write: (x: number) => x }
        const maps: any[] = []
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.MAP) maps.push(d); origEmit(e, d) }
        const deadline = Date.now() + 60_000
        const resolveAuth = () => { throw new Error("токены здесь не выдают") }
        const { control } = createRpcServerAuto({ socket: ss, object: anon, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        type Princ = { who: () => string; stream: typeof listen; write: (x: number) => number }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "свой-токен-не-подошёл" })
        await c.initStrict()
        await check("выдача: до неё вызовы отбиты", () => c.func.who().catch((e: any) => e?.code), "E_UNAUTHORIZED")
        control.grant({ object: princ, ack: { ok: true, who: "user" }, expiresAt: deadline })
        await delay(20)
        const got: number[] = []
        webListen(c).stream.on((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        await check("выдача: фасад принципала доступен", async () => [await c.func.who(), await c.func.write(7)], ["user", 7])
        await check("выдача: поток принципала пошёл", async () => got, [1])
        await check("выдача: ack приложения дошёл целиком", async () => { const a = await c.auth(); return [a?.ok, a?.who] }, [true, "user"])
        await check("выдача: дедлайн приехал в ack", async () => (await c.auth())?.$rpc?.expiresAt, deadline)
        await check("выдача: MAP без корреляции (ответа никто не ждал)", async () => maps[maps.length - 1].length, 5)
    }

    { // ack принадлежит ПРИЛОЖЕНИЮ: дедлайн едет отдельным полем $rpc и ничего не затирает
        const [cs, ss] = createLoopback()
        const at = Date.now() + 60_000
        function resolveAuth(t: string) {
            if (t === "своё") return { object: { who: () => t }, ack: { ok: true, who: t, $rpc: "моё" }, expiresAt: at }
            if (t === "строка") return { object: { who: () => t }, ack: "просто строка", expiresAt: at }
            if (t === "бессрочный") return { object: { who: () => t }, ack: { ok: true, who: t } }
            return { object: { who: () => t }, ack: { ok: true, who: t }, expiresAt: at }
        }
        const { control } = createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        await check("дедлайн: ack приложения цел, дедлайн рядом",
            async () => { const a = await c.auth(); return [a?.ok, a?.who, a?.$rpc?.expiresAt] }, [true, "user", at])
        await check("дедлайн: чужой $rpc не затирается", async () => (await c.reauth("своё"))?.$rpc, "моё")
        await check("дедлайн: ack-не-объект не оборачивают", async () => await c.reauth("строка"), "просто строка")
        await check("дедлайн: без дедлайна поля нет", async () => (await c.reauth("бессрочный"))?.$rpc, undefined)
        await check("шов: есть и у голого createRpcServer",
            async () => { control.revoke("голый сервер"); await delay(20); const a = await c.auth(); return [a?.state, await c.func.who()] },
            ["revoked", "anon"])
    }

    { // отзыв прилетел, пока сервер проверял токен: грант, начатый РАНЬШЕ отзыва, не воскрешает
      // принципала — но HELLO всё равно получает свой ответ, иначе reauth() повис бы навсегда
        const [cs, ss] = createLoopback()
        async function resolveAuth(t: string) {
            await delay(60) // приложение успевает отозвать сессию, пока токен проверяется
            return { object: { who: () => t }, ack: { ok: true, who: t } }
        }
        const { control } = createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const inFlight = c.reauth("user2")
        await delay(20)
        control.revoke("бан во время проверки токена")
        const ack = await inFlight
        await check("гонка: поздний грант не отменяет отзыв", async () => [ack?.ok, ack?.state], [false, "revoked"])
        await check("гонка: вызовы после отзыва отбиты", () => c.func.who().catch((e: any) => e?.code), "E_UNAUTHORIZED")
    }

    console.log("--- Stage 6: клиент (одна волна явного токена / один init / anon auth() / renewed) ---")
    { // явный токен принадлежит ОДНОЙ волне: переподключение спрашивает провайдера, а не его
        const [cs, ss] = createLoopback()
        const mk = (who: string) => ({ who: () => who })
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("anon"), socketKey: "main", auth: { resolveAuth } })
        let calls = 0
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => "p" + ++calls },
        )
        const started = hub.connect("явный")
        ss.emit("connect", 1)
        await started
        await check("волна: явный connect выиграл свой хендшейк",
            async () => [await hub.facade.main.func.who(), calls], ["явный", 0])
        await hub.reauth("ручной") // мягкая смена принципала на ЖИВОМ сокете: своя волна уже прошла
        await check("волна: reauth сменил принципал", () => hub.facade.main.func.who(), "ручной")
        ss.emit("disconnect", "transport close")
        await delay(20)
        ss.emit("connect", 2) // новая волна: явный/ручной токен больше не предъявляют
        await delay(60)
        await check("волна: переподключение спросило провайдера",
            async () => [await hub.facade.main.func.who(), calls], ["p1", 1])
    }
    { // двойной init: initStrict (хаб) + ready() (приложение) — один токен и один HELLO
        const [cs, ss] = createLoopback()
        const hellos: any[] = []
        const origEmit = cs.emit.bind(cs)
        cs.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.HELLO) hellos.push(d[1]); origEmit(e, d) }
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t } })
        createRpcServer({ socket: ss, object: { who: () => "anon" }, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<{ who: () => string }>({ socket: cs, socketKey: "rpc" })
        let minted = 0
        c.setTokenRenew(async () => "t" + ++minted) // одноразовый эмитент: каждый вызов — НОВЫЙ токен
        await c.initStrict()
        await c.readyStrict()
        await c.ready()
        await check("двойной init: один токен на соединение", async () => [minted, hellos], [1, ["t1"]])
        await check("двойной init: принципал от первого токена", () => c.func.who(), "t1")
    }
    { // документированный путь: await hub.promise → readyStrict() фасада — тоже один токен
        const [cs, ss] = createLoopback()
        const hellos: any[] = []
        const origEmit = cs.emit.bind(cs)
        cs.emit = (e, d) => { if (Array.isArray(d) && d[0] === Pkt.HELLO) hellos.push(d[1]); origEmit(e, d) }
        const resolveAuth = (t: string) => ({ object: { who: () => t }, ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: { who: () => "anon" }, socketKey: "main", auth: { resolveAuth } })
        let minted = 0
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => "t" + ++minted },
        )
        ss.emit("connect", 1)
        const clients = await hub.promise
        await clients.main.readyStrict()
        await check("хаб: readyStrict после хендшейка не тратит токен", async () => [minted, hellos], [1, ["t1"]])
        await check("хаб: принципал от выданного токена", () => clients.main.func.who(), "t1")
    }
    { // клиент БЕЗ токена против gate-сервера: ack не придёт никогда — auth() отвечает локально
        const [cs, ss] = createLoopback()
        const resolveAuth = (t: string) => ({ object: { ping: () => "pong" }, ack: { ok: true, who: t } })
        createRpcServer({ socket: ss, object: {} as { ping: () => string }, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<{ ping: () => string }>({ socket: cs, socketKey: "rpc" })
        await c.initStrict()
        await check("аноним: auth() отвечает, а не виснет",
            async () => { const a: any = await Promise.race([c.auth(), delay(60).then(() => "завис")]); return [a?.ok, a?.reason] },
            [false, "RPC client presented no token"])
        await check("аноним: gate по-прежнему отбивает вызов", () => c.func.ping().catch((e: any) => e?.code), "E_UNAUTHORIZED")
        const ack = await c.reauth("свой") // предъявленный токен отвечает СВОИМ ack, а не локальным
        await check("аноним: после HELLO ack настоящий", async () => [ack?.ok, (await c.auth())?.who], [true, "свой"])
    }
    { // успешное продление — событие на том же потоке, с НОВЫМ дедлайном из ack ($rpc)
        const [cs, ss] = createLoopback()
        const deadlines: number[] = []
        const events: any[] = []
        const grant = (t: string) => {
            const expiresAt = Date.now() + (t === "t1" ? 120 : 60_000)
            deadlines.push(expiresAt)
            return { object: { who: () => t }, ack: { ok: true, who: t }, expiresAt, renewBeforeMs: 60 }
        }
        createRpcServerAuto({ socket: ss, object: { who: () => "anon" }, socketKey: "main", auth: { resolveAuth: grant } })
        let calls = 0
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => "t" + ++calls },
        )
        hub.authListen((e) => events.push(e))
        ss.emit("connect", 1)
        await hub.promise
        await delay(200) // 'expiring' (+60) → продление; новый грант живёт долго, истечения нет
        await check("продление: поток состояний", async () => events.map((e) => e.state), ["expiring", "renewed"])
        await check("продление: событие несёт НОВЫЙ дедлайн", async () => events[1]?.expiresAt, deadlines[1])
        await check("продление: событие названо своим фасадом", async () => events[1]?.key, "main")
        await check("продление: принципал обновлён", () => hub.facade.main.func.who(), "t2")
    }
    { // дедлайна может не быть (старый сервер, бессрочный грант) — событие всё равно есть
        const [cs, ss] = createLoopback()
        const events: any[] = []
        const grant = (t: string) => ({
            object: { who: () => t },
            ack: { ok: true, who: t },
            ...(t === "t1" ? { expiresAt: Date.now() + 120, renewBeforeMs: 60 } : {}), // второй грант бессрочный
        })
        createRpcServerAuto({ socket: ss, object: { who: () => "anon" }, socketKey: "main", auth: { resolveAuth: grant } })
        let calls = 0
        const hub = createRpcClientHub(
            () => Object.assign(cs, { disconnect: () => {} }),
            r => ({ main: r<{ who: () => string }>() }),
            { token: async () => "t" + ++calls },
        )
        hub.authListen((e) => events.push(e))
        ss.emit("connect", 1)
        await hub.promise
        await delay(200)
        const last = events[events.length - 1]
        await check("продление без дедлайна: событие есть", async () => [last?.state, last?.expiresAt], ["renewed", undefined])
        await check("продление без дедлайна: истечения не было", async () => events.map((e) => e.state), ["expiring", "renewed"])
    }

    console.log("--- Stage 7: один кадр на всплеск (Caps.REQ_BATCH) ---")
    // Кандидат из experiments/rpc-perf-2026-07: burst шёл ровно 1.00 логическому пакету на кадр
    // в ОБЕ стороны. Бит опциональный, поэтому «старый пир» здесь не абстракция, а обязательная
    // вторая половина проверки: без бита провод должен совпасть побайтно с сегодняшним.
    function tapPackets(s: SocketTmpl) {
        const seen: any[] = []
        const orig = s.emit.bind(s)
        s.emit = (e, d) => { seen.push(d); orig(e, d) }
        return seen
    }
    const C2S_OPS: number[] = [Pkt.BATCH, Pkt.CALL, Pkt.PIPE]
    const S2C_OPS: number[] = [Pkt.BATCH, Pkt.RESP, Pkt.CB, Pkt.CB_BATCH, Pkt.CB_END, Pkt.SHAPE, Pkt.CBV]
    const appOut = (seen: any[]) => seen.filter((d) => Array.isArray(d) && C2S_OPS.includes(d[0]))
    const appBack = (seen: any[]) => seen.filter((d) => Array.isArray(d) && S2C_OPS.includes(d[0]))
    // Кадры как они есть: конверт разворачивается в массив опкодов, одиночный пакет — просто опкод.
    const shapeOf = (seen: any[]) => seen.map((d) => d[0] === Pkt.BATCH ? (d[1] as any[]).map((p) => p[0]) : d[0])
    const logicalOf = (seen: any[]) => seen.flatMap((d) => d[0] === Pkt.BATCH ? (d[1] as any[]).map((p) => p[0]) : [d[0]])

    { // 50 вызовов одним синхронным всплеском: один кадр туда, один обратно, порядок сохранён
        const [cs, ss] = createLoopback()
        const burstObj = { seq: (n: number) => n * 2 }
        const c = createRpcClient<typeof burstObj>({ socket: cs, socketKey: "rpc", opt: { requestBatch: true } })
        createRpcServer({ socket: ss, object: burstObj, socketKey: "rpc", opt: { requestBatch: true } })
        await c.initStrict()
        await delay(5)
        const out = tapPackets(cs), back = tapPackets(ss)
        const got = await Promise.all(Array.from({ length: 50 }, (_, i) => c.func.seq(i)))
        await check("конверт: 50 вызовов вернулись по порядку", async () => got, Array.from({ length: 50 }, (_, i) => i * 2))
        await check("конверт: один кадр CALL и один кадр RESP",
            async () => [appOut(out).length, appBack(back).length], [1, 1])
        await check("конверт: внутри ровно 50 и 50",
            async () => [appOut(out)[0][1].length, appBack(back)[0][1].length], [50, 50])
        await check("конверт: порядок ответов = порядку вызовов",
            async () => eq(appOut(out)[0][1].map((p: any[]) => p[1]), appBack(back)[0][1].map((p: any[]) => p[1])), true)
        await check("конверт: id сессии уцелел в 6-м элементе",
            async () => appOut(out)[0][1].every((p: any[]) => Number.isSafeInteger(p[5])), true)
    }

    { // ответ едет ЗА своими колбэками: барьер снят, порядок держится позицией в конверте
        const [cs, ss] = createLoopback()
        const mixObj = {
            plain: (n: number) => n,
            twice: (cb: (i: number) => void) => { cb(1); cb(2); return "готово" },
        }
        const c = createRpcClient<typeof mixObj>({ socket: cs, socketKey: "rpc", opt: { requestBatch: true } })
        createRpcServer({ socket: ss, object: mixObj, socketKey: "rpc", opt: { requestBatch: true } })
        await c.initStrict()
        await delay(5)
        const back = tapPackets(ss)
        const ticks: number[] = []
        const settled: string[] = []
        const [plain, twice] = await Promise.all([
            c.func.plain(5).then((v) => { settled.push("plain"); return v }),
            c.func.twice((v) => ticks.push(v)).then((v) => { settled.push("twice"); return v }),
        ])
        await check("конверт: колбэки дошли до ответа", async () => [ticks, plain, twice], [[1, 2], 5, "готово"])
        await check("конверт: CB раньше RESP на проводе",
            async () => logicalOf(appBack(back)), [Pkt.CB, Pkt.CB, Pkt.RESP, Pkt.RESP])
        await check("конверт: ответ уехал в одном кадре с чужими колбэками",
            async () => shapeOf(appBack(back)), [[Pkt.CB, Pkt.CB, Pkt.RESP], Pkt.RESP])
        await check("конверт: оба вызова разрешились", async () => settled.sort(), ["plain", "twice"])
    }

    { // старый пир (бит не согласован) видит СЕГОДНЯШНИЙ провод — сравниваем побайтно
        async function wireOf(clientOpt: RpcOpt | undefined, serverOpt: RpcOpt | undefined) {
            const [cs, ss] = createLoopback()
            const obj = { seq: (n: number) => n * 2 }
            const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc", opt: clientOpt })
            createRpcServer({ socket: ss, object: obj, socketKey: "rpc", opt: serverOpt })
            await c.initStrict()
            await delay(5)
            const out = tapPackets(cs), back = tapPackets(ss)
            await Promise.all([c.func.seq(1), c.func.seq(2), c.func.seq(3)])
            await delay(5)
            return JSON.stringify([appOut(out), appBack(back)])
        }
        const legacy = await wireOf(undefined, undefined)
        const clientOnly = await wireOf({ requestBatch: true }, undefined)
        const serverOnly = await wireOf(undefined, { requestBatch: true })
        const both = await wireOf({ requestBatch: true }, { requestBatch: true })
        await check("старый пир: только клиент просит — провод как был", async () => clientOnly, legacy)
        await check("старый пир: только сервер просит — провод как был", async () => serverOnly, legacy)
        await check("старый пир: без бита это 3 CALL и 3 RESP по отдельности",
            async () => JSON.parse(legacy).map((side: any[]) => side.map((d: any) => d[0])),
            [[Pkt.CALL, Pkt.CALL, Pkt.CALL], [Pkt.RESP, Pkt.RESP, Pkt.RESP]])
        await check("старый пир: с битом провод ДРУГОЙ (иначе тест ничего не доказывает)",
            async () => both == legacy, false)
    }

    { // бинарь конверту не по зубам: он уезжает своим кадром, но очередь не обгоняет
        const [cs, ss] = createLoopback()
        const binObj = { plain: (n: number) => n, blob: (data: Uint8Array) => new Uint8Array([7, 7, 7]) }
        const c = createRpcClient<typeof binObj>({ socket: cs, socketKey: "rpc", opt: { requestBatch: true } })
        createRpcServer({ socket: ss, object: binObj, socketKey: "rpc", opt: { requestBatch: true } })
        await c.initStrict()
        await delay(5)
        const out = tapPackets(cs), back = tapPackets(ss)
        await Promise.all([
            c.func.plain(1), c.func.plain(2), c.func.blob(new Uint8Array([1, 2, 3])), c.func.plain(3), c.func.plain(4),
        ])
        await delay(5)
        await check("бинарь: аргумент уехал своим пакетом",
            async () => shapeOf(appOut(out)), [[Pkt.CALL, Pkt.CALL], Pkt.CALL, [Pkt.CALL, Pkt.CALL]])
        await check("бинарь: результат вернулся своим пакетом",
            async () => shapeOf(appBack(back)), [[Pkt.RESP, Pkt.RESP], Pkt.RESP, [Pkt.RESP, Pkt.RESP]])
        await check("бинарь: соседей не обогнал", async () => logicalOf(appOut(out)).length, 5)
    }

    { // пакет выше байтового потолка едет один, а соседи по обе стороны — конвертами
        const [cs, ss] = createLoopback()
        const bigObj = { size: (s: string) => s.length }
        const tight: RpcOpt = { requestBatch: { maxBytes: 512 } }
        const c = createRpcClient<typeof bigObj>({ socket: cs, socketKey: "rpc", opt: tight })
        createRpcServer({ socket: ss, object: bigObj, socketKey: "rpc", opt: tight })
        await c.initStrict()
        await delay(5)
        const out = tapPackets(cs)
        const huge = "x".repeat(600)
        const got = await Promise.all([
            c.func.size("a"), c.func.size("b"), c.func.size(huge), c.func.size("c"), c.func.size("d"),
        ])
        await check("большой: уехал один, соседи в конвертах",
            async () => shapeOf(appOut(out)), [[Pkt.CALL, Pkt.CALL], Pkt.CALL, [Pkt.CALL, Pkt.CALL]])
        await check("большой: порядок не нарушен", async () => got, [1, 1, 600, 1, 1])
    }

    { // вызов без ожидания ответа делит кадр с соседями и всё равно выполняется на сервере
        const [cs, ss] = createLoopback()
        const seen: number[] = []
        const fireObj = { note: (n: number) => { seen.push(n); return n }, ask: (n: number) => n }
        const c = createRpcClient<typeof fireObj>({ socket: cs, socketKey: "rpc", opt: { requestBatch: true } })
        createRpcServer({ socket: ss, object: fireObj, socketKey: "rpc", opt: { requestBatch: true } })
        await c.initStrict()
        await delay(5)
        const out = tapPackets(cs), back = tapPackets(ss)
        const answers = await Promise.all([c.func.ask(1), c.space.note(7), c.func.ask(2)])
        await delay(10)
        await check("без ответа: три CALL в одном кадре",
            async () => shapeOf(appOut(out)), [[Pkt.CALL, Pkt.CALL, Pkt.CALL]])
        await check("без ответа: RESP только два",
            async () => shapeOf(appBack(back)), [[Pkt.RESP, Pkt.RESP]])
        await check("без ответа: сервер всё же выполнил вызов",
            async () => [seen, answers[0], answers[2]], [[7], 1, 2])
    }

    { // потребитель колбэка упал: ответ соседа по кадру не должен пропасть вместе с ним,
      // и ни одна из ошибок не имеет права исчезнуть по дороге к приложению
        function catchConsumerError(error: any) { reportThrown(error) }
        const [cs, ss] = createLoopback()
        const failObj = {
            plain: (n: number) => n,
            twice: (a: (i: number) => void, b: (i: number) => void) => { a(1); b(2); return "ок" },
        }
        const c = createRpcClient<typeof failObj>({ socket: cs, socketKey: "rpc", opt: { requestBatch: true } })
        createRpcServer({ socket: ss, object: failObj, socketKey: "rpc", opt: { requestBatch: true } })
        await c.initStrict()
        await delay(5)
        const back = tapPackets(ss)
        let reportThrown = function rememberLater(_error: any) {}
        const thrown = new Promise<any>((resolve) => { reportThrown = resolve })
        process.once("uncaughtException", catchConsumerError)
        const got: number[] = []
        const [plain, twice] = await Promise.all([
            c.func.plain(3),
            c.func.twice(
                (v) => { got.push(v); throw new Error("первый потребитель упал") },
                (v) => { got.push(v); throw new Error("второй потребитель упал") },
            ),
        ])
        const caught = await Promise.race([thrown, delay(100).then(() => "не дождались")])
        process.off("uncaughtException", catchConsumerError)
        await check("сироты: ответ соседа не потерялся", async () => [plain, twice], [3, "ок"])
        await check("сироты: оба колбэка доставлены", async () => got, [1, 2])
        await check("сироты: ответ и упавшие колбэки были в одном кадре",
            async () => shapeOf(appBack(back)), [[Pkt.CB, Pkt.CB, Pkt.RESP], Pkt.RESP])
        await check("сироты: ни одна ошибка не исчезла",
            async () => [caught instanceof AggregateError, caught?.errors?.map((e: Error) => e.message)],
            [true, ["первый потребитель упал", "второй потребитель упал"]])
    }

    console.log("--- Stage 9: строки вместо повторённых ключей (Caps.ROWS) ---")
    // Кандидат из experiments/rpc-perf-2026-07: 63 000 из 127 896 байт результата на 1000 записей —
    // это повторённые имена ключей (49.26 %), и ни одна из этих записей не тик.
    // Бит включён ПО УМОЛЧАНИЮ (измерения третьего прохода), поэтому «старый пир» — это явный
    // отказ, а не отсутствие опции: сравнивать с undefined значило бы сравнивать бит сам с собой.
    const ROWS: RpcOpt = { compactRows: true }
    const NO_ROWS: RpcOpt = { compactRows: false }
    const ROWS_NB: RpcOpt = { compactRows: true, callbackBatch: false }
    type tBar = { time: Date; open: number; high: number; low: number; close: number; volume: number }
    const makeBar = (i: number): tBar => ({
        time: new Date(1_700_000_000_000 + i * 60_000),
        open: i, high: i + 2, low: i - 1, close: i + 1, volume: i * 10,
    })
    const barsObj = {
        bars: (n: number) => Array.from({ length: n }, (_, i) => makeBar(i)),
        mixed: () => [makeBar(0), { time: new Date(0), open: 1 }, makeBar(2), makeBar(3)],
        pair: () => [makeBar(0), makeBar(1)],
        feed: (n: number, cb: (b: tBar) => void) => { for (let i = 0; i < n; i++) cb(makeBar(100 + i)); return "готово" },
        // Никогда не отвечает: подсунутый ответ — единственный, который придёт. С настоящим
        // ответом освобождённый reqId переиспользуется, и поздний RESP снял бы СЛЕДУЮЩИЙ вызов.
        hang: () => new Promise<string>(function neverSettle() {}),
        ping: () => "жив",
        holes: () => Array.from({ length: 6 }, (_, i) => ({ a: i, b: i == 3 ? undefined : i * 2 })),
    }
    function rowsClient(opt: RpcOpt | undefined, limits?: any) {
        const [cs, ss] = createLoopback()
        const c = createRpcClient<typeof barsObj>({ socket: cs, socketKey: "rpc", opt, limits })
        createRpcServer({ socket: ss, object: barsObj, socketKey: "rpc", opt })
        return { c, cs, ss }
    }

    { // массив однородных записей: значение то же, что и на обычном проводе, а байт меньше
        async function callBars(opt: RpcOpt | undefined) {
            const { c, ss } = rowsClient(opt)
            await c.initStrict()
            await delay(5)
            const back = tapPackets(ss)
            const got = await c.func.bars(200)
            await delay(5)
            const resp = appBack(back).find((d) => d[0] == Pkt.RESP)
            return { got, resp, bytes: JSON.stringify(resp).length }
        }
        const plain = await callBars(NO_ROWS)
        const rows = await callBars(ROWS)
        await check("строки: значение совпало с обычным проводом", async () => eq(rows.got, plain.got), true)
        await check("строки: Date внутри записи пережил таблицу",
            async () => [rows.got[7].time instanceof Date, rows.got[7].time.valueOf()],
            [true, plain.got[7].time.valueOf()])
        await check("строки: таблица есть только там, где бит согласован",
            async () => [JSON.stringify(rows.resp).includes("$_t"), JSON.stringify(plain.resp).includes("$_t")],
            [true, false])
        await check("строки: ответ похудел больше чем на треть",
            async () => rows.bytes < plain.bytes * 0.67, true)
    }

    { // неоднородный массив не таблица, и слишком короткий — тоже: порог считается ВНУТРИ пакета
        const { c, ss } = rowsClient(ROWS)
        await c.initStrict()
        await delay(5)
        const back = tapPackets(ss)
        const mixed = await c.func.mixed()
        const pair = await c.func.pair()
        await delay(5)
        await check("строки: разнородный и короткий массивы не свернулись",
            async () => JSON.stringify(appBack(back)).includes("$_t"), false)
        await check("строки: их значения целы",
            async () => [mixed.length, (mixed[1] as any).open, pair.length, pair[1].close], [4, 1, 2, 2])
    }

    { // undefined в записи: JSON выкидывает его из объекта и пишет null в массиве, поэтому
      // таблица от такого массива ОТКАЗЫВАЕТСЯ — лучше не сэкономить, чем тихо подменить смысл
        async function holesOf(opt: RpcOpt) {
            const { c, ss } = rowsClient(opt)
            await c.initStrict()
            await delay(5)
            const back = tapPackets(ss)
            const got: any = await c.func.holes()
            await delay(5)
            return { got, wire: JSON.stringify(appBack(back)) }
        }
        const plain = await holesOf(NO_ROWS)
        const rows = await holesOf(ROWS)
        await check("undefined: массив с дыркой не свернулся в таблицу",
            async () => rows.wire.includes("$_t"), false)
        await check("undefined: значение совпало с обычным проводом до ключа",
            async () => [eq(rows.got, plain.got), "b" in rows.got[3], rows.got[2].b], [true, false, 4])
    }

    { // реестр общий: форму зарегистрировал ОТВЕТ, а воспользовался ею первый же тик
        const { c, ss } = rowsClient(ROWS_NB)
        await c.initStrict()
        await delay(5)
        await c.func.bars(8)
        await delay(5)
        const back = tapPackets(ss)
        const seen: tBar[] = []
        const done = await c.func.feed(1, (b) => seen.push(b))
        await delay(5)
        await check("реестр: тик встал на форму ответа, минуя порог в 5 повторов",
            async () => logicalOf(appBack(back)).filter((op) => op == Pkt.SHAPE || op == Pkt.CBV || op == Pkt.CB),
            [Pkt.SHAPE, Pkt.CBV])
        await check("реестр: тик собрался обратно правильно",
            async () => [done, seen.length, seen[0].open, seen[0].time instanceof Date], ["готово", 1, 100, true])
    }

    { // и наоборот: форму зарегистрировал поток тиков, а сэкономил на ней ответ
        const { c, ss } = rowsClient(ROWS_NB)
        await c.initStrict()
        await delay(5)
        const seen: tBar[] = []
        await c.func.feed(6, (b) => seen.push(b))
        await delay(5)
        const back = tapPackets(ss)
        await c.func.bars(8)
        await delay(5)
        const resp: any = appBack(back).find((d) => d[0] == Pkt.RESP)
        const shape: any = appBack(back).find((d) => d[0] == Pkt.SHAPE)
        await check("реестр: поток успел объявить форму", async () => seen.length, 6)
        await check("реестр: таблица ответа и Pkt.SHAPE потока — ОДИН id формы",
            async () => [Array.isArray(resp[2]?.$_t), resp[2]?.$_t?.[0]], [true, 0])
        await check("реестр: ключи таблица всё равно везёт с собой (сверка не может рассинхрониться)",
            async () => [resp[2]?.$_t?.length, resp[2]?.$_t?.[2]?.length], [3, 6])
        await check("реестр: тот же id уже уехал в Pkt.SHAPE до ответа", async () => shape, undefined)
    }

    { // старый пир (бит не согласован) видит СЕГОДНЯШНИЙ провод — сравниваем побайтно
        async function wireOf(clientOpt: RpcOpt | undefined, serverOpt: RpcOpt | undefined) {
            const [cs, ss] = createLoopback()
            const c = createRpcClient<typeof barsObj>({ socket: cs, socketKey: "rpc", opt: clientOpt })
            createRpcServer({ socket: ss, object: barsObj, socketKey: "rpc", opt: serverOpt })
            await c.initStrict()
            await delay(5)
            const out = tapPackets(cs), back = tapPackets(ss)
            const seen: tBar[] = []
            await c.func.bars(8)
            await c.func.feed(6, (b) => seen.push(b))
            await delay(10)
            return JSON.stringify([appOut(out), appBack(back)])
        }
        const legacy = await wireOf(NO_ROWS, NO_ROWS)
        const clientOnly = await wireOf(ROWS, NO_ROWS)
        const serverOnly = await wireOf(NO_ROWS, ROWS)
        const both = await wireOf(ROWS, ROWS)
        await check("старый пир: только клиент просит — провод как был", async () => clientOnly, legacy)
        await check("старый пир: только сервер просит — провод как был", async () => serverOnly, legacy)
        await check("старый пир: с битом провод ДРУГОЙ (иначе тест ничего не доказывает)",
            async () => both == legacy, false)
    }

    { // враждебный пир: таблица, которая не сходится, ОТВЕРГАЕТСЯ, а не достраивается
        const { c, cs, ss } = rowsClient(ROWS, { maxArrayLen: 16, maxKeys: 4, maxStringLen: 32 })
        await c.initStrict()
        await delay(5)
        const out = tapPackets(cs)
        // враждебный ответ подсовывается на место настоящего: id берём с провода
        async function injectResult(table: any) {
            const from = out.length
            const p = c.func.hang()
            await delay(5)
            const call: any = out.slice(from).find((d) => Array.isArray(d) && d[0] == Pkt.CALL)
            ss.emit("rpc", [Pkt.RESP, call[1], table])
            return await p.then((v) => "разрешилось: " + v, (e: any) => e?.name ?? String(e))
        }
        const strangeId = await injectResult({ $_t: [999999, [[1, 2], [3, 4]], ["a", "b"]] })
        const referencing = await injectResult({ $_t: [0, [[1, 2], [3, 4]]] })
        const badWidth = await injectResult({ $_t: [5000, [[1, 2], [3]], ["a", "b"]] })
        const tooManyRows = await injectResult({ $_t: [5001, Array.from({ length: 20 }, () => [1, 2]), ["a", "b"]] })
        const tooManyKeys = await injectResult({ $_t: [5002, [[1, 2, 3, 4, 5, 6]], ["a", "b", "c", "d", "e", "f"]] })
        const unsafeKey = await injectResult({ $_t: [5003, [[1, 2]], ["__proto__", "b"]] })
        const notATable = await injectResult({ $_t: 5 })
        await check("враждебный: чужой shapeId безвреден — таблица читает СВОИ ключи",
            async () => strangeId, "разрешилось: [object Object],[object Object]")
        await check("враждебный: ссылочная форма без ключей таблицей не считается",
            async () => referencing, "разрешилось: [object Object]")
        await check("враждебный: ширина строки не сошлась — отказ, а не добивка", async () => badWidth, "PayloadLimitError")
        await check("враждебный: строк больше maxArrayLen — отказ", async () => tooManyRows, "PayloadLimitError")
        await check("враждебный: ключей больше maxKeys — отказ", async () => tooManyKeys, "PayloadLimitError")
        await check("враждебный: небезопасный ключ — отказ", async () => unsafeKey, "PayloadLimitError")
        await check("враждебный: не таблица — не наше, значение доехало как объект",
            async () => notATable, "разрешилось: [object Object]")
        await check("враждебный: соединение после всего этого живо",
            async () => await c.func.ping(), "жив")
    }

    { // таблица НЕ пишет в таблицу форм тиков — иначе чужой shapeId переклеил бы ключи потока
        const { c, cs, ss } = rowsClient(ROWS_NB)
        await c.initStrict()
        await delay(5)
        const seen: tBar[] = []
        await c.func.feed(6, (b) => seen.push(b)) // форма 0 объявлена через Pkt.SHAPE
        await delay(5)
        const out = tapPackets(cs)
        const p = c.func.hang()
        await delay(5)
        const call: any = out.find((d) => Array.isArray(d) && d[0] == Pkt.CALL)
        // враждебная таблица заявляет ТУ ЖЕ форму 0 с другими ключами
        ss.emit("rpc", [Pkt.RESP, call[1], { $_t: [0, [[1, 2], [3, 4], [5, 6], [7, 8]], ["x", "y"]] }])
        const hostile: any = await p
        const after: tBar[] = []
        await c.func.feed(2, (b) => after.push(b))
        await delay(5)
        await check("изоляция: враждебная таблица прочлась своими ключами",
            async () => [hostile.length, hostile[0].x, hostile[0].y], [4, 1, 2])
        await check("изоляция: тики после неё всё ещё бары, а не x/y",
            async () => [after.length, after[0].open, after[0].time instanceof Date], [2, 100, true])
    }

    { // лимиты кусают и через таблицу: 20 записей против maxArrayLen 16
        const { c } = rowsClient(ROWS, { maxArrayLen: 16 })
        await c.initStrict()
        await delay(5)
        const verdict = await c.func.bars(20).then(() => "разрешилось", (e: any) => e?.name ?? String(e))
        const ok = await c.func.bars(8)
        await check("лимиты: длинная таблица отвергнута как длинный массив", async () => verdict, "PayloadLimitError")
        await check("лимиты: короткая проходит", async () => ok.length, 8)
    }

    { // реестр ограничен и ВЫТЕСНЯЕТ, а не растёт: это и есть починка хвоста из бенчмарка
        const registry = createShapeRegistry()
        for (let i = 0; i < 200; i++) {
            const rec: any = { ["a" + i]: 1, ["b" + i]: 2, ["c" + i]: 3 }
            registry.offerRows([rec, rec, rec, rec])
        }
        const decoder = createShapeDecoder()
        for (let i = 0; i < 900; i++) decoder.declare(i, ["a", "b"])
        await check("реестр: кодировщик не растёт без границы", async () => registry.size() <= 64, true)
        await check("реестр: декодер не растёт без границы", async () => decoder.size() <= 256, true)
        await check("реестр: вытесненный id декодеру больше не известен", async () => decoder.keysOf(0), undefined)
        await check("реестр: свежий id на месте", async () => decoder.keysOf(899), ["a", "b"])

        const reg = createShapeRegistry()
        const rec = { a: 1, b: 2 }
        const table = reg.offerRows([rec, rec, rec, rec])
        const tick1 = reg.offerTick(7, rec)
        const tick2 = reg.offerTick(7, rec)
        reg.forgetSession(7)
        const tick3 = reg.offerTick(7, rec)
        await check("реестр: массив избавил поток от порога, а Pkt.SHAPE едет раз на сессию",
            async () => [tick1.mode, tick2.mode, tick3.mode], ["register", "compact", "register"])
        await check("реестр: у таблицы и у тиков один и тот же id формы",
            async () => [table?.shapeId, (tick1 as any).shapeId, (tick3 as any).shapeId], [0, 0, 0])

        // Порог всё ещё существует там, где форма — предсказание, а не факт
        const lonely = createShapeRegistry()
        const odd = { z: 1 }
        const modes = [1, 2, 3, 4, 5].map(() => lonely.offerTick(3, odd).mode)
        await check("порог: одиночный поток стандартизуется только на 5-м повторе",
            async () => modes, ["full", "full", "full", "full", "register"])
    }

    await runRpcCallbackBatchTests()

    console.log(`\n${fails === 0 ? "ALL GREEN ✅" : fails + " FAILURE(S) ❌"}`)
    return fails
}

// auto-run only on direct file call (no side effects on import)
if (require.main === module) {
    runHarness().then(f => process.exit(f === 0 ? 0 : 1))
}
