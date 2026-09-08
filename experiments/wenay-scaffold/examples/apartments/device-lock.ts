// =====================================================================
// device-lock — the lock as a client of the service (a process, or in-process)
// =====================================================================
// EXAMPLE-OWNED. Equipment is a principal like a person: it logs in with its
// own credentials (role 'device'), follows ITS command line (the `myLock`
// view — only its lock, only pending commands, only the codes valid today),
// executes, and reports through the same corridor everybody uses. All of
// that is the template's createServiceClient: login and renewal, placement
// on a serving node by the roster, the view line as a live Store, typed
// commands — the device itself is the motor and the keypad.
// Process: SERVICE_URL (the leader), LOCK_ACCOUNT, LOCK_PASSWORD (npm run device).
// In-process (the check): runLockDevice({url, account, password}).

import {createServiceClient} from '../../template/client'
import {serviceDefinition, type LockCommand} from './service'
import {lockCommandIsCurrent} from './lock-policy'

type ServiceClient = ReturnType<typeof createServiceClient<typeof serviceDefinition>>
export type LockDeviceClient = {
    views: Pick<ServiceClient['views'], 'myLock'>
    commands: Pick<ServiceClient['commands'], 'lockReport' | 'lockHeartbeat' | 'lockEvent'>
    view: Pick<ServiceClient['view'], 'endpoint'>
    close: ServiceClient['close']
}
type tLocalOutcome = 'running' | 'done' | 'expired' | 'cancelled'

export type LockDeviceDeps = {
    /** The leader's origin; the client places itself on a serving node from the roster. */
    url: string
    account: string
    password: string
    heartbeatMs?: number
    /** Simulated motor time per command (default 40ms). */
    executeMs?: number
    /** 'nodes' (default) attaches to a serving node when one exists; 'any' also considers the leader. */
    prefer?: 'nodes' | 'any'
    log?: (line: string) => void
    /** An embedded host may supply its already verified client resource. */
    client?: LockDeviceClient
    now?: () => number
    reportAttempts?: number
    reportDelayMs?: number
}

/** An RPC rejection may be a bare {code} object: name it instead of printing [object Object]. */
const describe = (error: unknown) => (error as {message?: string})?.message ?? (error as {code?: string})?.code ?? String(error)

