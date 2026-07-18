import {listen} from '../src/Common/events/Listen'
import {createStore, StoreDrain} from '../src/Common/Observe/store'
import {syncStoreReplay} from '../src/Common/Observe/store-replay'
import {
    tWorkboardStatus,
    WorkboardAssignInput,
    WorkboardCreateInput,
    WorkboardMoveInput,
    WorkboardRemote,
    WorkboardRenameInput,
    WorkboardRevisionInput,
    WorkboardState,
    workboardStatuses,
} from './workboard-contract'

export type tWorkboardConnection = 'connecting' | 'live' | 'reconnecting' | 'stale'

type WorkboardTransport = {
    connected: () => boolean
    connectListen: (cb: () => void) => () => void
    disconnectListen: (cb: (reason: string) => void) => () => void
}

type WorkboardClientDeps = {
    remote: WorkboardRemote
    transport?: WorkboardTransport
    initial?: WorkboardState
    drain?: StoreDrain
}

export type WorkboardClientStatus = {
    connection: tWorkboardConnection
    pending: number
    lastError: string | null
    seq: number
}

function errorText(error: unknown) {
    if (error instanceof Error) return error.message
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

export function createWorkboardClient(deps: WorkboardClientDeps) {
    const store = createStore<WorkboardState>(deps.initial ?? {}, deps.drain !== undefined ? {drain: deps.drain} : {})
    const [emitStatus, statusChanges] = listen<[WorkboardClientStatus]>()
    let connection: tWorkboardConnection = 'connecting'
    let pending = 0
    let lastError: string | null = null
    let closed = false
    let wasLive = false

    const stateSync = syncStoreReplay(store, deps.remote.state, {
        onError(error) {
            connection = 'stale'
            lastError = errorText(error)
            changed()
        },
    })

    function status(): WorkboardClientStatus {
        return {connection, pending, lastError, seq: stateSync.seq()}
    }

    function changed() {
        if (!closed) emitStatus(status())
    }

    function setConnection(next: tWorkboardConnection) {
        if (connection == next) return
        connection = next
        if (next == 'live') wasLive = true
        changed()
    }

    const offConnect = deps.transport?.connectListen(function workboardTransportConnected() {
        setConnection('live')
    }) ?? function noConnectListener() {}
    const offDisconnect = deps.transport?.disconnectListen(function workboardTransportDisconnected(reason) {
        lastError = reason || null
        setConnection(wasLive ? 'reconnecting' : 'connecting')
    }) ?? function noDisconnectListener() {}

    const ready = stateSync.ready.then(function workboardReady() {
        setConnection('live')
    })

    async function run<T>(command: () => T | Promise<T>) {
        pending++
        lastError = null
        changed()
        try {
            return await command()
        } catch (error) {
            lastError = errorText(error)
            changed()
            throw error
        } finally {
            pending--
            changed()
        }
    }

    function create(input: WorkboardCreateInput) {
        return run(() => deps.remote.create(input))
    }

    function rename(input: WorkboardRenameInput) {
        return run(() => deps.remote.rename(input))
    }

    function move(input: WorkboardMoveInput) {
        return run(() => deps.remote.move(input))
    }

    function assign(input: WorkboardAssignInput) {
        return run(() => deps.remote.assign(input))
    }

    function remove(input: WorkboardRevisionInput) {
        return run(() => deps.remote.remove(input))
    }

    function items(statusFilter?: tWorkboardStatus) {
        return Object.values(store.state)
            .filter(item => !statusFilter || item.status == statusFilter)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }

    function counts() {
        const result: Record<tWorkboardStatus, number> = {new: 0, active: 0, done: 0}
        for (const item of Object.values(store.state)) result[item.status]++
        return result
    }

    return {
        store,
        statusChanges,
        ready,
        status,
        create,
        rename,
        move,
        assign,
        remove,
        items,
        counts,
        statuses: workboardStatuses,
        close() {
            if (closed) return
            closed = true
            offConnect()
            offDisconnect()
            stateSync()
            statusChanges.close()
        },
    }
}

export type WorkboardClient = ReturnType<typeof createWorkboardClient>
