// ============================================================
//  oracle/realsocket/_rs.ts — DISPOSABLE shared harness for REAL-SOCKET mass tests
//
//  Boots a genuine socket.io server (express + http) on a TCP port and a real
//  socket.io-client hub — the SAME transport pattern as src/Common/rcp/test.ts.
//  Not the in-memory loopback: messages cross a real WebSocket. Each spec uses
//  its OWN port so specs run concurrently without clashing.
//
//  Disposable oracle (project rule: no standing test suite; real harness is the
//  one in src/Common/rcp/rpc.harness.spec.ts). Delete this dir after the pass.
// ============================================================
import express from 'express'
import {createServer} from 'http'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createRpcServerAuto} from '../../src/Common/rcp/rpc-server-auto'
import {createRpcClientHub} from '../../src/Common/rcp/rpc-clientHub'
import type {RpcOpt} from '../../src/Common/rcp/rpc-caps'
import {listen as createListenPair} from '../../src/Common/events/Listen'

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ===== real socket.io server =====
type ServerOpts = {
    port: number
    // facade object factory for EACH connection (as in real server)
    makeObject: () => any
    // passed to createRpcServerAuto (auth / limits / maxPerListen / throttle / debug)
    serverOpts?: Record<string, any>
    socketKey?: string
    // access to per-connection server api (subscriptions stats etc.)
    onServer?: (api: any, socket: any) => void
}

export async function startRealServer(opts: ServerOpts) {
    const {port, makeObject, serverOpts = {}, socketKey = 'rpc', onServer} = opts
    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})

    ioServer.on('connection', socket => {
        const [disconnect, disconnectListen] = createListenPair()
        socket.on('disconnect', () => disconnect())
        const adapter = {
            emit: (key: string, data: any) => socket.emit(key, data),
            on: (key: string, cb: any) => socket.on(key, cb),
        }
        const server = createRpcServerAuto({socket: adapter, socketKey, object: makeObject(), disconnectListen, ...serverOpts})
        onServer?.(server.api, socket)
    })

    await new Promise<void>(resolve => httpServer.listen(port, resolve))
    return {
        httpServer, ioServer,
        close: () => new Promise<void>(resolve => { ioServer.close(); httpServer.close(() => resolve()) }),
    }
}

// ===== real socket.io client (via hub) =====
type ClientOpts = {port: number, token?: string | null, socketKey?: string, opt?: RpcOpt}

export async function startRealClient<T extends object = any>(opts: ClientOpts) {
    const {port, token = null, socketKey = 'rpc', opt} = opts
    const hub = createRpcClientHub(
        () => io(`http://localhost:${port}`, {transports: ['websocket'], forceNew: true}),
        (r) => ({api: r<T>(socketKey)}) as const,
        { opt },
    )
    const clients = await hub.setToken(token)
    await clients.api.readyStrict()
    return {
        hub,
        client: clients.api,                 // createRpcClient surface (auth/reauth/dispose/onDisconnect/subscriptions/schema)
        api: clients.api.func as any,         // transparent proxy — call site
        close: () => hub.socket?.disconnect?.(),
    }
}

// ===== assertions =====
export type Failure = {name: string, got?: any, expected?: any, error?: string}

function eq(a: any, b: any) {
    // normalize Date → ISO for comparing round-trip rich types
    const norm = (v: any) => JSON.stringify(v, (_k, val) => val instanceof Date ? ['__date', val.toISOString()]
        : val instanceof Map ? ['__map', [...val]] : val instanceof Set ? ['__set', [...val]]
        : typeof val === 'bigint' ? ['__big', val.toString()] : val)
    return norm(a) === norm(b)
}

export function makeChecker(label: string) {
    let pass = 0, fail = 0
    const failures: Failure[] = []
    async function check(name: string, fn: () => any, expected: any) {
        try {
            const got = await fn()
            if (eq(got, expected)) { pass++; console.log(`PASS  [${label}] ${name}`) }
            else { fail++; failures.push({name, got, expected}); console.log(`FAIL  [${label}] ${name}  got=${JSON.stringify(got)}  exp=${JSON.stringify(expected)}`) }
        } catch (e: any) {
            fail++; failures.push({name, error: String(e?.stack ?? e)}); console.log(`FAIL  [${label}] ${name}  ERROR=${String(e?.message ?? e)}`)
        }
    }
    return {
        check,
        summary: () => ({label, total: pass + fail, passed: pass, failed: fail, failures}),
        done: () => { console.log(`\n##RESULT## ${JSON.stringify({label, total: pass + fail, passed: pass, failed: fail, failures})}`); return fail },
    }
}
