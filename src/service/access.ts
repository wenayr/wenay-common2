// =====================================================================
// access — the read policy and the role facade of a service, for BOTH corners
// =====================================================================
// Shared service runtime. One function of the definition decides what every
// connection is served, on the leader and on every node alike:
//   - views with allow 'public' are derived ONCE per process from the local
//     mirror and served ungated (the raw line is NOT — a browser never sees
//     what the projection drops);
//   - role views are guarded per session (`shared` means identical content)
//     and served inside the gated facade of a principal whose roles match;
//   - commands are PRUNED by role (RPC-AUTH rule 3: a member that is absent,
//     not one that checks) — and the authority refuses the role again at
//     execution (leader.ts), because a relay asserts nothing.
// The store arrives from the serving corner (the authority's own store or
// the node's replica): this file owns no transport and no crypto. The wire
// types of what is served derive from the definition (leader.ts shape facts).

import {deriveStore, type DerivedStore} from '../Common/Observe/store-derive'
import {exposeStoreReplay, type StoreReplayRemote} from '../Common/Observe/store-replay'
import type {Store} from '../Common/Observe/store'
import type {StoreNodePrincipal, StoreNodeSession} from '../Common/Observe/store-node'
import type {
    tDefinitionState, tPrincipalFacade, tPrincipalViewLines, tPublicViewLines, tServiceCommand, tServiceDefinition,
    tServicePrincipal, tServiceView,
} from './definition'

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
    function rolesOf(account: string, state = store.snapshot()): readonly string[] {
        return definition.access?.rolesOf?.(state, account) ?? []
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
            ...(definition.resources ? {resources: principal ? Object.keys(definition.resources).filter(name => allowed(definition.resources![name].allow, roles)) : []} : {}),
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
    // Only public lines may be shared across sessions without an access boundary.
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
    // ============== session resources: live rights and guarded role projections ==============
    const sessions = new Map<StoreNodeSession, ReturnType<typeof openSession>>()
    function openSession(who: StoreNodePrincipal, session: StoreNodeSession) {
        let active = true
        let claims = who
        const owned = new Map<string, Line>()
        function currentPrincipal() { return principalOf(claims) }
        function requireLive() {
            if (!active || (claims.expiresAt != undefined && Date.now() >= claims.expiresAt)) throw new Error('session is closed or expired')
        }
        function requireView(name: string) {
            requireLive()
            if (!allowed(views[name].allow, currentPrincipal().roles)) throw new Error('forbidden: view ' + name)
        }
        const permissions = deriveStore(store, function projectPermissions(state) {
            const me = {account: claims.account, roles: rolesOf(claims.account, state)}
            return {...me, ...rights(me)}
        })
        const exposed = exposeStoreReplay(permissions.store, {chunks: false})
        function roleLine(name: string) {
            let line = owned.get(name)
            if (line) return line.api
            const view = views[name]
            // Role dependencies may live outside view.keys; every source batch must recheck them.
            const derived = deriveStore(store, function projectAuthorized(state: S) {
                const me = {account: claims.account, roles: rolesOf(claims.account, state)}
                if (!active || (claims.expiresAt != undefined && Date.now() >= claims.expiresAt) || !allowed(view.allow, me.roles)) return {}
                return view.project(state, view.shared ? null : me)
            })
            const resource = exposeStoreReplay(derived.store, {chunks: false})
            const remote = resource.api.replay
            // Guard catch-up as well: an old journal must not reveal earlier private values.
            const api = {
                line: remote.line,
                since: function since(seq: number) { requireView(name); return remote.since(seq) },
                keyframe: function keyframe() { requireView(name); return remote.keyframe() },
            } satisfies StoreReplayRemote
            line = {derived, exposed: resource, api}
            owned.set(name, line)
            return api
        }
        const offGone = session.onGone(closeSession)
        function closeSession() {
            if (!active) return
            active = false
            offGone()
            for (const line of owned.values()) closeLine(line)
            owned.clear()
            exposed.close()
            permissions.close()
            sessions.delete(session)
        }
        return {
            currentPrincipal, requireLive, roleLine, permissions: exposed.api.replay,
            update(next: StoreNodePrincipal) { claims = next },
            close: closeSession,
        }
    }
    function sessionOf(who: StoreNodePrincipal, session: StoreNodeSession) {
        let current = sessions.get(session)
        if (current && current.currentPrincipal().account != who.account) { current.close(); current = undefined }
        if (!current) { current = openSession(who, session); sessions.set(session, current) }
        current.update(who)
        return current
    }
    function viewsFor(principal: tServicePrincipal, session: ReturnType<typeof openSession>): tPrincipalViewLines<D> {
        const fragment: Record<string, StoreReplayRemote> = {}
        for (const name of rights(principal).views) {
            const view = views[name]
            fragment[name] = view.allow == 'public' ? sharedLine(name).api : session.roleLine(name)
        }
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
    function commandsFor<C extends Record<string, unknown>>(session: ReturnType<typeof openSession>, served: C): C {
        const pruned: Record<string, unknown> = {}
        const mine = new Set(rights(session.currentPrincipal()).commands)
        for (const name of commandNames) {
            const command = served[name]
            pruned[name] = mine.has(name) && typeof command == 'function' ? function guardedCommand(...args: unknown[]) {
                session.requireLive()
                if (!rights(session.currentPrincipal()).commands.includes(name)) throw new Error('forbidden: command ' + name)
                return command(...args)
            } : null
        }
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
        const resource = sessionOf(who, session)
        const me = resource.currentPrincipal()
        return {
            whoami: defaults.whoami,
            me: function currentPermissions() {
                resource.requireLive()
                const principal = resource.currentPrincipal()
                return {...principal, ...rights(principal)}
            },
            permissions: resource.permissions,
            commands: commandsFor(resource, defaults.commands ?? ({} as C)),
            ...(defaults.revoke ? {revoke: defaults.revoke} : {}),
            ...(viewNames.length ? {views: viewsFor(me, resource)} : {}),
        } as unknown as tPrincipalFacade<D, C, R>
    }

    function close() {
        for (const session of sessions.values()) session.close()
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