export function runLockDevice(deps: LockDeviceDeps) {
    const log = deps.log ?? (() => {})
    const executeMs = deps.executeMs ?? 40
    const heartbeatMs = deps.heartbeatMs ?? 5_000
    const now = deps.now ?? Date.now
    const outcomes = new Map<string, {state: tLocalOutcome, reported: boolean, attempts: number}>()
    const timers = new Map<ReturnType<typeof setTimeout>, (elapsed: boolean) => void>()
    const active = new Set<Promise<void>>()
    let closed = false
    let battery = 97
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let offCommands: (() => void) | undefined
    let rejectClosed!: (error: Error) => void
    const closedReady = new Promise<never>(function closeBeforeReady(_resolve, reject) { rejectClosed = reject })

    const client = deps.client ?? createServiceClient({
        definition: serviceDefinition,
        url: deps.url,
        auth: {credentials: {account: deps.account, password: deps.password}},
        placement: {prefer: deps.prefer ?? 'nodes'},
        clientId: 'lock-' + deps.account,
        log,
    })
    const myLock = client.views.myLock

    function wait(ms: number) {
        if (closed) return Promise.resolve(false)
        return new Promise<boolean>(function delay(resolve) {
            const timer = setTimeout(function elapsed() {
                timers.delete(timer)
                resolve(true)
            }, ms)
            timers.set(timer, resolve)
        })
    }

    async function execute(command: LockCommand) {
        if (closed || outcomes.has(command.id)) return
        const outcome = {state: 'running' as tLocalOutcome, reported: false, attempts: 0}
        outcomes.set(command.id, outcome)
        const admitted = lockCommandIsCurrent(command, now())
        if (admitted) {
            if (!await wait(executeMs)) {
                outcome.state = 'cancelled'
                return
            }
        }
        if (closed) return
        // The simulated actuator effect happens only after the delay and final deadline check.
        outcome.state = admitted && lockCommandIsCurrent(command, now()) ? 'done' : 'expired'
        const detail = outcome.state == 'expired' ? 'command expired before actuation'
            : command.kind == 'setCode' ? 'code armed' : command.kind == 'unlock' ? 'bolt retracted for ' + command.requestedBy : 'code cleared'
        // Local effect and report acknowledgement are separate; retries use the SAME requestId.
        // (an endpoint re-placed, the corridor's per-account rate limit, a transient refusal)
        for (let attempt = 1; !closed; attempt++) {
            outcome.attempts = attempt
            try {
                await client.commands.lockReport('report-' + command.id, {commandId: command.id, ok: outcome.state == 'done', detail})
                outcome.reported = true
                log(`lock ${deps.account}: ${command.kind} ${command.id} ${outcome.state}`)
                return
            } catch (error) {
                log(`lock ${deps.account}: report of ${command.id} failed (attempt ${attempt}): ${describe(error)}`)
                // Unknown acknowledgement never permits executing the physical action again.
                if (attempt >= (deps.reportAttempts ?? 12)) return
                if (!await wait(deps.reportDelayMs ?? Math.min(1000 * attempt, 5000))) return
            }
        }
    }
    function sweep() {
        for (const command of Object.values(myLock.store.state.commands ?? {})) {
            if (closed || outcomes.has(command.id)) continue
            const operation = execute({...command}).finally(function settled() { active.delete(operation) })
            active.add(operation)
        }
    }

    const boot = (async function bootDevice() {
        await myLock.ready
        if (closed) throw new Error('lock device closed')
        offCommands = myLock.store.node.commands.on(sweep)
        sweep()
        async function beat() {
            if (closed) return
            battery = Math.max(0, battery - 0.01)
            try { await client.commands.lockHeartbeat('hb-' + deps.account + '-' + Date.now(), {battery: Math.round(battery)}) }
            catch (error) { log(`lock ${deps.account}: heartbeat failed: ${describe(error)}`) }
        }
        await beat()
        if (closed) return
        heartbeat = setInterval(function heartbeatTick() { void beat() }, heartbeatMs)
        log(`lock ${deps.account} online via ${client.view.endpoint()?.nodeId ?? '?'}`)
    })()
    const ready = Promise.race([boot, closedReady])
    ready.catch(function observeEarlyClose() {})

    /** Someone types a code at the door: validated LOCALLY against the line, reported as an event. */
    function currentCode(code: string) {
        if (closed) return
        const known = myLock.store.state.codes?.[code]
        const day = new Date(now()).toISOString().slice(0, 10)
        return known && known.from <= day && day < known.to ? {...known} : undefined
    }

    async function enterCode(code: string) {
        if (closed) return false
        await ready
        if (closed) return false
        const known = currentCode(code)
        if (known) {
            await client.commands.lockEvent('code-' + Date.now(), {kind: 'code-entered', detail: 'booking ' + known.bookingId})
            if (currentCode(code)?.bookingId != known.bookingId) return false
            await client.commands.lockEvent('open-' + Date.now(), {kind: 'door-opened'})
            return true
        }
        await client.commands.lockEvent('reject-' + Date.now(), {kind: 'code-rejected'})
        return false
    }

    function close() {
        if (closed) return
        closed = true
        rejectClosed(new Error('lock device closed'))
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        offCommands?.()
        for (const [timer, resolve] of timers) {
            clearTimeout(timer)
            resolve(false)
        }
        timers.clear()
        client.close()
    }

    return {
        ready,
        view: {
            state: () => myLock.store.state,
            endpoint: () => client.view.endpoint(),
            executed: () => [...outcomes].filter(([, outcome]) => outcome.state == 'done').map(([id]) => id),
            outcomes: () => Object.fromEntries([...outcomes].map(([id, outcome]) => [id, {...outcome}])),
            pending: () => ({timers: timers.size, operations: active.size, heartbeat: heartbeat != null}),
        },
        control: {enterCode},
        close,
    }
}
export type LockDevice = ReturnType<typeof runLockDevice>

// ============================================================
// the device PROCESS
// ============================================================

if (require.main == module) {
    const url = process.env['SERVICE_URL'] ?? process.env['SERVICE_LOGIN_URL']
    const account = process.env['LOCK_ACCOUNT'] ?? 'lock-1'
    const password = process.env['LOCK_PASSWORD'] ?? ''
    if (!url || !password) {
        console.error('set SERVICE_URL (the leader), LOCK_ACCOUNT and LOCK_PASSWORD')
        process.exit(2)
    }
    const device = runLockDevice({url, account, password, log: line => console.log('[device] ' + line)})
    device.ready.then(function online() {
        console.log(`[device] ${account} ready`)
    }, function failed(error: unknown) {
        console.error(error)
        process.exit(2)
    })
    process.once('SIGINT', function onSigint() { device.close(); setTimeout(() => process.exit(0), 100) })
    process.once('SIGTERM', function onSigterm() { device.close(); setTimeout(() => process.exit(0), 100) })
}
