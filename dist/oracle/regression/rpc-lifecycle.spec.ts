import {listen as createListenPair} from "../../src/Common/events/Listen"
import {createRpcClient, type RpcClientReturn} from "../../src/Common/rcp/rpc-client"
import {createRpcServerAuto} from "../../src/Common/rcp/rpc-server-auto"
import {createRpcServerAutoDetect} from "../../src/Common/rcp/createRpcServerAutoWithProtocolDetection"
import {listenSocket} from "../../src/Common/rcp/listen-socket"
import {RPC_STOP, type SocketTmpl} from "../../src/Common/rcp/rpc-protocol"
import type {DeepSocketListen} from "../../src/Common/rcp/listen-deep"

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
    return [make(A, B), make(B, A)]
}

function webListen<T extends object>(c: RpcClientReturn<T>) {
    return c.func as unknown as DeepSocketListen<T>
}

const delay = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function same(a: any, b: any): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

async function check<T>(name: string, run: () => T | Promise<T>, exp: NoInfer<T>) {
    const got = await run()
    if (!same(got, exp)) throw new Error(`${name}: got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`)
    console.log(`PASS ${name}`)
}

async function main() {
    {
        const [cs, ss] = createLoopback()
        const [emit1, listen1] = createListenPair<number>()
        const [emit2, secondListen] = createListenPair<number>()
        const obj1 = {stream: listen1}
        const obj2 = {stream: secondListen}
        const c = createRpcClient<typeof obj1>({socket: cs, socketKey: "rpc", dedupeListen: false})
        createRpcServerAuto({socket: ss, object: obj1, socketKey: "rpc"})
        const oldGot: number[] = []
        webListen(c).stream.callback((v) => oldGot.push(v))
        await delay(10)
        await check("createRpcServerAuto initial Listen subscribed", async () => listen1.count(), 1)

        createRpcServerAuto({socket: ss, object: obj2, socketKey: "rpc"})
        await delay(10)
        await check("createRpcServerAuto reinit removes old Listen", async () => listen1.count(), 0)
        emit1(1)
        await delay(10)
        await check("createRpcServerAuto old Listen is silent after reinit", async () => oldGot, [])

        const newGot: number[] = []
        ;(webListen(c) as unknown as DeepSocketListen<typeof obj2>).stream.callback((v) => newGot.push(v))
        await delay(10)
        emit2(2)
        await delay(10)
        await check("createRpcServerAuto reinit keeps new server usable", async () => newGot, [2])
    }

    {
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = {stream: listen}
        const c = createRpcClient<typeof obj>({socket: cs, socketKey: "rpc", dedupeListen: false})
        const auto = createRpcServerAutoDetect({socket: ss, object: obj, socketKey: "rpc"})
        const got: number[] = []
        webListen(c).stream.callback((v) => got.push(v))
        await delay(10)
        await check("auto2 dispose setup subscribed Listen", async () => listen.count(), 1)

        auto.dispose("test")
        await delay(10)
        await check("auto2.dispose removes Listen", async () => listen.count(), 0)
        emit(1)
        await delay(10)
        await check("auto2.dispose leaves no live stream", async () => got, [])
    }

    {
        const [cs, ss] = createLoopback()
        const [emit, listen] = createListenPair<number>()
        const obj = {stream: listen}
        const c1 = createRpcClient<typeof obj>({socket: cs, socketKey: "rpc", dedupeListen: false})
        const auto = createRpcServerAutoDetect({socket: ss, object: obj, socketKey: "rpc"})
        const oldGot: number[] = []
        webListen(c1).stream.callback((v) => oldGot.push(v))
        await delay(10)
        await check("auto2 reset setup subscribed Listen", async () => listen.count(), 1)

        auto.reset()
        await delay(10)
        await check("auto2.reset removes current Listen", async () => listen.count(), 0)
        emit(10)
        await delay(10)
        await check("auto2.reset leaves no dangling subscription", async () => oldGot, [])

        const c2 = createRpcClient<typeof obj>({socket: cs, socketKey: "rpc", dedupeListen: false})
        const newGot: number[] = []
        webListen(c2).stream.callback((v) => newGot.push(v))
        await delay(10)
        await check("auto2.reset allows one fresh subscription", async () => listen.count(), 1)
        emit(11)
        await delay(10)
        await check("auto2.reset fresh subscription receives once", async () => newGot, [11])
    }

    {
        const [emit, listen] = createListenPair<number>()
        const socket = listenSocket(listen)
        let calls = 0
        const sub = socket.once(() => {
            calls++
            throw new Error("user callback failed")
        })

        let thrown = ""
        try { emit(1) }
        catch (e: any) { thrown = e?.message ?? String(e) }

        await check("listenSocket.once propagates user throw", async () => thrown, "user callback failed")
        await check("listenSocket.once finally removes listener after throw", async () => listen.count(), 0)
        await check("listenSocket.once handle settles after throw cleanup", () => Promise.race([sub.then(() => "settled"), delay(60).then(() => "hung")]), "settled")
        emit(2)
        await check("listenSocket.once throwing callback is not called again", async () => calls, 1)
    }

    {
        const [emit, listen] = createListenPair<any>()
        const socket = listenSocket(listen)
        const got: any[] = []
        const sub = socket.once((v) => got.push(v))
        emit(RPC_STOP)
        await delay(0)
        await check("RPC_STOP does not reach listenSocket.once user callback", async () => got, [])
        await check("RPC_STOP cleans listenSocket.once subscription", async () => listen.count(), 0)
        await check("RPC_STOP settles listenSocket.once handle", () => Promise.race([sub.then(() => "settled"), delay(60).then(() => "hung")]), "settled")
    }
}

main().catch(e => {
    console.error(e?.stack ?? e)
    process.exitCode = 1
})
