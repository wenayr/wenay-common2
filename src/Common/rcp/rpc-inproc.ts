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
// HONEST BOUNDARY: this is in-PROC, NOT zero-cost. Each message undergoes a JSON clone
// plus detached binary attachments, matching the two parts Socket.IO transports.
// Date/Map/BigInt were already packed by RPC. True zero-clone (by-reference)
// direct-call proxy — separate bigger step (Tier 1b, changes argument semantics: object
// identity, callback lifetime).
// ===================================================================

function activeBinaryBytes(value: ArrayBuffer | ArrayBufferView) {
    return value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function cloneInProcBinary(value: ArrayBuffer | ArrayBufferView) {
    const source = activeBinaryBytes(value)
    const bytes = new Uint8Array(source.byteLength)
    bytes.set(source)
    if (value instanceof ArrayBuffer) return bytes.buffer
    if (value instanceof DataView) return new DataView(bytes.buffer)
    const Constructor = value.constructor as any
    if (typeof Constructor.from == 'function' && typeof Constructor.isBuffer == 'function'
        && Constructor.isBuffer(value)) {
        return Constructor.from(bytes)
    }
    try { return new Constructor(bytes.buffer) }
    catch { return bytes }
}

function defineInProcWireValue(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
}

function detachInProcBinary(
    value: any,
    attachments: (ArrayBuffer | ArrayBufferView)[],
    active: WeakSet<object>,
): unknown {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const num = attachments.length
        attachments.push(cloneInProcBinary(value))
        return {_placeholder: true, num}
    }
    if (value == null || typeof value != 'object') return value
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype != Object.prototype && prototype != null) return value
    if (active.has(value)) throw new TypeError('createInProcSocketPair: cyclic wire value')
    active.add(value)
    try {
        if (Array.isArray(value)) {
            return value.map(function detachInProcArrayItem(item) {
                return detachInProcBinary(item, attachments, active)
            })
        }
        const detached: Record<string, unknown> = {}
        for (const key of Object.keys(value)) {
            defineInProcWireValue(detached, key, detachInProcBinary(value[key], attachments, active))
        }
        return detached
    } finally {
        active.delete(value)
    }
}

function restoreInProcBinary(value: any, attachments: readonly (ArrayBuffer | ArrayBufferView)[]): any {
    if (value == null || typeof value != 'object') return value
    const keys = Object.keys(value)
    if (keys.length == 2 && value['_placeholder'] == true && Number.isSafeInteger(value['num'])) {
        const attachment = attachments[value['num']]
        if (attachment == undefined) throw new TypeError('createInProcSocketPair: invalid binary placeholder')
        return attachment
    }
    if (Array.isArray(value)) {
        return value.map(function restoreInProcArrayItem(item) {
            return restoreInProcBinary(item, attachments)
        })
    }
    const restored: Record<string, unknown> = {}
    for (const key of keys) {
        defineInProcWireValue(restored, key, restoreInProcBinary(value[key], attachments))
    }
    return restored
}

function cloneInProcWire(value: any) {
    if (value === undefined) return undefined
    const attachments: (ArrayBuffer | ArrayBufferView)[] = []
    const detached = detachInProcBinary(value, attachments, new WeakSet<object>())
    return restoreInProcBinary(JSON.parse(JSON.stringify(detached)), attachments)
}

// --- resource: pair of linked SocketTmpl (same loopback as in harness, but as export) ---
export function createInProcSocketPair(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            // Non-reentrant and detached: no object identity leaks across the wire.
            const wire = cloneInProcWire(d)
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)] // [client, server]
}

// --- resource: loopback pair WITH a connection lifecycle — the testing-kit variant ---
// Same detached in-proc wire as createInProcSocketPair, plus the two facts a transport test
// needs to stage: a silent offline window (frames are lost, nobody is told — the gap before
// socket.io notices) and a definitive socket death ('disconnect' on both ends, delivery over).
// Consolidates the ad-hoc createLoopback copies of the spec suites into one canonical export.
export function createLoopbackSocketPair(opts: {
    /** 'micro' (default): each frame lands in its own microtask, like every spec harness.
     *  'sync': emit delivers before returning — for step-by-step protocol assertions. */
    delivery?: 'micro' | 'sync'
} = {}) {
    const sync = opts.delivery == 'sync'
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    let online = true
    let dead = false
    function fire(handlers: Record<string, ((d: any) => void)[]>, event: string, data: any) {
        for (const cb of handlers[event] ?? []) cb(data)
    }
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            if (dead || !online) return
            const wire = cloneInProcWire(d)
            if (sync) { fire(theirs, e, wire); return }
            // in-flight frames also drop when the link dies/goes offline before delivery
            queueMicrotask(function deliverLoopbackFrame() { if (!dead && online) fire(theirs, e, wire) })
        },
    })
    const client = make(A, B)
    const server = make(B, A)
    function kill() {
        if (dead) return false
        dead = true
        fire(A, 'disconnect', undefined)
        fire(B, 'disconnect', undefined)
        return true
    }
    return {
        client, server,
        /** Definitive socket death: 'disconnect' fires on BOTH ends, delivery stops forever.
         *  false = already dead. */
        kill,
        /** Silent loss window: false drops every frame without telling either end; true resumes.
         *  No 'disconnect'/'connect' is emitted — that is kill()'s job. No effect after kill(). */
        setOnline(value: boolean) { if (!dead) online = value },
        online: () => online && !dead,
    }
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
    /** Negotiated JSON-wire optimizations. Compact shapes and callback batching default on. */
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
