import { createRpcClient } from "../../src/Common/rcp/rpc-client"
import { createRpcServerAuto } from "../../src/Common/rcp/rpc-server-auto"
import { type SocketTmpl } from "../../src/Common/rcp/rpc-protocol"
import { listen as createListenPair } from "../../src/Common/events/Listen"

function createLoopback(): [SocketTmpl, SocketTmpl] {
    const a: Record<string, ((d: any) => void)[]> = {}
    const b: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof a, theirs: typeof a): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(a, b), make(b, a)]
}

const delay = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function eq(a: any, b: any): boolean {
    if (a === b) return true
    if (typeof a === "bigint" || typeof b === "bigint") return a === b
    if (a instanceof Date && b instanceof Date) return a.valueOf() === b.valueOf()
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false
        for (const [k, v] of a) if (!eq(v, b.get(k))) return false
        return true
    }
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false
        for (const v of a) if (![...b].some(x => eq(x, v))) return false
        return true
    }
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => eq(v, b[i]))
    if (a && b && typeof a === "object" && typeof b === "object") {
        const ak = Object.keys(a), bk = Object.keys(b)
        return ak.length === bk.length && ak.every(k => eq(a[k], b[k]))
    }
    return false
}

function fmt(v: any): string {
    return typeof v === "bigint" ? `${v}n` : JSON.stringify(v)
}

function makeChecker() {
    let fails = 0
    async function check<T>(name: string, run: () => T | Promise<T>, exp: T) {
        try {
            const got = await run()
            const ok = eq(got, exp)
            if (!ok) fails++
            console.log(`${ok ? "PASS" : "FAIL"}  ${name}  got=${fmt(got)} exp=${fmt(exp)}`)
        } catch (e: any) {
            fails++
            console.log(`FAIL  ${name}  threw=${e?.message ?? e}`)
        }
    }
    return { check, done: () => fails }
}

function nextUncaught(ms = 200) {
    return new Promise<string | null>(resolve => {
        const timer = setTimeout(() => {
            process.removeListener("uncaughtException", onError)
            resolve(null)
        }, ms)
        const onError = (e: any) => {
            clearTimeout(timer)
            resolve(e?.message ?? String(e))
        }
        process.once("uncaughtException", onError)
    })
}

function makeRpcListen() {
    const [emit, stream] = createListenPair<number>()
    const obj = { stream }
    const [clientSocket, serverSocket] = createLoopback()
    const client = createRpcClient<typeof obj>({ socket: clientSocket, socketKey: "rpc" })
    const server = createRpcServerAuto({ socket: serverSocket, object: obj, socketKey: "rpc" })
    return { emit, client, server, api: client.func as any }
}

async function main() {
    const { check, done } = makeChecker()
    const watchdog = setTimeout(() => {
        console.error("WATCHDOG timeout")
        process.exit(3)
    }, 10000)

    {
        const { emit, client, server, api } = makeRpcListen()
        await delay(0)
        const got: string[] = []
        api.stream.callback((v: number) => { got.push(`first:${v}`); throw new Error("first consumer boom") })
        api.stream.callback((v: number) => got.push(`second:${v}`))
        await delay(10)

        const thrown = nextUncaught()
        emit(3)
        await delay(20)

        await check("fan-out isolation: both consumers ran", () => got, ["first:3", "second:3"])
        await check("fan-out isolation: first throw surfaced async", () => thrown, "first consumer boom")
        await check("fan-out isolation: one wire subscription", () => client.api.subscriptions()[0]?.consumers, 2)
        await check("fan-out isolation: server has one consumer", () => server.api.subscriptions()[0]?.consumers, 1)
    }

    {
        const { emit, client, server, api } = makeRpcListen()
        await delay(0)
        const a: number[] = [], b: number[] = []
        const richA = { id: 1n, tags: new Set(["a", "b"]), meta: new Map<any, any>([["x", 1]]) }
        const richB = { id: 2n, tags: new Set(["a", "c"]), meta: new Map<any, any>([["x", 2]]) }

        let subscribeError: any = null
        try {
            api.stream.callback((v: number) => a.push(v), richA)
            api.stream.callback((v: number) => b.push(v), richB)
        } catch (e) {
            subscribeError = e
        }
        await delay(20)
        emit(8)
        await delay(20)

        await check("rich dedupe key: subscribe did not throw", () => subscribeError?.message ?? null, null)
        await check("rich dedupe key: distinct rich args do not collide client-side", () => client.api.subscriptions().length, 2)
        await check("rich dedupe key: distinct rich args do not collide server-side", () => server.api.subscriptions()[0]?.consumers, 2)
        await check("rich dedupe key: first rich subscription receives", () => a, [8])
        await check("rich dedupe key: second rich subscription receives", () => b, [8])
    }

    {
        const { emit, client, server, api } = makeRpcListen()
        await delay(0)
        const got: number[] = []
        const cb = (v: number) => got.push(v)
        const off1 = api.stream.callback(cb)
        const off2 = api.stream.callback(cb)
        await delay(20)

        emit(1)
        await delay(20)
        off1()
        await delay(20)
        const afterFirstOff = {
            clientConsumers: client.api.subscriptions()[0]?.consumers,
            serverConsumers: server.api.subscriptions()[0]?.consumers,
        }
        emit(2)
        await delay(20)
        off2()
        await delay(30)

        await check("duplicate same callback: local duplicate fan-out before off", () => got, [1, 1, 2])
        await check("duplicate same callback: one local consumer remains after first off", () => afterFirstOff.clientConsumers, 1)
        await check("duplicate same callback: server still has one wire consumer after first off", () => afterFirstOff.serverConsumers, 1)
        await check("duplicate same callback: client cleaned after last off", () => client.api.subscriptions().length, 0)
        await check("duplicate same callback: server cleaned after last off", () => server.api.subscriptions().length, 0)
    }

    {
        const { emit, client, server, api } = makeRpcListen()
        await delay(0)
        const a: number[] = [], b: number[] = []
        const offA = api.stream.callback((v: number) => a.push(v))
        api.stream.callback((v: number) => b.push(v))
        await delay(20)

        emit(5)
        await delay(20)
        offA()
        await delay(20)
        emit(6)
        await delay(20)

        await check("unsub one consumer: removed consumer stopped", () => a, [5])
        await check("unsub one consumer: other consumer kept receiving", () => b, [5, 6])
        await check("unsub one consumer: client still has shared wire sub", () => client.api.subscriptions()[0]?.consumers, 1)
        await check("unsub one consumer: server wire consumer still alive", () => server.api.subscriptions()[0]?.consumers, 1)
    }

    clearTimeout(watchdog)
    const fails = done()
    console.log(fails === 0 ? "ALL GREEN" : `${fails} FAILURE(S)`)
    process.exit(fails === 0 ? 0 : 1)
}

main().catch(e => {
    console.error(e)
    process.exit(2)
})
