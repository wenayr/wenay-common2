// ===========================================================================
// RPC FLOW SPEC — flowCallback (flow-paced streaming callbacks) acceptance.
//
// Real client + real server over the in-memory loopback (JSON clone per packet, like the
// harness): every check exercises the actual wire — Pkt.CB_FLOW declaration, cumulative
// Pkt.CB_ACK, credit stalls, watermark fallback, disconnect rejection, local pass-through.
//
// Run:   npx tsx src/Common/rcp/rpc-flow.spec.ts
// Excluded from build (*.spec.ts in tsconfig.exclude) — does NOT reach published lib.
// ===========================================================================

import { createRpcServer } from './rpc-server'
import { createRpcClient } from './rpc-client'
import { flowCallback } from './rpc-flow'
import { endCallback } from './rpc-off'
import { Pkt, type SocketTmpl } from './rpc-protocol'

// loopback with JSON clone — as in rpc.harness.spec.ts
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

function tapPackets(s: SocketTmpl) {
    const seen: any[] = []
    const orig = s.emit.bind(s)
    s.emit = (e, d) => { seen.push(d); orig(e, d) }
    return seen
}

// Logical opcodes as sent, envelopes unwrapped.
function logicalOps(seen: any[]) {
    return seen.filter(Array.isArray).flatMap(function unwrap(d: any[]): number[] {
        if (d[0] == Pkt.CB_BATCH || d[0] == Pkt.BATCH) return (d[1] as any[]).map(p => p[0])
        return [d[0]]
    })
}

const delay = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

