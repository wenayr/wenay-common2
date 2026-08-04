// ============================================================
// flowCallback — flow-paced streaming callbacks (backpressure)
// ============================================================
// The sibling of endCallback: one marks the END of a stream, this one paces it. A server
// method that pushes chunks through a client-supplied callback wraps it ONCE:
//
//     async function readBack(a, cb) {
//         const flow = flowCallback(cb)
//         while (hasMore) await flow.push(await readNext())
//         return {total}
//     }
//
// push() sends the frame exactly like cb() would and resolves when the flow window allows the
// next one. Two independent signals gate it, both server-side:
//   1. credit window (negotiated, Caps.CB_FLOW) — the client runtime acks CUMULATIVELY after
//      delivering frames to the app callback (after its promise settles, if it returns one);
//      push waits when sent - acked >= window. Watermark semantics: on a fast link acks refill
//      the window before it drains and the producer never stalls.
//   2. local watermark (no protocol) — pending() > highWater suspends until <= lowWater, the
//      conflateReplay vocabulary. This is the fallback an un-negotiated (old) peer gets.
// On a callback that never traveled the wire (local call, tests) the wrapper degrades to
// resolve-immediately: producer code is identical in-process and over RPC.
//
// This module owns only the OUTWARD surface and the wrapper→host registry (the same WeakMap
// pattern endCallback uses). The live gate — counters, waiters, wire packets — is built by the
// server (rpc-server.ts), which is the only layer that knows the channel and the caps.

import { MyError } from '../../toError/myThrow'

export type RpcFlowOpts = {
    /** Max unacked frames in flight before push() waits (credit window). Default 32. */
    window?: number
    /** Client ack cadence in frames. Default max(1, window/4) — acks coalesce, never 1/frame. */
    ackEvery?: number
    /** Local watermark source (signal 2): outgoing pending in the caller's own unit.
     *  Default: best-effort socket.io writeBuffer probe; a foreign adapter has none. */
    pending?: () => number
    /** pending() > highWater → push waits. Default 128. */
    highWater?: number
    /** Resume at pending() <= lowWater. Default highWater/4. */
    lowWater?: number
    /** Poll interval for the watermark and transport liveness while waiting, ms. Default 25. */
    pollMs?: number
}

/** The live half a wire callback's host exposes to the wrapper. */
export type tRpcFlowGate = {
    /** Resolves when the window allows the next frame; rejects E_FLOW_CLOSED. */
    wait: () => Promise<void>
    /** Unacked frames (negotiated) or the local watermark reading (fallback). */
    pending: () => number
    /** null while the stream is alive; a short reason once it is not. */
    closedReason: () => string | null
}

type tRpcFlowOpen = (opts?: RpcFlowOpts) => tRpcFlowGate

// Same idiom as _stopRegistry/endCallback: the wrapper function IS the key, so application
// callback signatures never change and a local function simply has no entry.
const flowHosts = new WeakMap<Function, tRpcFlowOpen>()

/** Wire layers register how to open a flow gate for a callback wrapper they created. */
export function registerRpcFlowHost(cb: Function, open: tRpcFlowOpen) {
    flowHosts.set(cb, open)
}

export function rpcFlowClosedError(reason: string) {
    return new MyError('RPC flow closed: ' + reason, 'E_FLOW_CLOSED')
}

const RESOLVED = Promise.resolve()

export type RpcFlow<A extends any[] = any[]> = {
    /** Send a frame (exactly cb(...args)) and wait until it is OK to produce more.
     *  Never throws synchronously; after close it rejects E_FLOW_CLOSED. */
    push: (...args: A) => Promise<void>
    /** Frames in flight: sent - acked (negotiated) or the local watermark reading. */
    pending: () => number
    /** The stream is dead (disconnect, endCallback, method settled) — loops may exit early. */
    closed: () => boolean
}

/** Wrap a client-supplied streaming callback so the producer can await backpressure.
 *  Local (non-wire) callbacks pass through: push resolves immediately. */
export function flowCallback<A extends any[]>(cb: (...args: A) => any, opts?: RpcFlowOpts): RpcFlow<A> {
    const open = flowHosts.get(cb)
    if (!open) {
        return {
            push: function pushLocal(...args: A) {
                try { cb(...args) } catch (e) { return Promise.reject(e) }
                return RESOLVED
            },
            pending: () => 0,
            closed: () => false,
        }
    }
    const gate = open(opts)
    return {
        push: function push(...args: A) {
            const reason = gate.closedReason()
            if (reason != null) return Promise.reject(rpcFlowClosedError(reason))
            try { cb(...args) } catch (e) { return Promise.reject(e) }
            return gate.wait()
        },
        pending: gate.pending,
        closed: () => gate.closedReason() != null,
    }
}
