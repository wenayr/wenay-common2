import {io} from 'socket.io-client'
import {createRpcClientHub} from '../Common/rcp/rpc-clientHub'
import type {RpcClientReturn} from '../Common/rcp/rpc-client'
import type {DeepSocketListenSmart} from '../Common/rcp/listen-deep'
import {createStore} from '../Common/Observe/store'
import type {tServiceDefinition} from './definition'
import type {ServiceClientDefinition} from './descriptor'
import type {ServiceResourceDefinition, ServiceResourceFacts, ServiceResourceOptions, ServiceResourceStatus} from './resource-definition'
import {resourceBudgets, resourceError, resourceWithin} from './resource-budget'

type tResources<D> = D extends {resources: infer R extends Record<string, ServiceResourceDefinition>} ? R : {}
type tFacade<R> = R extends {open: (...args: any[]) => infer T} ? Awaited<T> extends {facade: infer F extends object} ? F : never : never
type tRemote<F extends object> = RpcClientReturn<DeepSocketListenSmart<F>>['func']

// A controller owns one authority connection. Opens and tabs never share a lifetime.
function createResourceController<F extends object>(deps: {
    name: string, supported: boolean, url: string, options?: ServiceResourceOptions
    token: (renew: boolean) => Promise<string | null>
    tokens: (callback: (token: string) => void) => () => void
    released: () => void
}) {
    const budgets = resourceBudgets(deps.options)
    const status = createStore<ServiceResourceStatus>({phase: 'opening', generation: 0, error: null})
    const lifetime = new AbortController()
    let current: {generation: number, remote: tRemote<F>} | null = null
    let closing: Promise<void> | undefined
    let account: string | null = null
    let epoch = 0
    let revision = -1
    let id: string | null = null
    let api: any = null
    let stopEvents: (() => void) | undefined
    let usable = false
    let applyingToken: string | null = null
    function set(phase: ServiceResourceStatus['phase'], code?: string) {
        current = phase == 'ready' ? current : null
        const error = code ? resourceError(code) : null
        status.replace({phase, generation: status.state.generation, error: error ? {code: error.code!, message: error.message} : null})
    }
    const hub = createRpcClientHub(
        () => io(deps.url, {transports: ['websocket'], forceNew: true}),
        rpc => ({resources: rpc<any>('resources')}),
        {token: async function tokenForResource(request) {
            const token = await deps.token(request.reason != 'connect')
            if (lifetime.signal.aborted) throw resourceError('E_RESOURCE_CLOSED')
            applyingToken = token
            return token
        }},
    )
    const stopToken = deps.tokens(function tokenChanged(token) {
        if (!api || token == applyingToken || lifetime.signal.aborted) return
        applyingToken = token
        void hub.reauth(token).then(async function refreshed() {
            if (lifetime.signal.aborted) return
            if (!usable) { await connected(); return }
            const facts = await api?.control.state()
            if (facts && !lifetime.signal.aborted) accept(facts)
        }).catch(function refused() { if (!lifetime.signal.aborted) set('denied', 'E_RESOURCE_DENIED') })
    })
    function forget() {
        ++epoch
        usable = false
        stopEvents?.()
        stopEvents = undefined
        api = null
        id = null
        current = null
        revision = -1
    }
    function accept(facts: ServiceResourceFacts) {
        if (lifetime.signal.aborted || !usable || facts.revision <= revision) return
        revision = facts.revision
        if (account && facts.account && account != facts.account) { void close().catch(function observed() {}); return }
        if (facts.account) account = facts.account
        const run = ++epoch
        current = null
        id = null
        if (status.state.phase == 'failed') return
        if (!facts.allowed.includes(deps.name)) { set('denied', 'E_RESOURCE_DENIED'); return }
        status.replace({phase: 'opening', generation: status.state.generation + 1, error: null})
        const remote = api
        void open(remote, run)
    }
    async function open(remote: any, run: number) {
        let allocated: string | null = null
        try {
            const result = await resourceWithin(remote.control.open(deps.name), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal) as {id: string}
            allocated = result.id
            if (run != epoch || lifetime.signal.aborted) return
            id = allocated
            await resourceWithin(remote.control.ready(allocated), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal)
            if (run != epoch || lifetime.signal.aborted) return
            current = {generation: status.state.generation, remote: remote.instances[allocated]}
            set('ready')
        } catch (error: any) {
            if (run == epoch && !lifetime.signal.aborted) {
                set(error?.code == 'E_RESOURCE_DENIED' ? 'denied' : 'failed', error?.code == 'E_RESOURCE_TIMEOUT' ? 'E_RESOURCE_TIMEOUT' : 'E_RESOURCE_OPEN')
                // A delayed open reply may carry an id we never learned. Its transport owns it.
                if (status.state.phase == 'failed') hub.close()
            }
        } finally {
            if (allocated && (run != epoch || lifetime.signal.aborted || status.state.phase != 'ready')) {
                void resourceWithin(Promise.resolve(remote.control.close(allocated)), budgets.close, 'E_RESOURCE_CLEANUP').catch(function observed() {})
            }
        }
    }
    async function connected() {
        if (lifetime.signal.aborted) return
        forget()
        const run = epoch
        if (status.state.phase != 'failed') set('opening')
        try {
            const clients = await resourceWithin(hub.promise, budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal)
            await resourceWithin(clients.resources.readyStrict(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal)
            const ack = await resourceWithin(clients.resources.auth(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal) as any
            if (run != epoch || lifetime.signal.aborted) return
            api = clients.resources.func
            if (ack?.ok != true) { set('denied', 'E_RESOURCE_DENIED'); return }
            usable = true
            stopEvents = api.events.on(accept)
            const facts = await resourceWithin(api.control.state(), budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal)
            if (run == epoch && !lifetime.signal.aborted) accept(facts as ServiceResourceFacts)
        } catch {
            if (run == epoch && !lifetime.signal.aborted && status.state.phase != 'failed') set('offline', 'E_RESOURCE_TIMEOUT')
        }
    }
    hub.connectListen(function reconnected() { void connected() })
    hub.disconnectListen(function disconnected() {
        if (lifetime.signal.aborted) return
        const failed = status.state.phase == 'failed'
        forget()
        if (!failed) set('offline')
    })
    hub.authListen(function authChanged(event) {
        if (lifetime.signal.aborted) return
        if (event.state == 'revoked' || event.state == 'expired') {
            ++epoch
            id = null
            usable = false
            stopEvents?.()
            stopEvents = undefined
            set('denied', 'E_RESOURCE_DENIED')
        }
        if (event.state == 'renewed') {
            if (api && usable) void api.control.state().then(accept).catch(function observed() {})
            else void connected()
        }
    })
    // Observe a provider/initial connection failure even if no connect notification arrives.
    void resourceWithin(hub.promise, budgets.open, 'E_RESOURCE_TIMEOUT', lifetime.signal).catch(function unavailable() {
        if (!lifetime.signal.aborted && !usable && status.state.phase != 'failed') set('offline', 'E_RESOURCE_TIMEOUT')
    })
    function close() {
        if (closing) return closing
        const ownedApi = api, ownedId = id
        let resolve!: () => void, reject!: (error: unknown) => void
        closing = new Promise<void>(function completion(ok, fail) { resolve = ok; reject = fail })
        lifetime.abort()
        forget()
        set('closed')
        stopToken()
        deps.released()
        const work = ownedApi && ownedId ? Promise.resolve().then(function release() { return ownedApi.control.close(ownedId) }) : Promise.resolve()
        // An opening without a known id is cancelled by closing its owned transport now.
        if (!ownedId) hub.close()
        void resourceWithin(work, budgets.close, 'E_RESOURCE_CLEANUP').then(resolve, function failed() {
            set('closed', 'E_RESOURCE_CLEANUP')
            reject(resourceError('E_RESOURCE_CLEANUP'))
        }).finally(function disconnected() { hub.close() })
        void closing.catch(function observed() {})
        return closing
    }
    if (!deps.supported) { set('failed', 'E_RESOURCE_UNSUPPORTED'); hub.close() }
    return {status, current: () => current, close}
}
export type ServiceResourceController<F extends object> = ReturnType<typeof createResourceController<F>>

export function createServiceResources<D extends tServiceDefinition<any, any>>(deps: {
    definition: D | ServiceClientDefinition<D>, url: string, options?: ServiceResourceOptions
    token: (renew: boolean) => Promise<string | null>
    tokens: (callback: (token: string) => void) => () => void
}) {
    resourceBudgets(deps.options)
    const owned = new Set<{close: () => Promise<void>}>()
    let closed = false
    function open<K extends keyof tResources<D> & string>(name: K) {
        if (closed) throw resourceError('E_RESOURCE_CLOSED')
        const controller = createResourceController<tFacade<tResources<D>[K]>>({...deps, name,
            supported: Object.hasOwn(deps.definition.resources ?? {}, name),
            released() { owned.delete(controller) },
        })
        owned.add(controller)
        return controller
    }
    function close() {
        closed = true
        for (const controller of [...owned]) void controller.close().catch(function observed() {})
    }
    return {resource: {open}, close}
}
