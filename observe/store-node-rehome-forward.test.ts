// ============================================================
//  observe/store-node-rehome-forward.test.ts
//
//  Found by examples/apartments: after the LEADER restarts, a serving node
//  re-homes onto the new link (registers, follows the control line, resumes
//  the mirror) — but a client session opened on the node BEFORE the restart
//  keeps forwarding its commands through the OLD link, so every write of a
//  long-lived client (a lock device, a kiosk) fails with "RPC client
//  disposed" until it reconnects. The forward must resolve the node's CURRENT
//  upstream at call time. Negative control: a session opened AFTER the
//  re-home forwards fine, which is why the defect hid behind short-lived
//  oracle clients.
//  Run: node node_modules/tsx/dist/cli.mjs observe/store-node-rehome-forward.test.ts
// ============================================================

import {createStore} from '../src/Common/Observe/store'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {createNodeDirectory} from '../src/Common/Observe/node-directory'
import {createStoreNode, type StoreNodeRevocation} from '../src/Common/Observe/store-node'
import {createCommandHost} from '../src/Common/command/command-host'
import {verifyCommands} from '../src/Common/command/command-token'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createLoopbackSocketPair} from '../src/Common/rcp/rpc-inproc'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {listen} from '../src/Common/events/Listen'
import {runOracle} from '../oracle/run-oracle'

type TickState = Record<string, {id: string, value: number}>

let fails = 0
let step = 0
const ok = (condition: any, message: string) => {
    const label = String(++step).padStart(2, ' ')
    if (!condition) { fails++; console.log(`${label}. FAIL ${message}`) }
    else console.log(`${label}. OK   ${message}`)
}
async function waitFor(message: string, check: () => boolean, timeoutMs = 4000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return }
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    ok(false, message + ' (timed out)')
}
function parseToken(presented: unknown) {
    const text = String(presented ?? '')
    if (!text.startsWith('tok:')) throw new Error('bad token')
    return {account: text.slice(4)}
}

async function runChecks() {
    // ============== the authority: one line, one command host, two successive LINKS to it ==============
    const authority = createStoreReplicaSet<TickState>({
        storeId: 'rehome-line', originId: 'rehome-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: {tick: {id: 'tick', value: 0}},
        leadership: {initialRole: 'leader', epoch: 1},
    })
    const controlStore = createStore<{nodes: Record<string, any>, revoked: Record<string, StoreNodeRevocation>}>({nodes: {}, revoked: {}})
    const controlLine = exposeStoreReplay(controlStore)
    const directory = createNodeDirectory({store: controlStore, staleMs: 0})
    const executed: string[] = []
    const host = createCommandHost({
        commands: {
            add(ctx, input: {delta: number}) {
                executed.push(ctx.requestId)
                return {delta: input.delta, by: ctx.account}
            },
        },
    })
    const verified = verifyCommands({host, accountOf: presented => parseToken(presented).account})

    // link A dies when the leader process goes away: its RPC proxies reject like a disposed client
    let linkAlive = true
    const deadCommands = new Proxy({}, {
        get: (_target, name) => (token: unknown, requestId: string, input: any) => {
            if (!linkAlive) return Promise.reject(new Error('RPC client disposed'))
            return (verified.fragment() as any)[name](token, requestId, input)
        },
    }) as ReturnType<typeof verified.fragment>
    const [failA, failAListen] = listen<[]>()
    function makeLink(commandsByToken: ReturnType<typeof verified.fragment>, onFail: {on: (cb: () => void) => () => void}) {
        return {
            replica: authority.api.fragment,
            control: controlLine.api.replay,
            commandsByToken,
            register: (entry: any) => directory.control.set({...entry, role: 'mirror'}),
            heartbeat: (id: string, facts: any) => directory.control.heartbeat(id, {meta: {readers: facts?.readers ?? 0}}),
            goodbye: (id: string) => directory.control.remove(id),
            onFail,
        }
    }
    const linkA = makeLink(deadCommands, {on: cb => failAListen.on(cb)})
    const linkB = makeLink(verified.fragment(), {on: () => () => {}})
    let current = linkA
    let resolved = 0

    // ============== the node: resolves the CURRENT link per attempt (the scaffold's shape) ==============
    let connect: ((socket: SocketTmpl) => void) | null = null
    const node = createStoreNode<TickState>({
        line: {nodeId: 'n1', storeId: 'rehome-line', originId: 'rehome-origin'},
        roster: {url: () => 'mem://n1', graceMs: 40, heartbeatMs: 50},
        auth: {verify: parseToken},
        commands: ['add'],
        upstream: () => { resolved++; return current },
        serve: {onConnection(handler) { connect = handler }, wrap: (fragment: Record<string, unknown>) => ({svc: fragment})},
        onLeave: () => {},
        log: () => {},
    })
    await node.start()
    ok(directory.control.get('n1')?.role == 'mirror', 'the node registered through link A')

    // a LONG-LIVED client session on the node (a device), opened before the leader restarts
    const {client: clientEnd, server: serverEnd, kill} = createLoopbackSocketPair()
    connect!(serverEnd)
    const device = createRpcClient<any>({socket: clientEnd, socketKey: 'scale', token: 'tok:lock-1'})
    await device.readyStrict()
    const before = await device.func.svc.commands.add('r1', {delta: 1})
    ok(before.by == 'lock-1' && executed.includes('r1'), 'before the restart the device forwards through link A')

    // ============== the leader "restarts": link A is dead, the node re-homes onto link B ==============
    linkAlive = false
    current = linkB
    failA()
    await waitFor('the node re-homes onto link B (registers again, follows its control line)', () => node.view.status().rehomes >= 1 && resolved >= 2, 8000)

    // negative control: a session opened AFTER the re-home forwards through B
    const {client: lateEnd, server: lateServer, kill: killLate} = createLoopbackSocketPair()
    connect!(lateServer)
    const late = createRpcClient<any>({socket: lateEnd, socketKey: 'scale', token: 'tok:kiosk'})
    await late.readyStrict()
    const lateAnswer = await late.func.svc.commands.add('r2', {delta: 1}).then((r: any) => r.by, (error: any) => 'ERR ' + (error?.message ?? error))
    ok(lateAnswer == 'kiosk', `control: a session opened after the re-home forwards through link B (${lateAnswer})`)

    // the defect: the EXISTING session still forwards through the dead link A
    const after = await device.func.svc.commands.add('r3', {delta: 1}).then((r: any) => r.by, (error: any) => 'ERR ' + (error?.message ?? error))
    ok(after == 'lock-1' && executed.includes('r3'), `the device's existing session forwards through the CURRENT link after the re-home (${after})`)

    kill()
    killLate()
    node.close()
    directory.control.close()
    controlLine.close()
    authority.close()
    console.log(fails == 0 ? '\nstore-node-rehome-forward: ALL GREEN' : `\nstore-node-rehome-forward: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}

async function main() {
    await runChecks().catch(function fatal(error) {
        console.error(error)
        process.exit(2)
    })
}

runOracle(main)
