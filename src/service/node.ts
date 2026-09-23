import {createStoreNode, type StoreNodeDeps, type StoreNodePrincipal} from '../Common/Observe/store-node'
import type {Store} from '../Common/Observe/store'
import {createServiceAccess, type ServiceAccess} from './access'
import {SYSTEM_ACCOUNT, type tServiceDefinition} from './definition'

// ============================================================
// definition-driven node wiring (self-check boots this in-process)
// ============================================================

export type ServiceNodeDeps<S extends Record<string, any>> = {
    definition: tServiceDefinition<S>
    nodeId: string
    /** Token -> principal; a throw rejects. The entrypoint owns codec and secret. */
    verifyToken: (presented: unknown) => StoreNodePrincipal
    /** The resolved leader link; the entrypoint owns the transport under it. */
    upstream: StoreNodeDeps<S>['upstream']
    /** The entrypoint's socket-server hook; the factory serves every connection. */
    serve: Pick<StoreNodeDeps<S>['serve'], 'onConnection'>
    selfUrl: () => string
    /** The entrypoint owns the actual shutdown; called ONCE, after the grace. */
    onLeave: (reason: string) => void
    heartbeatMs?: number
    graceMs?: number
    log?: (line: string) => void
}

export function createServiceNode<S extends Record<string, any>>(deps: ServiceNodeDeps<S>) {
    const {definition} = deps
    // the read policy runs on THIS node's mirror: the audience hooks hand the
    // local store over, and the same definition-driven shaper the leader uses
    // decides what every connection is served (see ./access.ts)
    let access: ServiceAccess<tServiceDefinition<S>> | null = null
    function accessOf(store: Store<S>) {
        return access ??= createServiceAccess<tServiceDefinition<S>>({definition, store})
    }
    const node = createStoreNode<S>({
        line: {
            nodeId: deps.nodeId,
            storeId: definition.storeId,
            originId: definition.originId,
            lineId: definition.name + '-' + deps.nodeId + '-line',
        },
        roster: {
            url: deps.selfUrl,
            ...(deps.heartbeatMs != undefined ? {heartbeatMs: deps.heartbeatMs} : {}),
            ...(deps.graceMs != undefined ? {graceMs: deps.graceMs} : {}),
        },
        auth: {verify: deps.verifyToken},
        commands: Object.keys(definition.commands),
        upstream: deps.upstream,
        serve: {
            onConnection: deps.serve.onConnection,
            // the service's wire identity: every surface is served under the definition name
            wrap: (fragment: Record<string, unknown>) => ({[definition.name]: fragment}),
            audience: {
                // a definition WITH views serves its public projections and never the raw line
                reader(defaults) {
                    const views = accessOf(defaults.store).publicViews()
                    return views ? {views} : {replica: defaults.replica, node: defaults.node}
                },
                principal(who, defaults, session) {
                    return accessOf(defaults.store).principal(who, defaults, session)
                },
            },
        },
        onLeave: deps.onLeave,
        ...(deps.log ? {log: deps.log} : {}),
    })
    return {
        ...node,
        close() {
            access?.close()
            node.close()
        },
    }
}
