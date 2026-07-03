// ===========================================================================
// RPC HARNESS — реальная тест-среда для ядра rcp (это GATE из PLAN / II-1).
//
// Поднимает НАСТОЯЩИЙ клиент + НАСТОЯЩИЙ сервер в одном процессе через
// in-memory loopback-транспорт (emit одного конца → on другого) и гоняет ОБА канала:
//   • CALL  — запрос/ответ (client.func.method(args) → Promise результата);
//   • CB    — server→client колбэки/стримы (функция в аргументах = второй канал);
//   • PIPE  — серверные цепочки (client.pipe.method().chain.value).
// Плюс round-trip богатых типов (Date / Map / BigInt) в ОБЕ стороны и проброс ошибок.
//
// Зачем: ядро rcp нельзя проверить чтением — баги живут в round-trip клиент↔сервер.
// С этим харнесом правки rcp (pack-in-pipe, client-limits, walk:47, errToObj/MyError,
// auto/hub) можно вносить смело: добавляешь сюда падающий кейс → чинишь → зелёный.
//
// ТИПИЗАЦИЯ — ТОЖЕ ПОД ТЕСТОМ. Клиент типизируем РЕАЛЬНОЙ формой сервера
// (`createRpcClient<typeof serverObj>`), а не `<any>`: тогда КОМПИЛЯТОР проверяет,
// что по проводу доезжают и сигнатуры вызовов (аргументы/возврат CALL/PIPE), и типы
// аргументов колбэков, и подписочная поверхность Listen-узлов. `check<T>` связывает
// фактический результат с ожидаемым (`exp: NoInfer<T>`) — расхождение типа не
// скомпилируется. Точечный `as any` оставлен ТОЛЬКО там, где тест НАМЕРЕННО бьёт
// мимо схемы (off-schema путь для maxPathLen). Где значение по контракту `any`
// (echo, authAck) — это тип библиотеки, а не спрятанная типизация.
//
// Запуск:   node node_modules/ts-node/dist/bin.js --transpile-only src/Common/rcp/rpc.harness.spec.ts
// Из сборки исключён (*.spec.ts в tsconfig.exclude) — в опубликованную либу НЕ попадает.
// ===========================================================================

import { createRpcServer } from "./rpc-server"
import { createRpcClient, type RpcClientReturn } from "./rpc-client"
import { createRpcServerAuto } from "./rpc-server-auto"
import { createRpcServerAuto2 } from "./createRpcServerAutoWithProtocolDetection"
import { createRpcClientHub } from "./rpc-clientHub"
import { UseListen, isListenOn, getListenByOn } from "../events/Listen"
import { UseListenTransform } from "../events/UseListenTransform"
import { joinListens } from "../events/joinListens"
import { noStrict } from "./rpc-dynamic"
import { Pkt, IS_RPC_LISTEN, type SocketTmpl } from "./rpc-protocol"
import type { DeepSocketListen } from "./listen-deep"
import { MyError } from "../../toError/myThrow"
// Observable (in-house reactive lib) — каждый узел отдаёт настоящий Listen через .listen(),
// поэтому проверяем его РОВНО тем же боевым сокетом, что и обычный UseListen.
import { createCell, createRObject, createRMap, combine, computed } from "../../../observable/reactive"
import { computedAuto } from "../../../observable/autotrack"
import { createReactive, listen as rxListen, listenValue as rxListenValue } from "../../../observable/native"
import { createStore, createStoreMirror, exposeStore, flushReactive } from "../ObserveAll2"

// --- loopback: emit одного конца доставляется в on другого (асинхронно, как реальный сокет) ---
// Каждое сообщение проходит JSON-клон: реальный транспорт сериализует, и сырые Date/Map/BigInt
// в payload ломаются ровно как в проде. Loopback по ссылке маскировал бы такие баги.
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

// --- Подписочная проекция клиентского proxy на сервер с Listen-узлами ---
// В runtime клиент проецирует Listen-узлы сервера в подписочную поверхность
// (`.callback`/`.on`/`.once` с типами значений + вызываемый off()-хендл) — ровно как
// listen-deep / createRpcClientAuto. Статически это НЕ выводится из ClientAPIAll
// (там callback стал бы Promise<never>: DeepDataOnly<Function> = never), поэтому
// объявляем боевой контракт явно. T берём из самого клиента → типы значений едут
// из РЕАЛЬНОЙ формы сервера (тест передачи типизации callback-канала).
function webListen<T extends object>(c: RpcClientReturn<T>) {
    return c.func as unknown as DeepSocketListen<T>
}

