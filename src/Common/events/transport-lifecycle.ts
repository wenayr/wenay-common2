// =====================================================================
// Internal transport lifecycle shared by RPC Listen and replay recovery.
// =====================================================================

export const RPC_TRANSPORT_LIFECYCLE = Symbol.for('wenay-common2.rpc.transportLifecycle')
export const RPC_TRANSPORT_CONTROL = Symbol.for('wenay-common2.rpc.transportControl')
export const RPC_MEMBER_LOOKUP = Symbol.for('wenay-common2.rpc.memberLookup')
export const RPC_SCHEMA_READY = Symbol.for('wenay-common2.rpc.schemaReady')

export type RpcMemberLookup = (member: string) => boolean | undefined

function getRpcMemberLookup(remote: any) {
    try {
        const candidate = remote?.[RPC_MEMBER_LOOKUP]
        if (typeof candidate != 'function') return undefined
        if (Object.getOwnPropertyDescriptor(candidate, RPC_MEMBER_LOOKUP)?.value != true) return undefined
        return candidate as RpcMemberLookup
    } catch {
        return undefined
    }
}

export function hasRpcMemberLookup(remote: any) {
    return getRpcMemberLookup(remote) != undefined
}

export function getRpcMemberState(remote: any, member: string) {
    return getRpcMemberLookup(remote)?.(member)
}

export function rpcMemberAvailable(remote: any, member: string) {
    const lookup = getRpcMemberLookup(remote)
    if (lookup) {
        try { return lookup(member) == true }
        catch { return false }
    }
    try {
        return remote != null
            && (typeof remote == 'object' || typeof remote == 'function')
            && member in remote
            && remote[member] != null
    } catch {
        return false
    }
}

/**
 * Capability choice after the caller has awaited RPC_SCHEMA_READY. Dynamic
 * schema paths may honestly remain unknown; retain their structural/proxy
 * member until the map explicitly proves absence.
 */
export function rpcMemberMayBeAvailable(remote: any, member: string) {
    const lookup = getRpcMemberLookup(remote)
    if (lookup) {
        try {
            const state = lookup(member)
            if (state != undefined) return state
            return remote?.[member] != null
        } catch {
            return false
        }
    }
    try {
        return remote != null
            && (typeof remote == 'object' || typeof remote == 'function')
            && member in remote
            && remote[member] != null
    } catch {
        return false
    }
}

export type RpcSchemaReady = () => Promise<void>

export function getRpcSchemaReady(remote: any) {
    try {
        const candidate = remote?.[RPC_SCHEMA_READY]
        if (typeof candidate != 'function') return undefined
        if (Object.getOwnPropertyDescriptor(candidate, RPC_SCHEMA_READY)?.value != true) return undefined
        return candidate as RpcSchemaReady
    } catch {
        return undefined
    }
}

export type TransportLifecycleApi = {
    connected: () => boolean
    closed: () => boolean
    generation: () => number
    onConnect: (cb: (generation: number) => void) => () => void
    onDisconnect: (cb: (reason: string, generation: number) => void) => () => void
    onClose: (cb: (reason: string) => void) => () => void
}

export function getRpcTransportLifecycle(remote: any) {
    try {
        const candidate = remote?.[RPC_TRANSPORT_LIFECYCLE]
        if (candidate == null || (typeof candidate != 'object' && typeof candidate != 'function')) return undefined
        if (Object.getOwnPropertyDescriptor(candidate, RPC_TRANSPORT_LIFECYCLE)?.value != true) return undefined
        return candidate as TransportLifecycleApi
    } catch {
        return undefined
    }
}

export type TransportLifecycleControl = {
    connect: () => void
    disconnect: (reason: string) => void
    close: (reason: string) => void
}

export function createTransportLifecycle(initialConnected = true) {
    let online = initialConnected
    let terminal = false
    let generation = initialConnected ? 1 : 0
    const connectCbs = new Set<(generation: number) => void>()
    const disconnectCbs = new Set<(reason: string, generation: number) => void>()
    const closeCbs = new Set<(reason: string) => void>()

    function onConnect(cb: (generation: number) => void) {
        connectCbs.add(cb)
        return function offConnect() { connectCbs.delete(cb) }
    }

    function onDisconnect(cb: (reason: string, generation: number) => void) {
        disconnectCbs.add(cb)
        return function offDisconnect() { disconnectCbs.delete(cb) }
    }

    function onClose(cb: (reason: string) => void) {
        closeCbs.add(cb)
        return function offClose() { closeCbs.delete(cb) }
    }

    function connect() {
        if (terminal || online) return
        online = true
        generation++
        for (const cb of [...connectCbs]) cb(generation)
    }

    function disconnect(reason: string) {
        if (terminal || !online) return
        online = false
        for (const cb of [...disconnectCbs]) cb(reason, generation)
    }

    function close(reason: string) {
        if (terminal) return
        terminal = true
        online = false
        for (const cb of [...closeCbs]) cb(reason)
        connectCbs.clear()
        disconnectCbs.clear()
        closeCbs.clear()
    }

    const api: TransportLifecycleApi = {
        connected: () => online,
        closed: () => terminal,
        generation: () => generation,
        onConnect,
        onDisconnect,
        onClose,
    }
    Object.defineProperty(api, RPC_TRANSPORT_LIFECYCLE, {value: true})

    const control: TransportLifecycleControl = {connect, disconnect, close}
    return {api, control}
}
