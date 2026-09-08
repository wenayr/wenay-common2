import {createServer} from 'node:http'
import {join} from 'node:path'
import {Server} from 'socket.io'
import {listen} from '../../../../src/Common/events/Listen'
import {type StorePatch} from '../../../../src/Common/Observe/store'
import {createRpcServerAuto} from '../../../../src/Common/rcp/rpc-server-auto'
import {createTokenCodec} from '../../../../src/server/auth-token'
import {openFsReplayStorage} from '../../../../src/server/fsReplayStorage'
import {createHomeService, type HomeService, type HomeState, type tReading} from './service'

// === Principal facades: the token selects the home and device ===
export function createReaderFacade(deps: {service: HomeService, home: string}) {
    return {source: deps.service.source.household(deps.home)}
}
export type ReaderFacade = ReturnType<typeof createReaderFacade>

export function createDeviceFacade(deps: {service: HomeService, device: string}) {
    function record(reading: tReading) {
        if (reading !== null && typeof reading != 'string' && typeof reading != 'boolean'
            && !(typeof reading == 'number' && Number.isFinite(reading))) {
            throw new Error('reading must be a finite scalar or null')
        }
        return deps.service.control.record(deps.device, reading)
    }
    return {control: {record}}
}
export type DeviceFacade = ReturnType<typeof createDeviceFacade>

// === Process resources ===
export async function startHomeHost(deps: {
    initial: HomeState
    secret: string
    port?: number
    dataDir?: string
    idleMs?: number
}) {
    const codec = createTokenCodec({secret: deps.secret, ttlMs: 60_000})
    const homes = new Set(Object.values(deps.initial.devices).map(device => device.home))
    const archives = new Map<string, ReturnType<typeof openFsReplayStorage<[readonly StorePatch[]]>>>()
    function storage(home: string) {
        let archive = archives.get(home)
        if (!archive) {
            // Hex encoding keeps tenant ids out of filesystem path interpretation.
            archive = openFsReplayStorage<[readonly StorePatch[]]>(join(deps.dataDir!, Buffer.from(home).toString('hex') + '.jsonl'))
            archives.set(home, archive)
        }
        return archive
    }
    const service = createHomeService({
        initial: deps.initial,
        idleMs: deps.idleMs,
        storage: deps.dataDir ? storage : undefined,
    })
    const http = createServer()
    const io = new Server(http, {transports: ['websocket']})
    let closing: Promise<void> | undefined

    io.on('connection', function connected(socket) {
        const [gone, disconnected] = listen<[]>()
        socket.on('disconnect', function disconnect() {
            gone()
            disconnected.close()
        })
        createRpcServerAuto({
            socket,
            socketKey: 'home',
            object: {},
            disconnectListen: disconnected,
            auth: {
                gate: true,
                resolveAuth(token: unknown) {
                    const verdict = codec.verify(token)
                    if (!verdict.ok) throw new Error(verdict.reason)
                    const {home, role, device} = verdict.claims
                    if (typeof home != 'string' || !homes.has(home)) throw new Error('home is not hosted here')
                    let object: ReaderFacade | DeviceFacade
                    if (role == 'reader') object = createReaderFacade({service, home})
                    else if (role == 'device') {
                        if (typeof device != 'string' || !Object.hasOwn(deps.initial.devices, device)
                            || deps.initial.devices[device].home != home) throw new Error('device does not belong to home')
                        object = createDeviceFacade({service, device})
                    } else throw new Error('unknown role')
                    return {object, ack: {ok: true, home, role}, expiresAt: verdict.claims.exp, renewBeforeMs: 10_000}
                },
            },
        })
    })

    function close() {
        if (!closing) closing = new Promise<void>(function closeResources(resolve, reject) {
            io.close(function transportClosed(error?: Error) {
                try { service.close() } catch (cause) { reject(cause); return }
                if (error) reject(error)
                else resolve()
            })
        })
        return closing
    }

    try {
        await new Promise<void>(function startListening(resolve, reject) {
            http.once('error', reject)
            http.listen(deps.port ?? 0, '127.0.0.1', function listening() {
                http.off('error', reject)
                resolve()
            })
        })
    } catch (error) {
        await close().catch(function ignoreCleanupFailure() {})
        throw error
    }
    const address = http.address()
    if (!address || typeof address == 'string') throw new Error('host has no TCP address')
    return {url: `http://127.0.0.1:${address.port}`, view: {...service.view}, close}
}
export type HomeHost = ReturnType<typeof startHomeHost>

async function main() {
    const host = await startHomeHost({
        initial: JSON.parse(process.env.SMART_HOME_INITIAL ?? '{"devices":{}}'),
        secret: process.env.SMART_HOME_SECRET ?? '',
        port: Number(process.env.SMART_HOME_PORT ?? 0),
        dataDir: process.env.SMART_HOME_DATA_DIR,
        idleMs: Number(process.env.SMART_HOME_IDLE_MS ?? 100),
    })
    async function shutdown() {
        await host.close()
        if (process.connected) process.disconnect?.()
    }
    process.on('message', function command(message: unknown) {
        if (!message || typeof message != 'object') return
        const request = message as {type?: string, requestId?: string}
        if (request.type == 'stats') process.send?.({type: 'stats', requestId: request.requestId, ...host.view.stats()})
        if (request.type == 'shutdown') shutdown().catch(fatal)
    })
    process.on('SIGTERM', function terminate() { shutdown().catch(fatal) })
    process.on('SIGINT', function interrupt() { shutdown().catch(fatal) })
    process.on('disconnect', function parentDisconnected() { host.close().catch(fatal) })
    process.send?.({type: 'ready', url: host.url, pid: process.pid})
}

function fatal(error: unknown) {
    console.error(error)
    process.exitCode = 1
}

if (require.main == module) main().catch(fatal)