// --- сравнение с учётом Date/Map/BigInt ---
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
    // check<T>: тип ожидаемого ПРИВЯЗАН к фактическому результату run() (exp: NoInfer<T>) —
    // если по проводу доедет не тот тип, файл не скомпилируется. Где run() возвращает any
    // (echo/auth) ограничения нет — это контракт библиотеки.
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
    type tBox = { value: number; add: (m: number) => tBox } // рекурсивный тип для PIPE-цепочки
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
    // Клиент типизирован формой сервера → F.add(2,3): Promise<number>, F.streamRich(cb)
    // знает (d: Date, m: Map<...>), P.makeBox(n).add(m).value продолжает цепочку — всё под tsc.
    const c = createRpcClient<typeof serverObj>({ socket: clientSocket, socketKey: "rpc" })
    createRpcServer({ socket: serverSocket, object: serverObj, socketKey: "rpc" })
    await delay(0) // дать MAP-хендшейку дойти
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
    // объект, чей ПЕРВЫЙ ключ совпадает с маркером упаковки ($_d/$_f/...), но это обычные данные:
    // раньше walk считал его упакованным листом по первому ключу и терял остальные ключи.
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
    // (d: Date, m: Map<string,number>) выведены ИЗ сигнатуры serverObj.streamRich — без аннотаций.
    const richCall: (Date | Map<string, number>)[] = []
    await check("CALL cb rich args returns", () => F.streamRich((d, m) => richCall.push(d, m)), "ok")
    await delay(0)
    await check("CALL cb got Date+Map", async () => richCall, [new Date(777), new Map([["k", 1]])])

    console.log("--- PIPE (серверные цепочки) ---")
    // .makeBox(n)/.add(m) типизированы (PipeAPI хранит цепочку методов); чтение листа-примитива
    // .value PipeAPI НЕ моделирует (в цепочке остаются только функции/объекты) — точечный as any.
    await check("pipe makeBox(10).value", () => (P.makeBox(10) as any).value, 10)
    await check("pipe makeBox(10).add(5).value", () => (P.makeBox(10).add(5) as any).value, 15)
    const richPipe: (Date | Map<string, number>)[] = []
    await check("PIPE cb rich args returns", () => P.streamRich((d, m) => richPipe.push(d, m)), "ok")
    await delay(0)
    await check("PIPE cb got Date+Map", async () => richPipe, [new Date(777), new Map([["k", 1]])])

    console.log("--- лимиты: сервер (maxArgs/maxPathLen), клиент (opt-in limits) ---")
    // отдельная пара: сервер с жёсткими лимитами, клиент с opt-in limits на ответы
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
    // путь мимо routeMap (числовой ref лимит не обходит — он валидируется при рукопожатии).
    // НАМЕРЕННО off-schema путь → один точечный `as any` (схемы такого метода нет, и не должно быть).
    await check("maxPathLen: 5-сегментный путь", () => verdict((F2 as any).q.w.e.r.t(), /path too long/), "rejected")
    await check("client lim: глубокий ответ отбит", () => verdict(F2.echo({ a: { b: { c: { d: { e: 1 } } } } }), /max depth/), "rejected")
    await check("client lim: мелкий ответ ok", () => F2.echo({ a: 1 }), { a: 1 })

    console.log("--- teardown: id-reuse / double-init / dispose ---")
    const slowObj = { slow: (v: string, ms: number) => new Promise<string>(r => setTimeout(() => r(v), ms)), add: (a: number, b: number) => a + b }

    { // id-reuse: id отменённого запроса не возвращается в пул, пока не придёт его поздний RESP
        const [cs, ss] = createLoopback()
        const c = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: slowObj, socketKey: "rpc" })
        await delay(0)
        const F = c.func
        const pOld = F.slow("old", 40).then(() => "resolved", () => "aborted")
        await delay(10) // запрос ушёл, сервер ещё думает
        c.abortAll("test")
        const pNew = F.slow("new", 120) // при баге берёт тот же id → старый RESP резолвит его как "old"
        await check("id-reuse: отменённый отбит", () => pOld, "aborted")
        await check("id-reuse: поздний RESP не угоняет новый", () => pNew, "new")
    }
    { // double-init сервера: последний выигрывает, сайд-эффекты не задваиваются
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
    { // double-init клиента: общий пул id на socket+key — конкурентные запросы двух клиентов не коллизируют
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: slowObj, socketKey: "rpc" })
        const cA = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const pa = cA.func.slow("A", 20)
        const cB = createRpcClient<typeof slowObj>({ socket: cs, socketKey: "rpc" })
        const pb = cB.func.slow("B", 40) // при баге берёт id первого → RESP "A" резолвит оба
        await check("double-init client: первый получает своё", () => pa, "A")
        await check("double-init client: второй получает своё", () => pb, "B")
    }
    { // proxy-regression: createRpcServer не читает symbol через Proxy.get на root-фасаде
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
    { // proxy-regression: createRpcServerAuto не читает symbol через Proxy.get на root-фасаде
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
    { // proxy-regression: nested Proxy рядом с Listen не ломает MAP и подписки
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // proxy-regression: proxied own-marker IS_RPC_LISTEN определяется без Proxy.get(symbol)
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
        await check("proxy/marker: listen path объявлен", async () => listenPaths, ["stream"])
        await check("proxy/marker: symbol-get не было", async () => stats.symbolGets, 0)
    }
    { // rpc-server-auto: вторая подписка на тот же Listen не затирает первую
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // rpc-server-auto: callback() без функции не создаёт битую подписку
        const [cs, ss] = createLoopback()
        let wireSubs = 0
        const [emit, listen] = UseListen<number>({ event: (_t, count) => { wireSubs = count } })
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
    { // rpc-server-auto: пользовательский Proxy может не поддерживать symbol-ключи в get()
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
    { // дедуп подписок: 1 сетевое соединение на клиента на Listen; отписка — функцией; stats
        const [cs, ss] = createLoopback()
        let wireSubs = 0
        const [emit, listen] = UseListen<number>({ event: (_t, count) => { wireSubs = count } })
        const obj = { stream: listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" }) // клиент слушает ДО MAP сервера
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
    { // НЕ-Listen метод по имени `callback` дедупиться не должен (сервер декларирует Listen-адреса в MAP)
        const [cs, ss] = createLoopback()
        let calls = 0
        const obj = { thing: { callback: (cb: (x: number) => void) => { calls++; cb(calls); return calls } } }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" }) // клиент слушает ДО MAP сервера
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const r1: number[] = [], r2: number[] = []
        // это ОБЫЧНЫЙ CALL с колбэк-аргументом (не подписка) — идём через c.func, типы доезжают:
        // thing.callback(cb): Promise<number>, cb знает (x: number). Конкурентно, без await —
        // окно, в котором эвристика ошибочно расшарила бы вызов.
        const p1 = c.func.thing.callback((x) => r1.push(x))
        const p2 = c.func.thing.callback((x) => r2.push(x))
        await Promise.all([p1, p2])
        await delay(10)
        await check("не-Listen callback: два реальных вызова", async () => calls, 2)
        await check("не-Listen callback: каждому — своё", async () => [r1, r2], [[1], [2]])
    }
    { // numeric-ref vs string-path: оба пути резолвят один индексированный метод одинаково и делят состояние.
      // string-путь идёт до прихода MAP (routeCache пуст), numeric — после.
        const [cs, ss] = createLoopback()
        const stateful = { _n: 0, bump() { return ++this._n }, read() { return this._n } }
        const c = createRpcClient<typeof stateful>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: stateful, socketKey: "rpc" })
        const F = c.func
        const pStr = F.bump()       // routeCache пуст → строковый ref ["bump"]
        await delay(0)              // MAP дошёл → routeCache заполнен
        const pNum = F.bump()       // числовой ref
        await check("ref: string-path bump", () => pStr, 1)
        await check("ref: numeric-ref bump", () => pNum, 2)
        await check("ref: общее состояние (read)", () => F.read(), 2)
    }
    { // mixed-version (P4): клиент игнорирует ЛИШНИЕ (будущие) элементы Pkt.MAP — forward-compat.
      // Старый сервер шлёт MAP из 4 элементов (так во всех остальных кейсах); здесь дописываем
      // 5-й/6-й (будущие authAck/version), новый клиент должен работать как ни в чём не бывало.
        const [cs, ss] = createLoopback()
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => origEmit(e, Array.isArray(d) && d[0] === Pkt.MAP ? [...d, { ok: true }, { v: 2 }] : d)
        const obj = { add: (a: number, b: number) => a + b }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServer({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        await check("mixed-version: лишние MAP-элементы игнорятся", () => c.func.add(2, 3), 5)
    }
    { // clientHub: ротация токена отцепляет старых клиентов и обновляет promise
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
    { // dispose: висящие отклонены, новые вызовы отбиты
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
    { // verify→facade: principal-specific routeMap, gate, отказ по плохому токену
        const [cs, ss] = createLoopback()
        // клиент видит superset-фасад (admin): read + write — оба под tsc.
        type Admin = { read: () => string; write: (x: number) => number }
        const facades: Record<string, Partial<Admin>> = {
            "tok-admin": { read: () => "r", write: (x: number) => x * 2 },
            "tok-user":  { read: () => "r" }, // нет write
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
    { // gate: плохой токен → authAck.ok=false, вызовы отклонены
        const [cs, ss] = createLoopback()
        const resolveAuth = (t: string) => { if (t !== "good") throw new Error("nope"); return { object: { ping: () => "pong" }, ack: { ok: true } } }
        createRpcServer({ socket: ss, object: {} as any, socketKey: "rpc", auth: { resolveAuth, gate: true } })
        const c = createRpcClient<{ ping: () => string }>({ socket: cs, socketKey: "rpc", token: "bad" })
        await c.initStrict()
        await check("gate: плохой токен ok=false", async () => (await c.auth())?.ok, false)
        await check("gate: вызов до auth отклонён", () => c.func.ping().then(() => "ok", () => "rejected"), "rejected")
    }
    { // reauth: смена principal по ЖИВОМУ сокету — подписка выживает, появляется новый метод
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
        const mk = (who: string) => who === "admin" ? { stream: listen, write: (x: number) => x } : { stream: listen }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        // клиент типизирован superset-фасадом (admin): stream-подписка + write.
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
    { // proxy-regression: reauth перестраивает dispatch на Proxy-фасаде без symbol-get
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
    { // backward-compat: клиент С токеном против сервера БЕЗ auth — работает, authAck нет
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const c = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc", token: "ignored" })
        await c.initStrict()
        await check("no-auth server: вызов работает", () => c.func.add(2, 3), 5)
    }
    const raced = (p: Promise<any>) => Promise.race([p.then(() => "settled", () => "settled"), delay(60).then(() => "hung")])
    { // no-auth/старый сервер: auth() и reauth() РЕЗОЛВЯТСЯ (не висят) — дренаж на 4-элементном MAP
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: { ping: () => "p" }, socketKey: "rpc" })
        const c = createRpcClient<{ ping: () => string }>({ socket: cs, socketKey: "rpc", token: "x" })
        await c.initStrict()
        await check("no-auth: auth() резолвится (null)", async () => [await raced(c.auth()), await c.auth()], ["settled", null])
        await check("no-auth: reauth() резолвится", () => raced(c.reauth("y")), "settled")
    }
    { // dispose: висящий reauth снят с {ok:false,reason}, и вызовы ПОСЛЕ dispose не висят
        const [cs] = createLoopback()
        const c = createRpcClient<{}>({ socket: cs, socketKey: "rpc", token: "x" })
        const p = c.reauth("x") // нет сервера → MAP не придёт; снять должен dispose
        c.dispose("bye")
        const r = await Promise.race([p, delay(60).then(() => ({} as any))])
        await check("dispose: reauth снят с ok:false", async () => [r?.ok, r?.reason], [false, "bye"])
        await check("dispose: reauth после dispose отбит", () => Promise.race([c.reauth("y"), delay(60).then(() => "hung")]).then((x: any) => x?.ok), false)
        await check("dispose: auth после dispose отбит", () => Promise.race([c.auth(), delay(60).then(() => "hung")]).then((x: any) => x?.ok), false)
    }
    { // reauth-throw НЕ роняет живую сессию: прежний principal вызываем, подписка жива, ok:false
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
        const mk = (who: string) => ({ stream: listen, write: (x: number) => x, who: () => who })
        const resolveAuth = (t: string) => { if (t === "boom") throw new Error("transient"); return { object: mk(t), ack: { ok: true, who: t } } }
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "rpc", auth: { resolveAuth } })
        type Princ = { stream: typeof listen; write: (x: number) => number; who: () => string }
        const c = createRpcClient<Princ>({ socket: cs, socketKey: "rpc", token: "user" })
        await c.initStrict()
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10); emit(1); await delay(10)
        const ack = await c.reauth("boom") // resolveAuth бросает на сервере
        await check("reauth-throw: ok=false", async () => ack?.ok, false)
        emit(2); await delay(10)
        await check("reauth-throw: подписка жива", async () => got, [1, 2])
        await check("reauth-throw: прежний principal вызываем", () => c.func.write(9), 9)
    }
    { // gate-reject несёт машиночитаемый код E_UNAUTHORIZED
        const [cs, ss] = createLoopback()
        createRpcServer({ socket: ss, object: {} as any, socketKey: "rpc", auth: { resolveAuth: () => { throw new Error("no") }, gate: true } })
        // фиктивный метод `any` в типе клиента: сервер его не маршрутизирует (gate бьёт раньше),
        // но так вызов остаётся типизированным (без россыпи as any) — тест именно кода отказа.
        const c = createRpcClient<{ any: () => void }>({ socket: cs, socketKey: "rpc", token: "x" })
        await c.initStrict()
        await check("gate: код ошибки E_UNAUTHORIZED", () => c.func.any().catch((e: any) => e?.code), "E_UNAUTHORIZED")
    }
    { // hub: токен доходит до клиента (HELLO на connect) + мягкий hub.reauth по живому сокету
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
        const mk = (who: string) => who === "admin" ? { stream: listen, write: (x: number) => x } : { stream: listen }
        const resolveAuth = (t: string) => ({ object: mk(t), ack: { ok: true, who: t } })
        createRpcServerAuto({ socket: ss, object: mk("user"), socketKey: "main", auth: { resolveAuth } })
        // схема хаба типизирована superset-фасадом → facade.main.func.stream / .write под tsc.
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

    console.log("--- S0.3: protocol-detection lifecycle (auto2 dispose/reset) ---")
    { // v2-детекция, reset (повторная детекция), dispose (роутер инертен), идемпотентность
        const [cs, ss] = createLoopback()
        const auto = createRpcServerAuto2({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const cA = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        await check("auto2: v2 вызов", () => cA.func.add(2, 3), 5)
        await check("auto2: протокол v2", async () => auto.getProtocol(), "v2")
        auto.reset()
        await check("auto2: reset сбросил латч", async () => auto.getProtocol(), null)
        const cB = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        await check("auto2: после reset снова v2", () => cB.func.add(4, 5), 9)
        // dispose: роутер инертен — входящие сообщения не порождают ответа
        let out = 0
        const origEmit = ss.emit.bind(ss)
        ss.emit = (e, d) => { out++; origEmit(e, d) }
        auto.dispose("bye")
        out = 0
        cs.emit("rpc", Pkt.STRICT)
        await delay(10)
        await check("auto2: dispose инертен (нет ответа)", async () => out, 0)
        auto.dispose()
        await check("auto2: повторный dispose без эффекта", async () => out, 0)
    }
    { // auto2 + token: первый HELLO распознаётся как v2 (иначе auth() клиента висел бы)
        const [cs, ss] = createLoopback()
        createRpcServerAuto2({ socket: ss, object: { add: (a: number, b: number) => a + b }, socketKey: "rpc" })
        const c = createRpcClient<{ add: (a: number, b: number) => number }>({ socket: cs, socketKey: "rpc", token: "tok" })
        await c.initStrict()
        await check("auto2+token: auth() резолвится (null)", () => Promise.race([c.auth(), delay(60).then(() => "hung")]), null)
        await check("auto2+token: вызов работает", () => c.func.add(2, 3), 5)
    }
    { // auto2 делегирует .once в базовый listenSocket.once: первое событие должно прислать CB_END
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
        const obj = { stream: listen }
        createRpcServerAuto2({ socket: ss, object: obj, socketKey: "rpc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        const done = webListen(c).stream.once((v) => got.push(v))
        await delay(10)
        emit(1); await delay(3); emit(2)
        await check("auto2 once: ровно одно событие", async () => got, [1])
        await check("auto2 once: handle завершился", () => Promise.race([done.then(() => "ended"), delay(60).then(() => "hung")]), "ended")
    }

    console.log("--- adaptive подписочное уплотнение (Pkt.SHAPE/CBV: частая форма → компакт) ---")
    { // частый объект одной формы стандартизируется после порога; значения (вкл. Date) целы
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<{ a: number; when: Date; tag: string }>()
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
    { // полиморфная/редкая форма НЕ уплотняется — порог не достигнут, всё полным CB (нет CBV)
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<Record<string, number>>()
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
    { // back-compat: СТАРЫЙ клиент (без Pkt.CAPS) ↔ НОВЫЙ сервер с уплотнением.
      // Эмулируем старый клиент — транспорт глотает CAPS, сервер его не видит → compactOk=false
      // → сервер ОБЯЗАН слать обычный Pkt.CB, а не SHAPE/CBV. Фиксируем инвариант P4 тестом.
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<{ a: number; when: Date; tag: string }>()
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
    { // клиент opt:{compact:false} → НЕ объявляет COMPACT (молчит) → сервер на обычном Pkt.CB
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<{ a: number; when: Date; tag: string }>()
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
    { // сервер opt:{compact:false} → не объявляет COMPACT → нет уплотнения, даже если клиент умеет
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<{ a: number; when: Date; tag: string }>()
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
    { // подписка по самому факту установки колбэка через client.func.stream.on(cb)
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // genuine: при dedupe:false `.on(fn)` идёт ПРЯМЫМ wire-вызовом stream.on (без subscribe-магии
      // клиента) → доказывает, что серверный маршрут `on` реально работает по сети.
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // .on и .callback на ОДИН узел делят одну сетевую подписку (дедуп по адресу узла)
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // реестр: isListenOn / getListenByOn
        const [, listen] = UseListen<number>()
        await check("isListenOn(listen.on) === true", async () => isListenOn(listen.on), true)
        await check("getListenByOn(listen.on) === api", async () => getListenByOn(listen.on) === listen, true)
        await check("isListenOn(чужая fn) === false", async () => isListenOn(() => {}), false)
    }
    { // .once(cb) доставляет РОВНО одно событие через веб, затем стрим закрыт
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // bare-on: в объекте лежит ТОЛЬКО listen.on (брендированная функция) — сервер по реестру
      // разворачивает подписку, а DeepSocketListen по бренду ListenOn проецирует {on, once, close}.
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // bare-on ПО СТРОКЕ: в noStrict-поддереве routeMap нет → резолв по строковому пути
      // (fallback-обход currentTarget). resolveTransform применяется на лету → isListenOn ловит on.
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    { // и Listen-ОБЪЕКТ по строке (noStrict) — оба способа поддержаны и по ссылке, и по строке
        const [cs, ss] = createLoopback()
        const [emit, listen] = UseListen<number>()
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
    // wenay-common2 СЕТЕВОЙ СЛОЙ: events (UseListen / listen) + Observable.
    //
    // Контракт из wenay-common2.md: «каждый узел Observable — это настоящий Listen
    // через .listen() → падает в RPC / listen-deep без изменений». Здесь это ДОКАЗАНО
    // боевым сокетом: узел живёт на сервере, клиент подписывается через тот же веб
    // (.callback), мутация на сервере → дельты приходят клиенту корректно. .listen()
    // несёт ТОЛЬКО будущие дельты (без реплея текущего значения), а граф холодный,
    // пока нет листа-подписчика (cheap-until-subscribed) — оба инварианта проверены.
    //
    // Типизация: сервер-объект строим как const, клиент берёт его `typeof`, а
    // webListen(c) проецирует Listen-узлы в подписочную поверхность — значения колбэков
    // (включая Date/[key,value]/числа) выводятся ИЗ типа узла, без аннотаций и as any.
    // ===========================================================================
    console.log("--- wenay-common2 сеть: events + Observable через боевой сокет ---")

    { // Observable.createCell — поток значения по сети + teardown (0↔1 подписки)
        const [cs, ss] = createLoopback()
        const cell = createCell(0)
        const obj = { cell: cell.listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        const sub = webListen(c).cell.callback((v) => got.push(v))
        await delay(10)
        cell.set(1); cell.set(2); cell.set(2); cell.set(3) // дубль set(2) глушится equals (Object.is)
        await delay(10)
        await check("Cell: значения по сети", async () => got, [1, 2, 3])
        await check("Cell: equals глушит дубль", async () => got.length, 3)
        await check("Cell: одна сетевая подписка", async () => cell.listen().count(), 1)
        sub.unsubscribe()
        await delay(10)
        const n = got.length
        cell.set(99)
        await delay(10)
        await check("Cell: после отписки источник холодный (0)", async () => cell.listen().count(), 0)
        await check("Cell: после отписки тиков нет", async () => got.length, n)
    }
    { // Observable.createRObject — поток [key,value] всего объекта по сети
        const [cs, ss] = createLoopback()
        const robj = createRObject<{ a: number, b: number, c?: number }>({ a: 1, b: 2 })
        const obj = { obj: robj.listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: [string, any][] = []
        webListen(c).obj.callback((k, v) => got.push([k, v]))
        await delay(10)
        robj.set("a", 10); robj.set("c", 3)
        await delay(10)
        await check("RObject: [key,value] дельты по сети", async () => got, [["a", 10], ["c", 3]])
    }
    { // Observable.createRMap — [key,value]; delete эмитит undefined ⇒ null по сети
        const [cs, ss] = createLoopback()
        const rmap = createRMap<string, number>([["x", 1]])
        const obj = { map: rmap.listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: [string, any][] = []
        webListen(c).map.callback((k, v) => got.push([k, v]))
        await delay(10)
        rmap.set("x", 5); rmap.set("y", 7); rmap.delete("x")
        await delay(10)
        await check("RMap: set/add дельты по сети", async () => got.slice(0, 2), [["x", 5], ["y", 7]])
        await check("RMap: delete → null по сети", async () => got[2], ["x", null])
    }
    { // Observable.combine — производный граф ХОЛОДНЫЙ до листа, затем пушит по сети
        const [cs, ss] = createLoopback()
        const a = createCell(1), b = createCell(2)
        const sum = combine([a, b], ([x, y]) => x + y)
        const obj = { sum: sum.listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        await check("combine: граф холодный до подписки (0 upstream)", async () => [a.count(), b.count()], [0, 0])
        const got: number[] = []
        webListen(c).sum.callback((v) => got.push(v))
        await delay(10)
        await check("combine: подписка по сети завела upstream", async () => [a.count(), b.count()], [1, 1])
        a.set(10); await delay(5); b.set(20)
        await delay(10)
        await check("combine: производные значения по сети", async () => got, [12, 30])
    }
    { // Observable.computed — производное над ОДНИМ источником по сети
        const [cs, ss] = createLoopback()
        const a = createCell(2)
        const obj = { dbl: computed(a, x => x * 100).listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).dbl.callback((v) => got.push(v))
        await delay(10)
        a.set(3); await delay(5); a.set(7)
        await delay(10)
        await check("computed: значения по сети", async () => got, [300, 700])
    }
    { // Observable.computedAuto — авто-трекинг зависимостей, значения по сети
        const [cs, ss] = createLoopback()
        const a = createCell(2), b = createCell(3)
        const auto = computedAuto(use => use(a) + use(b))
        const obj = { auto: auto.listen() }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).auto.callback((v) => got.push(v))
        await delay(10)
        a.set(10); await delay(5); b.set(20)
        await delay(10)
        await check("computedAuto: авто-deps значения по сети", async () => got, [13, 30])
    }
    { // events.UseListenTransform — map+filter (null пропускает событие) по сети
        const [cs, ss] = createLoopback()
        const [emit, src] = UseListen<number>()
        const [, evenDoubled] = UseListenTransform<[number], [number]>(src, (n) => n % 2 == 0 ? [n * 2] : null)
        const obj = { stream: evenDoubled }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        for (let i = 0; i < 5; i++) { emit(i); await delay(2) } // чётные ×2: 0,4,8; нечётные — отфильтрованы
        await delay(10)
        await check("UseListenTransform: map+filter по сети", async () => got, [0, 4, 8])
    }
    { // events.joinListens — zip по ключу: группа стримит ТОЛЬКО когда собраны все порты
        const [cs, ss] = createLoopback()
        // кортежная форма UseListen<[X]> → порт совпадает с ListenMap (T[K] extends any[]).
        // T задаём явно: через mapped-type параметр (ListenMap<T>) вывод не проходит, и без
        // подсказки joinListens свалился бы на массивную перегрузку.
        const [emitA, portA] = UseListen<[{ id: string, a: number }]>()
        const [emitB, portB] = UseListen<[{ id: string, b: number }]>()
        const joined = joinListens<{ A: [{ id: string, a: number }], B: [{ id: string, b: number }] }>(
            { A: portA, B: portB }, (d: any) => d.id)
        const obj = { zip: joined.listen }
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "rpc" })
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "rpc" })
        await delay(0)
        // (res, tid) выводятся из listen<[R, string]> — res: собранная группа, tid: string.
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
    // COOKBOOK — эффективные паттерны «как в жизни». Каждый — рабочий check (значит,
    // одновременно живой пример И регрессионный тест). Типизация боевая: клиент знает
    // форму сервера, подписки через webListen. Домен — трейдинг (для наглядности).
    // ===========================================================================
    console.log("--- COOKBOOK: реальные паттерны использования ---")

    { // ObserveAll2 store mirror over the real RPC loopback: get() stays a normal call, changedPaths stays a normal Listen.
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

        await check("cookbook: ObserveAll2 mirror по RPC", async () => ({
            a: mirror.state.strategies.a.status,
            hasB: "b" in mirror.state.strategies,
            meta: mirror.state.meta.status,
        }), {a: true, hasB: false, meta: "warn"})
    }

    { // 1) ОБЫЧНЫЙ ЗАПРОС-ОТВЕТ (замена REST/fetch-ручек, но типизированно и без URL).
      //    Делаем: зовём функцию сервера как локальную — c.func.setLimit("BTC",100), а выполняется
      //    она НА СЕРВЕРЕ и возвращает результат. Нужно когда: сохранить настройку, спросить
      //    значение, дёрнуть действие. Самый частый случай «просто передать/получить данные».
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
    { // 2) СЛЕДИТЬ ЗА МЕНЯЮЩИМСЯ ЗНАЧЕНИЕМ в реальном времени (push, не поллинг).
      //    Делаем: сервер держит состояние как ОБЫЧНЫЙ объект (createReactive) — пишем `md.price = 101`,
      //    а клиент .on(cb) сам получает КАЖДОЕ новое значение. listenValue(md,'price') — поток поля для RPC.
      //    off() — перестать следить (серверная подписка снимется).
      //    Нужно когда: тикер цены, статус задачи, прогресс, онлайн-счётчик.
        const [cs, ss] = createLoopback()
        const md = createReactive({ price: 100 })          // обычный объект
        const obj = { price: rxListenValue(md, "price") }  // поле как поток для RPC
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "md" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "md" })
        await delay(0)
        const ticks: number[] = []
        const off = webListen(c).price.on((v) => ticks.push(v))
        await delay(5)
        md.price = 101; md.price = 102                      // ← просто присваиваем
        await delay(10)
        off() // отписка — серверная подписка снимается, фид останавливается
        const after = ticks.length
        md.price = 103; await delay(10)
        await check("cookbook: live-фид + off()", async () => [ticks, ticks.length == after], [[101, 102], true])
    }
    { // 3) ДЕРЖАТЬ У КЛИЕНТА АКТУАЛЬНУЮ КОПИЮ серверной коллекции (свободно добавляем/меняем/удаляем).
      //    Делаем: на сервере вложенный объект в createReactive; меняем его как ОБЫЧНЫЙ объект
      //    (`book.positions.BTC = 2`, `delete book.positions.BTC`) — а клиенту прилетают только ДЕЛЬТЫ
      //    (что добавилось/изменилось/удалилось), и он сам поддерживает зеркало. delete приезжает как null.
      //    listen(book,'positions') — поток дельт коллекции. Нужно когда: таблица/список живёт на сервере.
        const [cs, ss] = createLoopback()
        const book = createReactive<{ positions: Record<string, number> }>({ positions: {} })
        const obj = { positions: rxListen(book, "positions") }   // дельты коллекции для RPC
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "pos" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "pos" })
        await delay(0)
        const mirror = new Map<string, number>()
        webListen(c).positions.callback((k, v) => { if (v == null) mirror.delete(k); else mirror.set(k, v) })
        await delay(5)
        book.positions["BTC"] = 2; book.positions["ETH"] = 5; delete book.positions["BTC"]  // ← как обычный объект (динамические ключи → скобки)
        await delay(10)
        await check("cookbook: зеркало коллекции по сети", async () => [...mirror], [["ETH", 5]])
    }
    { // 4) СЧИТАТЬ ПРОИЗВОДНОЕ НА СЕРВЕРЕ, слать клиенту уже готовый результат.
      //    Делаем: notional = price*qty собирается из двух источников (combine); при изменении ЛЮБОГО
      //    входа пересчёт идёт на сервере, а клиент получает только итог. Нужно когда: не хочешь тянуть
      //    сырьё и считать на клиенте (агрегаты, суммы, PnL) — логика и пересчёт живут в одном месте.
        const [cs, ss] = createLoopback()
        const price = createCell(10), qty = createCell(3)
        const notional = combine([price, qty], ([p, q]) => p * q)
        const obj = { notional: notional.listen() }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "calc" })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "calc" })
        await delay(0)
        const got: number[] = []
        webListen(c).notional.callback((v) => got.push(v))
        await delay(5)
        price.set(20); await delay(5); qty.set(4)
        await delay(10)
        await check("cookbook: derived-метрика по сети", async () => got, [60, 80])
    }
    { // 5) ЗА ОДИН ПОХОД НА СЕРВЕР достать объект и сразу применить к нему метод/взять поле (pipe).
      //    Делаем: вместо двух обращений (получить order → потом addFee) — одна цепочка
      //    c.pipe.order(id).addFee(5), всё выполнится на сервере, по сети уедет только финал.
      //    Нужно когда: промежуточный результат не нужен, важен итог — экономия сетевых ходов.
        const [cs, ss] = createLoopback()
        const api = { order: (id: string) => ({ id, addFee: (f: number) => ({ id, total: 70 + f }) }) }
        createRpcServer({ socket: ss, object: api, socketKey: "ord" })
        const c = createRpcClient<typeof api>({ socket: cs, socketKey: "ord" })
        await delay(0)
        await check("cookbook: pipe — серверная цепочка", () => c.pipe.order("x").addFee(5), { id: "x", total: 75 })
    }
    { // 6) РАЗНЫЕ ПРАВА — один эндпоинт отдаёт РАЗНЫЙ набор методов в зависимости от того, кто залогинен.
      //    Делаем: предъявляем токен (init с token) → сервер отдаёт фасад под роль. viewer видит только
      //    quote, trader — ещё и cancel. reauth("trader") меняет права ПРЯМО по живому соединению, без
      //    переподключения и без потери подписок. Нужно когда: роли/доступы, повышение прав на лету.
        const [cs, ss] = createLoopback()
        const facades: Record<string, { quote: () => number; cancel?: () => string }> = {
            viewer: { quote: () => 42 },
            trader: { quote: () => 42, cancel: () => "ok" },
        }
        const resolveAuth = (t: string) => { const o = facades[t]; if (!o) throw new Error("bad token"); return { object: o, ack: { ok: true, who: t } } }
        createRpcServer({ socket: ss, object: {} as any, socketKey: "sess", auth: { resolveAuth, gate: true } })
        type Trader = { quote: () => number; cancel: () => string } // клиент знает superset-фасад
        const c = createRpcClient<Trader>({ socket: cs, socketKey: "sess", token: "viewer" })
        await c.init()
        await check("cookbook: логин — кто я", async () => (await c.auth())?.who, "viewer")
        await check("cookbook: viewer видит quote", () => c.func.quote(), 42)
        await c.reauth("trader")
        await check("cookbook: reauth — появился cancel", () => c.func.cancel(), "ok")
    }
    { // 7) ФИЛЬТРОВАТЬ/ПРЕОБРАЗОВЫВАТЬ ПОТОК ДО отправки клиенту (UseListenTransform).
      //    Делаем: из всех ордеров наружу уходят только BUY и только их qty (SELL отсечены на сервере,
      //    null = пропустить событие). Нужно когда: не хочешь гнать по сети лишнее и фильтровать на
      //    клиенте — режешь объём и отдаёшь уже готовую форму.
        const [cs, ss] = createLoopback()
        type tOrder = { side: "BUY" | "SELL"; qty: number }
        const [emit, orders] = UseListen<tOrder>()
        const [, buysQty] = UseListenTransform<[tOrder], [number]>(orders, (o) => o.side == "BUY" ? [o.qty] : null)
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
    { // 8) ДОЖДАТЬСЯ РОВНО ОДНОГО следующего события и сразу отписаться (once).
      //    Делаем: «дай ближайший fill и всё» — колбэк сработает один раз, дальше стрим закрыт.
      //    Нужно когда: одноразовое ожидание — подтверждение операции, первый тик, сигнал готовности.
        const [cs, ss] = createLoopback()
        const [emit, fills] = UseListen<number>()
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
    { // 9) ОШИБКА С МАШИННЫМ КОДОМ, а не просто текстом (MyError долетает целиком: code + data).
      //    Делаем: сервер кидает MyError("...", "E_LIMIT", {max:100}); клиент ловит и ветвится по
      //    e.code / e.data — надёжно, без парсинга строк. Нужно когда: предсказуемая обработка ошибок
      //    (показать нужное сообщение, повторить, подсветить поле) — это контракт ошибок API.
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
    { // 10) ПРОРЕДИТЬ СЛИШКОМ ЧАСТЫЙ ПОТОК на сервере (throttle) — не топить сеть и клиент.
      //    Делаем: источник тикает часто, а сервер отдаёт первое значение сразу (leading) и последнее
      //    в окне (trailing), промежуточные схлопывает. Нужно когда: шумные фиды — цены, телеметрия,
      //    события мыши — где важны «первое и последнее», а не каждый промежуточный тик.
        const [cs, ss] = createLoopback()
        const [emit, ticks] = UseListen<number>()
        const obj = { ticks }
        createRpcServerAuto({ socket: ss, object: obj, socketKey: "hz", throttle: 30 })
        const c = createRpcClient<typeof obj>({ socket: cs, socketKey: "hz" })
        await delay(0)
        const got: number[] = []
        webListen(c).ticks.on((v) => got.push(v))
        await delay(5)
        for (let i = 1; i <= 5; i++) { emit(i); await delay(2) } // 5 эмиссий в одном окне
        await delay(50) // дождаться trailing
        // first (leading=1) доезжает сразу, последнее (5) — на границе окна; промежуточные схлопнуты
        await check("cookbook: throttle — leading+trailing, не все тики", async () => [got[0], got[got.length - 1], got.length < 5], [1, 5, true])
    }

    console.log(`\n${fails === 0 ? "ALL GREEN ✅" : fails + " FAILURE(S) ❌"}`)
    return fails
}

// авто-запуск только при прямом вызове файла (никаких сайд-эффектов при импорте)
if (require.main === module) {
    runHarness().then(f => process.exit(f === 0 ? 0 : 1))
}
