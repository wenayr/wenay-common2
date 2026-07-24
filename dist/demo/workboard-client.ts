import {listen} from '../src/Common/events/Listen'
import {StoreDrain} from '../src/Common/Observe/store'
import {followReplicatedMap, ReplicatedMapStatus, tReplicatedMapDelivery} from '../src/Common/Observe/replicated-map'
import {tStoreReplayMode} from '../src/Common/Observe/store-replay'
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
    /** @deprecated Replicated Map owns transport lifecycle/status; retained for stand call-site compatibility. */
    transport?: WorkboardTransport
    initial?: WorkboardState
    drain?: StoreDrain
}

export type WorkboardClientStatus = {
    connection: tWorkboardConnection
    delivery: tReplicatedMapDelivery
    replayMode: tStoreReplayMode
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
    const [emitStatus, statusChanges] = listen<[WorkboardClientStatus]>()
    let connection: tWorkboardConnection = 'connecting'
    let pending = 0
    let lastError: string | null = null
    let closed = false
    let initialized = false

    function applyReplicatedMapStatus(next: ReplicatedMapStatus) {
        if (next.state == 'live') {
            connection = 'live'
            lastError = null
        } else if (next.state == 'reconnecting') connection = 'reconnecting'
        else if (next.state == 'connecting') connection = 'connecting'
        else {
            connection = 'stale'
            if (next.error != null) lastError = errorText(next.error)
        }
        if (initialized) changed()
    }

    const stateSync = followReplicatedMap(deps.remote.state, {
        initial: deps.initial,
        drain: deps.drain,
        onStatus: applyReplicatedMapStatus,
    })
    initialized = true
    const store = stateSync.debug.store

    function status(): WorkboardClientStatus {
        return {
            connection,
            delivery: stateSync.delivery(),
            replayMode: stateSync.replayMode(),
            pending,
            lastError,
            seq: stateSync.seq(),
        }
    }

    function changed() {
        if (!closed) emitStatus(status())
    }

    const ready = stateSync.ready.then(function workboardReady() {
        applyReplicatedMapStatus(stateSync.status())
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
        return Object.values(stateSync.snapshot())
            .filter(item => !statusFilter || item.status == statusFilter)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }

    function counts() {
        const result: Record<tWorkboardStatus, number> = {new: 0, active: 0, done: 0}
        for (const item of Object.values(stateSync.snapshot())) result[item.status]++
        return result
    }

    return {
        /** @deprecated Stand compatibility; application reads go through the Replicated Map facade. */
        store,
        batches: stateSync.batches,
        get: stateSync.get,
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
            stateSync.close()
            statusChanges.close()
        },
    }
}

export type WorkboardClient = ReturnType<typeof createWorkboardClient>
