import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createTokenCodec} from '../../../../src/server/auth-token'
import type {HomeState, HomeService} from './service'

type HostStats = ReturnType<HomeService['view']['stats']>
type Ready = {type: 'ready', url: string, pid: number}

// === Local process resource: readiness, bounded requests and teardown ===
function startProcess(deps: {initial: HomeState, secret: string, dataDir: string, port?: number}) {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'host.ts')], {
        cwd: __dirname,
        env: {...process.env, SMART_HOME_INITIAL: JSON.stringify(deps.initial), SMART_HOME_SECRET: deps.secret,
            SMART_HOME_DATA_DIR: deps.dataDir, SMART_HOME_PORT: String(deps.port ?? 0), SMART_HOME_IDLE_MS: '80'},
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    })
    let output = ''
    let stopped = false
    let requestId = 0
    function capture(chunk: Buffer) { output = (output + chunk.toString()).slice(-12_000) }
    child.stdout!.on('data', capture)
    child.stderr!.on('data', capture)
    const pending = new Map<string, {resolve: (stats: HostStats) => void, reject: (error: Error) => void}>()
    let resolveReady!: (value: Ready) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<Ready>(function awaitReady(resolve, reject) { resolveReady = resolve; rejectReady = reject })
    const startup = setTimeout(function expired() { rejectReady(new Error('host startup timed out: ' + output)) }, 15_000)
    ready.catch(function observeReadinessFailure() {})
    child.on('message', function message(value: unknown) {
        if (!value || typeof value != 'object') return
        const event = value as Ready | (HostStats & {type: 'stats', requestId: string})
        if (event.type == 'ready') { clearTimeout(startup); resolveReady(event) }
        else if (event.type == 'stats') pending.get(event.requestId)?.resolve(event)
    })
    const done = new Promise<void>(function awaitExit(resolve) {
        function exited(error?: Error) {
            stopped = true
            clearTimeout(startup)
            const failure = error ?? new Error('host exited: ' + output)
            rejectReady(failure)
            for (const waiter of pending.values()) waiter.reject(failure)
            pending.clear()
            resolve()
        }
        child.once('error', exited)
        child.once('exit', function exit() { exited() })
    })
    async function stats() {
        if (stopped) throw new Error('host is stopped')
        const id = String(++requestId)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
            return await new Promise<HostStats>(function request(resolve, reject) {
                pending.set(id, {resolve, reject})
                timeout = setTimeout(function expired() { reject(new Error('host stats timed out: ' + output)) }, 3000)
                child.send({type: 'stats', requestId: id}, function sent(error) { if (error) reject(error) })
            })
        } finally { clearTimeout(timeout); pending.delete(id) }
    }
    async function stop(crash = false) {
        if (stopped) return
        if (crash || !child.connected) child.kill('SIGKILL')
        else child.send({type: 'shutdown'}, function sent(error) { if (error) child.kill('SIGKILL') })
        const force = setTimeout(function forceExit() { child.kill('SIGKILL') }, 1500)
        try { await done } finally { clearTimeout(force) }
    }
    return {ready, stats, stop, view: {pid: () => child.pid, stopped: () => stopped}}
}

// === Explicit household placement; one independent writer process per home ===
export async function startHomeStand() {
    const temp = await realpath(tmpdir())
    const data = await mkdtemp(path.join(temp, 'wenay-home-'))
    const secret = randomBytes(32).toString('hex')
    const codec = createTokenCodec({secret, ttlMs: 60_000})
    const initial = {
        anna: {devices: {meter: {home: 'anna', label: 'Power', reading: 0, secret: 'private-anna'}}},
        bob: {devices: {heater: {home: 'bob', label: 'Heater', reading: 21, secret: 'private-bob'}}},
    } satisfies Record<string, HomeState>
    type tHome = keyof typeof initial
    const owners = new Map<tHome, {process: ReturnType<typeof startProcess>, url: string}>()
    const resources = new Set<ReturnType<typeof startProcess>>()
    const restarts = new Map<tHome, Promise<void>>()
    let closing: Promise<void> | undefined

    function owner(home: tHome) {
        if (closing) throw new Error('stand is closing')
        const entry = owners.get(home)
        if (!entry) throw new Error('unknown household: ' + home)
        return entry
    }
    async function boot(home: tHome, port?: number) {
        if (closing) throw new Error('stand is closing')
        const process = startProcess({initial: initial[home], secret, dataDir: path.join(data, home), port})
        resources.add(process)
        const ready = await process.ready
        if (closing) throw new Error('stand closed during host startup')
        owners.set(home, {process, url: ready.url})
    }
    function reader(home: tHome) {
        return {url: owner(home).url, token: function token() { return codec.issue({sub: home, home, role: 'reader'}) }}
    }
    function device(home: tHome) {
        const device = Object.keys(initial[home].devices)[0]
        return {url: owner(home).url, token: function token() { return codec.issue({sub: device, home, device, role: 'device'}) }}
    }
    async function crash(home: tHome) { await owner(home).process.stop(true) }
    function restart(home: tHome) {
        const previous = owner(home)
        const existing = restarts.get(home)
        if (existing) return existing
        const operation = (async function restartOwner() {
            await previous.process.stop()
            await boot(home, Number(new URL(previous.url).port))
            resources.delete(previous.process)
        })().finally(function finished() { restarts.delete(home) })
        restarts.set(home, operation)
        return operation
    }
    function close() {
        if (!closing) closing = (async function closeResources() {
            await Promise.all([...resources].map(resource => resource.stop()))
            const resolved = await realpath(data)
            if (path.dirname(resolved) != temp || !path.basename(resolved).startsWith('wenay-home-')) {
                throw new Error('refusing to remove an unexpected data directory')
            }
            await rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 100})
        })()
        return closing
    }
    try {
        await boot('anna')
        await boot('bob')
        return {
            source: {reader, device},
            control: {crash, restart},
            view: {stats: (home: tHome) => owner(home).process.stats(), pid: (home: tHome) => owner(home).process.view.pid()},
            close,
        }
    } catch (error) { await close(); throw error }
}
export type HomeStand = Awaited<ReturnType<typeof startHomeStand>>
