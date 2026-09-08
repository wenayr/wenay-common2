import {io} from 'socket.io-client'
import {createRpcClientHub} from 'wenay-common2/rpc'
import {createStoreReplicaSet} from 'wenay-common2/observe'
import type {createServiceLeader} from '../../template/leader'
import type {serviceDefinition, RentalState} from './service'

type Leader = ReturnType<typeof createServiceLeader<typeof serviceDefinition>>
type Reader = ReturnType<Leader['serve']['readFragment']>
type Writer = ReturnType<ReturnType<Leader['serve']['scaleConnection']>['auth']['resolveAuth']>['object']

// Example-local session: the endpoint can be the authority or a serving node.
// Reconnection restores reads; commands are never silently retried.
export function createRentalClient(deps: {url: string, token: string, nodeId: string}) {
    const hubs = new Set<ReturnType<typeof createHub>>()
    let active: Awaited<ReturnType<ReturnType<typeof createHub>['setToken']>> | undefined
    let closed = false

    function createHub() {
        const hub = createRpcClientHub(function openSocket() {
            const socket = io(deps.url, {transports: ['websocket'], forceNew: true, reconnection: false, timeout: 3000})
            socket.once('connect_error', function dialFailed() { hub.close('rental endpoint unavailable') })
            return socket
        }, rpc => ({read: rpc<{rental: Reader}>('app'), write: rpc<{rental: Writer}>('scale')}))
        return hub
    }

    async function connect() {
        if (closed) throw new Error('rental client is closed')
        const hub = createHub()
        hubs.add(hub)
        let current: typeof active
        const timeout = setTimeout(function handshakeExpired() { hub.close('rental handshake timed out') }, 5000)
        function closeSession() {
            if (active == current) active = undefined
            hubs.delete(hub)
            hub.close()
        }
        try {
            current = await hub.setToken(deps.token)
            await Promise.all([current.read.readyStrict(), current.write.readyStrict()])
            if (closed) throw new Error('rental client is closed')
            active = current
            return {
                remote: current.read.func.rental.replica,
                onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
                close: closeSession,
            }
        } catch (error) {
            closeSession()
            throw error
        } finally {
            clearTimeout(timeout)
        }
    }

    const line = createStoreReplicaSet<RentalState>({
        storeId: 'rental-store', originId: 'rental-origin', nodeId: deps.nodeId,
        initial: {items: {}, bookings: {}},
        leadership: {initialRole: 'follower', eligible: false},
    })
    line.control.addOffer({id: 'rental-endpoint', connect})

    function commands() {
        if (closed || !active) throw new Error('rental client is not connected')
        return active.write.func.rental.commands
    }
    function close() {
        if (closed) return
        closed = true
        active = undefined
        line.close()
        for (const hub of hubs) hub.close()
        hubs.clear()
    }

    return {
        view: {store: line.api.store, status: line.api.status},
        control: {
            async book(...args: Parameters<Writer['commands']['book']>) { return commands().book(...args) },
            async cancel(...args: Parameters<Writer['commands']['cancel']>) { return commands().cancel(...args) },
        },
        ready: line.api.ready,
        close,
    }
}

export type RentalClient = ReturnType<typeof createRentalClient>
