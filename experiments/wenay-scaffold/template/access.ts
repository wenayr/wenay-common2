// =====================================================================
// access — the read policy and the role facade of a service, for BOTH corners
// =====================================================================
// TEMPLATE-OWNED. One function of the definition decides what every
// connection is served, on the leader and on every node alike:
//   - views with allow 'public' are derived ONCE per process from the local
//     mirror and served ungated (the raw line is NOT — a browser never sees
//     what the projection drops);
//   - role views are derived per session (or once per process with `shared`)
//     and served inside the gated facade of a principal whose roles match;
//   - commands are PRUNED by role (RPC-AUTH rule 3: a member that is absent,
//     not one that checks) — and the authority refuses the role again at
//     execution (leader.ts), because a relay asserts nothing.
// The store arrives from the serving corner (the authority's own store or
// the node's replica): this file owns no transport and no crypto. The wire
// types of what is served derive from the definition (leader.ts shape facts).

import {deriveStore, type DerivedStore} from '../../../src/Common/Observe/store-derive'
import {exposeStoreReplay, type StoreReplayRemote} from '../../../src/Common/Observe/store-replay'
import type {Store} from '../../../src/Common/Observe/store'
import type {StoreNodePrincipal, StoreNodeSession} from '../../../src/Common/Observe/store-node'
import type {
    tDefinitionState, tPrincipalFacade, tPrincipalViewLines, tPublicViewLines, tServiceCommand, tServiceDefinition,
    tServicePrincipal, tServiceView,
} from './leader'

export type ServiceAccessDeps<D extends tServiceDefinition<any, any>> = {
    definition: D
    /** The local mirror of the line: the authority's own store, or the node's replica. */
    store: Store<tDefinitionState<D>>
}

type Line = {derived: DerivedStore, exposed: ReturnType<typeof exposeStoreReplay>, api: StoreReplayRemote}

export function createServiceAccess<D extends tServiceDefinition<any, any>>(deps: ServiceAccessDeps<D>) {
    type S = tDefinitionState<D>
    const {store} = deps
    const definition = deps.definition as tServiceDefinition<S, Record<string, tServiceCommand<S>>>
    const views = (definition.views ?? {}) as Record<string, tServiceView<S>>
    const viewNames = Object.keys(views)
    const commandNames = Object.keys(definition.commands)

    // ============== principals and their rights ==============
    function rolesOf(account: string): readonly string[] {
        return definition.access?.rolesOf?.(store.snapshot(), account) ?? []
    }
    function principalOf(who: Pick<StoreNodePrincipal, 'account'>): tServicePrincipal {
        return {account: who.account, roles: rolesOf(who.account)}
    }
    function allowed(allow: 'public' | readonly string[] | undefined, roles: readonly string[]) {
        if (allow == undefined || allow == 'public') return true
        return allow.some(role => roles.includes(role))
    }
    /** The names a principal may read / call — the same rule the facades are pruned with. */
    function rights(principal: tServicePrincipal | null) {
        const roles = principal?.roles ?? []
        return {
            views: viewNames.filter(name => principal ? allowed(views[name].allow, roles) : views[name].allow == 'public'),
            commands: principal ? commandNames.filter(name => allowed(definition.commands[name].allow, roles)) : [],
        }
    }

    // ============== lines: derived from the local mirror, served as replay lines ==============
    function openLine(name: string, principal: tServicePrincipal | null): Line {
        const view = views[name]
        const derived = deriveStore(store, function projectView(state: S) { return view.project(state, principal) }, view.keys ? {keys: view.keys} : {})
        const exposed = exposeStoreReplay(derived.store, {describe: {view: name, ...(principal ? {account: principal.account} : {})}})
        return {derived, exposed, api: exposed.api.replay}
    }
    function closeLine(line: Line) {
        line.exposed.close()
        line.derived.close()
    }
    // public and `shared` role views: one line per process
    const shared = new Map<string, Line>()
    function sharedLine(name: string) {
        let line = shared.get(name)
        if (!line) shared.set(name, line = openLine(name, null))
        return line
    }
    /** The ungated fragment: public view lines, nothing else (no raw line). Null when the definition declares no views. */
    function publicViews(): tPublicViewLines<D> | null {
        if (viewNames.length == 0) return null
        const fragment: Record<string, StoreReplayRemote> = {}
        for (const name of viewNames) if (views[name].allow == 'public') fragment[name] = sharedLine(name).api
        return fragment as tPublicViewLines<D>
    }
    /** The view lines of one principal; per-session lines are released when the session is gone. */
    function viewsFor(principal: tServicePrincipal, session: StoreNodeSession): tPrincipalViewLines<D> {
        const fragment: Record<string, StoreReplayRemote> = {}
        const owned: Line[] = []
        for (const name of rights(principal).views) {
            const view = views[name]
            if (view.allow == 'public' || view.shared) { fragment[name] = sharedLine(name).api; continue }
            const line = openLine(name, principal)
            owned.push(line)
            fragment[name] = line.api
        }
        if (owned.length) session.onGone(function releaseSessionLines() { for (const line of owned) closeLine(line) })
        return fragment as tPrincipalViewLines<D>
    }
    /** Snapshot of one view for a principal (REST, panels): the same projection, no line. */
    function snapshot(name: string, principal: tServicePrincipal | null) {
        const view = views[name]
        if (!view) throw new Error('unknown view: ' + name)
        if (!allowed(view.allow, principal?.roles ?? [])) throw new Error('forbidden: view ' + name)
        return view.project(store.snapshot(), view.allow == 'public' || view.shared ? null : principal)
    }

    // ============== facades ==============
    /** Prune a served command fragment by role: absent members are `null` (rule 3); the TYPE stays the fragment's. */
    function commandsFor<C extends Record<string, unknown>>(principal: tServicePrincipal, served: C): C {
        const pruned: Record<string, unknown> = {}
        const mine = new Set(rights(principal).commands)
        for (const name of commandNames) pruned[name] = mine.has(name) ? served[name] ?? null : null
        return pruned as C
    }
    /**
     * The gated facade of one verified principal, from the corner's defaults
     * ({whoami, commands?, revoke?}): roles come from state, commands are
     * pruned, the allowed view lines ride along. Shape-identical on leader and node.
     */
    function principal<C extends Record<string, unknown>, R extends (() => unknown) | undefined = undefined>(
        who: StoreNodePrincipal,
        defaults: {whoami: () => string, commands?: C, revoke?: R},
        session: StoreNodeSession,
    ): tPrincipalFacade<D, C, R> {
        const me = principalOf(who)
        return {
            whoami: defaults.whoami,
            me: () => me,
            commands: commandsFor(me, defaults.commands ?? ({} as C)),
            ...(defaults.revoke ? {revoke: defaults.revoke} : {}),
            ...(viewNames.length ? {views: viewsFor(me, session)} : {}),
        } as tPrincipalFacade<D, C, R>
    }

    function close() {
        for (const line of shared.values()) closeLine(line)
        shared.clear()
    }

    return {
        principalOf,
        rights,
        publicViews,
        snapshot,
        principal,
        close,
    }
}
export type ServiceAccess<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceAccess<D>>