let fails = 0
function check(name: string, got: unknown, exp: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(exp)
    if (!ok) fails++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got=${JSON.stringify(got)}  exp=${JSON.stringify(exp)}`)
}

// ===================================================================
// 1. slow consumer: in-flight bounded by the window, order intact
// ===================================================================
async function slowConsumerStaysBounded() {
    const [cs, ss] = createLoopback()
    const TOTAL = 120
    const WINDOW = 8
    let maxInFlight = 0
    const serverObj = {
        stream: async function stream(cb: (n: number) => void) {
            const flow = flowCallback(cb, {window: WINDOW})
            for (let i = 0; i < TOTAL; i++) {
                const settled = flow.push(i)
                maxInFlight = Math.max(maxInFlight, flow.pending())
                await settled
            }
            return TOTAL
        },
    }
    createRpcServer({socket: ss, object: serverObj, socketKey: 'rpc'})
    const c = createRpcClient<typeof serverObj>({socket: cs, socketKey: 'rpc'})
    await c.initStrict()
    const seen: number[] = []
    // async consumer: each frame takes a real macrotask — the producer MUST stall on credit
    const total = await c.func.stream(async function consume(n: number) {
        seen.push(n)
        if (n % 10 == 0) await delay(1)
    } as any)
    check('slow: total returned', total, TOTAL)
    check('slow: every frame delivered in order', seen.length == TOTAL && seen.every((v, i) => v == i), true)
    check('slow: in-flight never exceeded the window', maxInFlight <= WINDOW, true)
    check('slow: the window actually engaged (producer stalled)', maxInFlight == WINDOW, true)
    // ordering guarantee: the call promise settled only AFTER the last queued frame landed
    check('slow: response waited for the flow drain', seen.length, TOTAL)
}

// ===================================================================
// 2. fast consumer: acks refill the window before it drains
// ===================================================================
async function fastConsumerNeverStalls() {
    const [cs, ss] = createLoopback()
    const TOTAL = 200
    const WINDOW = 32
    let maxInFlight = 0
    const serverObj = {
        stream: async function stream(cb: (n: number) => void) {
            const flow = flowCallback(cb, {window: WINDOW})
            for (let i = 0; i < TOTAL; i++) {
                const settled = flow.push(i)
                maxInFlight = Math.max(maxInFlight, flow.pending())
                await settled
            }
            return flow.closed()
        },
    }
    createRpcServer({socket: ss, object: serverObj, socketKey: 'rpc'})
    const c = createRpcClient<typeof serverObj>({socket: cs, socketKey: 'rpc'})
    await c.initStrict()
    const seen: number[] = []
    const closedDuring = await c.func.stream((n: number) => { seen.push(n) })
    check('fast: every frame delivered in order', seen.length == TOTAL && seen.every((v, i) => v == i), true)
    check('fast: window never engaged', maxInFlight < WINDOW, true)
    check('fast: stream alive for the whole run', closedDuring, false)
}

// ===================================================================
// 3. old client (no Caps.CB_FLOW): watermark fallback still bounds
// ===================================================================
async function oldClientFallsBackToWatermark() {
    const [cs, ss] = createLoopback()
    const TOTAL = 50
    const HIGH = 5
    let buffered = 0 // the "transport buffer" the pending() lambda reports
    let maxBuffered = 0
    const drainTimer = setInterval(function drainBuffer() { if (buffered > 0) buffered-- }, 2)
    const serverObj = {
        stream: async function stream(cb: (n: number) => void) {
            const flow = flowCallback(cb, {
                window: 4,
                pending: () => buffered,
                highWater: HIGH,
                lowWater: 1,
                pollMs: 2,
            })
            for (let i = 0; i < TOTAL; i++) {
                buffered++
                maxBuffered = Math.max(maxBuffered, buffered)
                await flow.push(i)
            }
            return TOTAL
        },
    }
    const serverOut = tapPackets(ss)
    createRpcServer({socket: ss, object: serverObj, socketKey: 'rpc'})
    // flowCallback: false — the emulated OLD peer: it never advertises the bit, never acks
    const c = createRpcClient<typeof serverObj>({socket: cs, socketKey: 'rpc', opt: {flowCallback: false}})
    const clientOut = tapPackets(cs)
    await c.initStrict()
    const seen: number[] = []
    const total = await c.func.stream((n: number) => { seen.push(n) })
    clearInterval(drainTimer)
    check('fallback: total returned', total, TOTAL)
    check('fallback: every frame delivered in order', seen.length == TOTAL && seen.every((v, i) => v == i), true)
    check('fallback: watermark bounded the producer', maxBuffered <= HIGH + 1, true)
    check('fallback: server never declared CB_FLOW', logicalOps(serverOut).includes(Pkt.CB_FLOW), false)
    check('fallback: client never sent CB_ACK', logicalOps(clientOut).includes(Pkt.CB_ACK), false)
}

// ===================================================================
// 4. disconnect mid-stream: pending push rejects E_FLOW_CLOSED
// ===================================================================
async function disconnectRejectsPendingPush() {
    const [cs, ss] = createLoopback()
    const serverObj = {
        stream: async function stream(cb: (n: number) => void) {
            const flow = flowCallback(cb, {window: 2, pollMs: 5})
            try {
                for (let i = 0; i < 100; i++) await flow.push(i)
                return {done: true as const}
            } catch (e: any) {
                return {code: e?.code as string, closed: flow.closed()}
            }
        },
    }
    createRpcServer({socket: ss, object: serverObj, socketKey: 'rpc'})
    const c = createRpcClient<typeof serverObj>({socket: cs, socketKey: 'rpc'})
    await c.initStrict()
    let frames = 0
    let hold = true
    const held: (() => void)[] = []
    const result = c.func.stream(function consumeStalled(n: number) {
        frames++
        // held frames never settle → no acks → the producer stalls on credit
        if (hold) return new Promise<void>(function holdFrame(res) { held.push(res) })
    } as any)
    // let the producer reach the stall, then kill the transport under it
    await delay(30)
    ;(ss as any).disconnected = true
    await delay(30) // poll notices, waiters reject, the method returns its catch
    ;(ss as any).disconnected = false // let the RESP travel the loopback
    hold = false
    for (const release of held.splice(0)) release() // drain → the deferred response lands
    const got: any = await result
    check('disconnect: push rejected with E_FLOW_CLOSED', got?.code, 'E_FLOW_CLOSED')
    check('disconnect: flow reports closed', got?.closed, true)
    check('disconnect: consumer saw the first frame', frames >= 1, true)
}

// ===================================================================
// 5. local (non-wire) callback: transparent pass-through
// ===================================================================
async function localCallbackPassesThrough() {
    const seen: number[] = []
    const flow = flowCallback((n: number) => { seen.push(n) })
    for (let i = 0; i < 5; i++) await flow.push(i)
    check('local: frames delivered synchronously in order', seen, [0, 1, 2, 3, 4])
    check('local: pending is zero', flow.pending(), 0)
    check('local: never closed', flow.closed(), false)
    const failing = flowCallback(function throwing() { throw new Error('consumer boom') })
    const rejected = await failing.push().then(() => false, () => true)
    check('local: consumer throw becomes a rejection', rejected, true)
}

// ===================================================================
// 6. lifecycle closes: method settle and endCallback both kill the gate
// ===================================================================
async function settledAndEndedFlowsReject() {
    const [cs, ss] = createLoopback()
    let escaped: ReturnType<typeof flowCallback> | null = null
    const serverObj = {
        brief: async function brief(cb: (n: number) => void) {
            const flow = flowCallback(cb, {window: 4})
            await flow.push(1)
            escaped = flow // deliberately outlives the method promise
            return 'ok'
        },
        ended: async function ended(cb: (n: number) => void) {
            const flow = flowCallback(cb, {window: 4})
            await flow.push(1)
            endCallback(cb)
            const code = await flow.push(2).then(() => null, (e: any) => e?.code)
            return {code, closed: flow.closed()}
        },
    }
    createRpcServer({socket: ss, object: serverObj, socketKey: 'rpc'})
    const c = createRpcClient<typeof serverObj>({socket: cs, socketKey: 'rpc'})
    await c.initStrict()
    check('settle: method result intact', await c.func.brief(() => {}), 'ok')
    const lateCode = await escaped!.push(2).then(() => null, (e: any) => e?.code)
    check('settle: push after the promise settled rejects', lateCode, 'E_FLOW_CLOSED')
    check('settle: escaped flow reports closed', escaped!.closed(), true)
    const got = await c.func.ended(() => {})
    check('ended: push after endCallback rejects', got, {code: 'E_FLOW_CLOSED', closed: true})
}

export async function runRpcFlowTests() {
    console.log('--- FLOW: credit window + watermark + lifecycle ---')
    await slowConsumerStaysBounded()
    await fastConsumerNeverStalls()
    await oldClientFallsBackToWatermark()
    await disconnectRejectsPendingPush()
    await localCallbackPassesThrough()
    await settledAndEndedFlowsReject()
    return fails
}

async function main() {
    const failed = await runRpcFlowTests()
    if (failed > 0) {
        console.error(`rpc-flow spec: ${failed} check(s) failed`)
        process.exit(1)
    }
    console.log('rpc-flow spec: all checks passed')
}

if (process.argv[1] && /rpc-flow\.spec/.test(process.argv[1])) {
    main().catch(e => { console.error(e); process.exit(1) })
}
