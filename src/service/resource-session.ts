import {randomUUID} from 'node:crypto'
import {listen} from '../Common/events/Listen'
import {noStrict} from '../Common/rcp/rpc-dynamic'
import {bindRpcScopes, createRpcScope} from '../Common/rcp/rpc-scope'
import type {StoreNodePrincipal} from '../Common/Observe/store-node'
import type {tServicePrincipal} from './definition'
import type {ServiceResourceDefinition, ServiceResourceFacts, ServiceResourceOptions} from './resource-definition'
import {resourceBudgets, resourceError, resourceWithin} from './resource-budget'
import {createRpcDeadline} from '../Common/rcp/rpc-deadline'

export type ServiceResourceDiagnostic = {name: string, resourceId: string, phase: 'open' | 'close', error: unknown}

// One verified authority transport owns these generations; no client-selected identity enters it.
export function createResourceSession(deps: {
    registry: Record<string, ServiceResourceDefinition>
    principalOf: (who: StoreNodePrincipal) => tServicePrincipal
    changes: (callback: () => void) => () => void
    report: (diagnostic: ServiceResourceDiagnostic) => void
    options?: ServiceResourceOptions
}) {
    const budgets = resourceBudgets(deps.options)
    const sessionId = randomUUID()
    const dead = createRpcScope()
    dead.close()
    const instances = noStrict(Object.create(null) as Record<string, object>)
    const entries = new Map<string, ReturnType<typeof createEntry>>()
    const [emit, events] = listen<[ServiceResourceFacts]>()
    let who: StoreNodePrincipal | null = null
    let signature = ''
    let revision = 0
    let terminal = false
    let deadline: ReturnType<typeof createRpcDeadline> | undefined
    let facts: ServiceResourceFacts = {revision, account: null, roles: [], allowed: []}
    let closing: Promise<void> | undefined
    const cleanup = new Set<Promise<void>>()

    function report(name: string, resourceId: string, phase: 'open' | 'close', error: unknown) {
        // An owner's observer must not interrupt invalidation of another resource.
        try { deps.report({name, resourceId, phase, error}) } catch {}
    }
    function track(task: Promise<void>) {
        cleanup.add(task)
        void task.then(function done() { cleanup.delete(task) }, function failed() { cleanup.delete(task) })
        return task
    }
    function invalidate() {
        for (const entry of [...entries.values()]) track(entry.close())
    }
    function publish() {
        facts = {...facts, revision: ++revision}
        emit(facts)
    }
    function refresh() {
        if (terminal) return
        if (who?.expiresAt != undefined && who.expiresAt <= Date.now()) { suspend(); return }
        const principal = who ? deps.principalOf(who) : null
        const roles = [...new Set(principal?.roles ?? [])].sort()
        const next = JSON.stringify([principal?.account ?? null, roles])
        if (next == signature) return
        signature = next
        invalidate()
        facts = {revision, account: principal?.account ?? null, roles,
            allowed: principal ? Object.keys(deps.registry).filter(name => deps.registry[name].allow.some(role => roles.includes(role))) : []}
        publish()
    }
    function suspend() {
        deadline?.cancel()
        who = null
        refresh()
    }
    function update(principal: StoreNodePrincipal) {
        if (terminal) throw resourceError('E_RESOURCE_CLOSED')
        who = {...principal}
        deadline?.cancel()
        if (principal.expiresAt != undefined && principal.expiresAt != Infinity) deadline = createRpcDeadline({at: principal.expiresAt, fire: suspend, unref: true})
        refresh()
        return facade
    }

    function createEntry(name: string) {
        const id = randomUUID()
        const scope = createRpcScope()
        const principal = Object.freeze({account: facts.account!, roles: Object.freeze([...facts.roles])})
        let handle: Awaited<ReturnType<ServiceResourceDefinition['open']>> | undefined
        let disposal: Promise<void> | undefined
        let completion: Promise<void> | undefined
        function dispose() {
            if (!disposal) {
                disposal = resourceWithin(Promise.resolve().then(function release() { return handle!.close() }), budgets.close, 'E_RESOURCE_CLEANUP')
                    .catch(function failed(error) { report(name, id, 'close', error); throw resourceError('E_RESOURCE_CLEANUP') })
                void disposal.catch(function observed() {})
            }
            return disposal
        }
        const factory = Promise.resolve().then(function allocate() {
            scope.check()
            return deps.registry[name].open({principal, sessionId, resourceId: id, signal: scope.signal})
        }).then(function allocated(value) {
            handle = value
            if (!scope.active()) void dispose().catch(function lateCleanupObserved() {})
            return value
        })
        const ready = resourceWithin(factory, budgets.open, 'E_RESOURCE_TIMEOUT', scope.signal).then(function expose(value) {
            refresh()
            scope.check()
            if (!value || typeof value.facade != 'object' || value.facade == null || typeof value.close != 'function') throw new Error('Invalid resource factory result')
            instances[id] = value.facade
        }).catch(function failed(error) {
            const active = scope.active()
            if (active) report(name, id, 'open', error)
            void close().catch(function cleanupObserved() {})
            throw resourceError(active ? error?.code == 'E_RESOURCE_TIMEOUT' ? 'E_RESOURCE_TIMEOUT' : 'E_RESOURCE_OPEN' : 'E_RESOURCE_CLOSED')
        })
        void ready.catch(function openingObserved() {})
        function close() {
            if (completion) return completion
            // Cut admission and delivery synchronously; disposal is separately bounded.
            const errors = scope.close()
            for (const error of errors) report(name, id, 'close', error)
            delete instances[id]
            entries.delete(id)
            completion = resourceWithin(factory.then(function releaseAllocated() { return dispose() }, function nothingReturned() {}), budgets.close, 'E_RESOURCE_CLEANUP')
                .catch(function cleanupFailed(error) {
                    report(name, id, 'close', error)
                    throw resourceError('E_RESOURCE_CLEANUP')
                })
            void completion.catch(function observed() {})
            return track(completion)
        }
        return {id, scope, ready, close}
    }
    function requireEntry(id: string) {
        refresh()
        const entry = entries.get(id)
        if (!entry) throw resourceError('E_RESOURCE_CLOSED')
        entry.scope.check()
        return entry
    }
    function open(name: string) {
        refresh()
        if (terminal || !facts.account) throw resourceError('E_RESOURCE_DENIED')
        if (!Object.hasOwn(deps.registry, name)) throw resourceError('E_RESOURCE_UNSUPPORTED')
        if (!facts.allowed.includes(name)) throw resourceError('E_RESOURCE_DENIED')
        const entry = createEntry(name)
        entries.set(entry.id, entry)
        return {id: entry.id}
    }
    function state() { refresh(); return facts }
    const facade = {
        control: {open, ready(id: string) { return requireEntry(id).ready }, close(id: string) { return entries.get(id)?.close() ?? Promise.resolve() }, state},
        events, instances,
    }
    const stop = deps.changes(refresh)
    function close() {
        if (closing) return closing
        terminal = true
        deadline?.cancel()
        stop()
        invalidate()
        events.close()
        closing = Promise.allSettled([...cleanup]).then(function finished(results) {
            const errors = results.filter(result => result.status == 'rejected').map(result => result.reason)
            if (errors.length) throw new AggregateError(errors, 'Resource session cleanup failed')
        })
        void closing.catch(function observed() {})
        return closing
    }
    const hooks = bindRpcScopes({}, function resolve(path) {
        refresh()
        return path[0] == 'instances' ? entries.get(path[1])?.scope ?? dead : undefined
    })
    return {update, suspend, close, hooks, facade, sessionId}
}
export type ResourceSession = ReturnType<typeof createResourceSession>
