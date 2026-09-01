// Mini horizontal scaling stand (leader side) — the PROCESS host only. All
// authority behavior (replica line, node directory, command corridor with
// receipts, identity lifecycle over the replicated deny list, gated
// connections) lives in the LIBRARY facade Scale.createAuthority; this file
// keeps what only a process can own: the tick ticker, child-process
// spawn/drain/kill, the autoscale loop, the token/secret env plumbing and the
// token CRYPTO (the authority receives {issue, verify} adapters, never a
// secret format). The key stand property survives unchanged: drain is DATA,
// not a control channel — the child watches the same directory facts every
// browser sees and leaves on its own fact.
import {ChildProcess, spawn} from 'child_process'
import {randomBytes} from 'crypto'
import path from 'path'
import {createAuthority} from '../src/Common/scale/scale-authority'
import {createTokenCodec} from '../src/server/auth-token'

export type MiniTickState = Record<string, {id: string, value: number, ts: number}>

export type MiniScaleHostDeps = {
    /** Client-reachable origin of THIS stand; read lazily (port binds late). */
    selfUrl: () => string
    log?: (line: string) => void
    maxNodes?: number
}

export function createMiniScaleHost(deps: MiniScaleHostDeps) {
    const log = deps.log ?? console.log
    const maxNodes = deps.maxNodes ?? 5
    // ADDITIVE k8s override (experiments/wenay-k8s/deploy): DEMO_MINI_TOKEN and
    // DEMO_MINI_SECRET pin the per-run values so EXTERNALLY spawned nodes
    // (minikube pods holding the same values via a Secret) can join this
    // leader; both unset = exactly the old behavior, random per run.
    const pinnedToken = process.env.DEMO_MINI_TOKEN?.trim() || null
    const pinnedSecret = process.env.DEMO_MINI_SECRET?.trim() || null
    // per-run trust for mini-node links; passed to children through env only.
    // CSPRNG, not Math.random: the token gates registration and the secret
    // signs every session token — neither may be predictable.
    const token = pinnedToken ?? 'mini-' + randomBytes(12).toString('hex')
    // per-run shared secret of the scale corridor: every node verifies client tokens itself
    const secret = pinnedSecret ?? 'scale-' + randomBytes(16).toString('hex')
    const codec = createTokenCodec({secret, ttlMs: 2 * 60_000})

    const authority = createAuthority<MiniTickState, {
        add: (ctx: {account: string}, input: {delta?: unknown}) => {value: number, by: string}
    }>({
        storeId: 'mini-scale', originId: 'mini-scale-origin', nodeId: 'leader', lineId: 'mini-leader',
        initial: {tick: {id: 'tick', value: 0, ts: Date.now()}},
        selfUrl: deps.selfUrl,
        limits: {perMinute: 60},
        commands: {
            add(ctx, input) {
                const delta = Number(input?.delta ?? 0)
                if (!Number.isFinite(delta) || Math.abs(delta) > 1000) throw new Error('delta is out of bounds')
                const value = (authority.line.control.store.state.counter?.value ?? 0) + delta
                authority.line.control.store.state.counter = {id: 'counter', value, ts: Date.now()}
                return {value, by: ctx.account}
            },
        },
        // crypto stays host-side: the authority sees mint/verify, never the secret
        identity: {
            issue: account => codec.issue({sub: account}),
            verify(presented) {
                const verdict = codec.verify(presented)
                if (!verdict.ok) throw new Error('token rejected: ' + verdict.reason)
                return {account: verdict.claims.sub, expiresAt: verdict.claims.exp}
            },
        },
        // only a process this host spawned may register as a node — unless the
        // operator pinned the token: pinning IS the explicit statement that
        // external processes presenting it (the k8s pods) may register too
        acceptNode: nodeId => children.has(nodeId) || pinnedToken != null,
        meta: hostMeta,
        log,
    })

    // a silent process relaunch resets the in-memory store; this line makes every
    // authority birth visible, and headSeq == tick.value is the restart detector
    log(`[demo] mini-scale authority constructed (pid ${process.pid} @ ${new Date().toISOString()})`)

    // ============== the live line: a ticker proves continuity across moves ==============
    const ticker = setInterval(function advanceMiniTick() {
        const current = authority.line.control.store.state.tick
        authority.line.control.store.state.tick = {id: 'tick', value: (current?.value ?? 0) + 1, ts: Date.now()}
    }, 400)
    ;(ticker as any).unref?.()

    let started = false
    /** Extra leader-row facts beside {readers}: the pid, the autoscale mode and its last verdict. */
    function hostMeta() {
        return {pid: process.pid, autoscale: autoscaleOn, autoNote: autoscaleOn ? autoNote : ''}
    }
    /** Call once the HTTP port is bound: the authority row + heartbeat go live. */
    function start() {
        started = true
        authority.start()
    }

    // ============== children lifecycle ==============
    const children = new Map<string, ChildProcess>()
    let nextNode = 0

    function spawnNode() {
        start()
        if (children.size >= maxNodes) throw new Error(`mini node limit reached (${maxNodes})`)
        const nodeId = 'mini-' + (++nextNode)
        const tsxCli = path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
        const script = path.resolve(__dirname, 'mini-scale-node.ts')
        const child = spawn(process.execPath, [tsxCli, script], {
            env: {...process.env, MINI_NODE_ID: nodeId, MINI_UPSTREAM: deps.selfUrl(), MINI_TOKEN: token, MINI_SECRET: secret},
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout?.on('data', function miniNodeOut(chunk) { log(`[${nodeId}] ${String(chunk).trim()}`) })
        child.stderr?.on('data', function miniNodeErr(chunk) { log(`[${nodeId}] ${String(chunk).trim()}`) })
        child.on('exit', function miniNodeGone(code) {
            children.delete(nodeId)
            authority.directory.control.remove(nodeId)
            log(`[demo] mini node ${nodeId} exited (${code ?? 'signal'})`)
        })
        children.set(nodeId, child)
        log(`[demo] mini node ${nodeId} spawning`)
        return {nodeId}
    }

    function drainNode(nodeId: string) {
        if (nodeId == 'leader') throw new Error('the leader cannot be drained in this stand')
        return {ok: authority.directory.control.drain(nodeId)}
    }

    /** Failure injection: SIGKILL — no drain, no goodbye. The exit handler removes the row. */
    function killNode(nodeId: string) {
        if (nodeId == 'leader') throw new Error('the leader cannot be killed in this stand')
        const child = children.get(nodeId)
        if (!child) throw new Error('unknown mini node')
        child.kill('SIGKILL')
        log(`[demo] mini node ${nodeId} KILLED (SIGKILL) — watch readers fail over, not drain`)
        return {killed: true as const, nodeId}
    }

    // ============== autoscale: readers are the load fact, processes are the capacity ==============
    // The loop reads the SAME replicated directory the panel shows: load per node is
    // a fact every node reported about itself, so scaling decisions are reproducible
    // from the panel alone. BOTH directions carry hysteresis: the readers facts lag
    // heartbeats by a tick or two, so at an exact capacity boundary an eager spawn
    // flaps against the drain forever (spawn → facts settle → drain → repeat).
    const AUTOSCALE_READERS_PER_NODE = 3
    let autoscaleOn = false
    let calmTicks = 0
    let wantTicks = 0
    // the last verdict rides the leader's meta so EVERY panel can explain the fleet
    let autoNote = ''
    const loadWindow: number[] = []
    function evaluateAutoscale() {
        if (!autoscaleOn || !started) return
        const rows = authority.view.nodes()
        const minis = rows.filter(row => row.role == 'mirror' && !row.draining && !row.stale)
        // readers on draining/stale rows are IN FLIGHT to other nodes: counting them
        // double-books every migration and the controller ends up chasing its own churn
        const settled = rows.filter(row => !row.draining && !row.stale)
        const totalReaders = settled.reduce((sum, row) => sum + Number(row.meta?.readers ?? 0), 0)
        const raw = Math.max(0, totalReaders - minis.length)
        // migration double counts only ever INFLATE the sum, so the window MINIMUM
        // of the last three samples is the trustworthy load estimate
        loadWindow.push(raw)
        if (loadWindow.length > 3) loadWindow.shift()
        const load = Math.min(...loadWindow)
        const targetNodes = Math.max(1, Math.ceil(load / AUTOSCALE_READERS_PER_NODE))
        const targetMinis = Math.min(maxNodes, targetNodes - 1)
        // "have" counts spawned-but-not-yet-registered children too, or the 1-2s
        // registration lag turns every scale-up into a spawn storm
        const have = Math.max(minis.length, children.size)
        const shape = `load ${load} → ${targetNodes} node${targetNodes == 1 ? '' : 's'}`
        if (have < targetMinis && children.size < maxNodes) {
            calmTicks = 0
            // two consecutive ticks must agree before a spawn: filters the lag transient
            if (++wantTicks < 2) { autoNote = `${shape} · confirming ${wantTicks}/2`; return }
            wantTicks = 0
            const {nodeId} = spawnNode()
            autoNote = `${shape} · spawning ${nodeId}`
            log(`[demo] autoscale: ${load} readers want ${targetNodes} nodes — spawning ${nodeId}`)
        } else if (minis.length > targetMinis) {
            wantTicks = 0
            if (++calmTicks < 3) { autoNote = `${shape} · calm ${calmTicks}/3`; return }
            calmTicks = 0
            const newest = [...minis].sort(function byNodeNumber(a, b) {
                return Number(a.nodeId.split('-')[1] ?? 0) - Number(b.nodeId.split('-')[1] ?? 0)
            }).at(-1)
            if (!newest) return
            authority.directory.control.drain(newest.nodeId)
            autoNote = `${shape} · draining ${newest.nodeId}`
            log(`[demo] autoscale: ${load} readers fit ${targetNodes} nodes — draining ${newest.nodeId}`)
        } else {
            calmTicks = 0
            wantTicks = 0
            autoNote = `${shape} · steady`
        }
    }
    const autoscaleTimer = setInterval(evaluateAutoscale, 2000)
    ;(autoscaleTimer as any).unref?.()

    function setAutoscale(on: boolean) {
        autoscaleOn = on
        calmTicks = 0
        wantTicks = 0
        loadWindow.length = 0
        autoNote = ''
        // publish the mode immediately: the button state is a replicated fact, not local UI state
        if (started) authority.directory.control.heartbeat('leader', {meta: {readers: authority.view.readers(), ...hostMeta()}})
        log(`[demo] autoscale ${on ? 'ON' : 'OFF'} (${AUTOSCALE_READERS_PER_NODE} readers per node)`)
        return {autoscale: on}
    }

    // ============== fragments: retransmit the authority's serve blocks ==============
    /** Participant surface (ungated): the authority's browser block + demo-only process admin. */
    function browserFragment(account: string) {
        return {
            ...authority.serve.browser(account),
            admin: {
                spawn: function spawnMiniNode() { return spawnNode() },
                drain: function drainMiniNode(nodeId: unknown) { return drainNode(String(nodeId)) },
                kill: function killMiniNode(nodeId: unknown) { return killNode(String(nodeId)) },
                autoscale: function toggleAutoscale(on: unknown) { return setAutoscale(on == true) },
            },
        }
    }

    function close() {
        clearInterval(ticker)
        clearInterval(autoscaleTimer)
        for (const [nodeId, child] of children) {
            child.kill()
            children.delete(nodeId)
        }
        authority.close()
    }

    return {
        token,
        start,
        browserFragment,
        readFragment: authority.serve.reader,
        scaleConnection: authority.serve.connection,
        nodeLinkFragment: authority.serve.nodeLink,
        commandNames: authority.corridor.names,
        close,
    }
}
export type MiniScaleHost = ReturnType<typeof createMiniScaleHost>
