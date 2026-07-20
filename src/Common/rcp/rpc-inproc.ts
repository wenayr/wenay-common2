import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from './rpc-server'
import { createRpcServerAuto } from './rpc-server-auto'
import { createRpcClient } from './rpc-client'
import type { SocketTmpl } from './rpc-protocol'
import type { DeepSocketListen } from './listen-deep'

// ===================================================================
// IN-PROC TRANSPORT (Tier 1, BACK-BACK enabler)
// -------------------------------------------------------------------
// Server and client in ONE process: pair of in-memory SocketTmpl carries exactly the same
// wire as network. Reuses ALL core code (pack/unpack, dedup, MAP/STRICT/HELLO, off()-handles,
// throttle, limits, auth) — without new semantics.
//
// HONEST BOUNDARY: this is in-PROC, NOT zero-cost. Each message undergoes JSON clone
// (like real transport and rpc.harness.spec.ts:createLoopback), so Date/Map/BigInt
// round-trip and dedup are byte-for-byte identical to prod. True zero-clone (by-reference)
// direct-call proxy — separate bigger step (Tier 1b, changes argument semantics: object
// identity, callback lifetime).
// ===================================================================

// --- resource: pair of linked SocketTmpl (same loopback as in harness, but as export) ---
export function createInProcSocketPair(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            // non-reentrant (queueMicrotask) + JSON clone: wire semantics one-to-one
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)] // [client, server]
}

// --- business: real server+client over in-proc pair ---
export function createRpcInProc<T extends object>({
    object: target,
    socketKey = 'rpc',
    listen = true,
    debug,
    hooks,
    limits,
    auth,
    token,
    throttle,
    maxPerListen,
    opt,
}: {
    object: T
    socketKey?: string
    /** true (default): Listen nodes → listenSocket, as on network (createRpcServerAuto).
     *  false: bare createRpcServer (without auto-wrapper Listen). */
    listen?: boolean
    debug?: boolean
    hooks?: any
    limits?: RpcLimits
    auth?: RpcServerAuth
    /** With auth/gate: in-proc pair does NOT emit 'connect' (no hub) — call initStrict()/readyStrict()
     *  on returned client to run HELLO handshake before gated calls. */
    token?: any
    /** Passes to server listen layer (throttle streams) when listen:true. */
    throttle?: number
    maxPerListen?: number
    /** Wire optimizations (contractual): { compact?: false } disables tick compaction. */
    opt?: RpcOpt
}) {
    const [clientSocket, serverSocket] = createInProcSocketPair()
    // Return CLIENT as SDK handle (same call site as over network). Server `{ api }`
    // from createRpcServerAuto (server-side stats) intentionally not passed — client
    // api.subscriptions() gives equivalent (deduplicated) view; server side here.
    if (listen) {
        createRpcServerAuto({ socket: serverSocket, object: target as any, socketKey, debug, hooks, limits, auth, throttle, maxPerListen, opt })
    } else {
        createRpcServer({ socket: serverSocket, object: target as any, socketKey, debug, hooks: hooks as PromiseServerHooks<T>, limits, auth, opt })
    }
    return createRpcClient<DeepSocketListen<T>>({ socket: clientSocket, socketKey, limits, token, opt })
}
