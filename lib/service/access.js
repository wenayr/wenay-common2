"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceAccess = createServiceAccess;
const store_derive_1 = require("../Common/Observe/store-derive");
const store_replay_1 = require("../Common/Observe/store-replay");
function createServiceAccess(deps) {
    const { store } = deps;
    const definition = deps.definition;
    const views = (definition.views ?? {});
    const viewNames = Object.keys(views);
    const commandNames = Object.keys(definition.commands);
    function rolesOf(account, state = store.snapshot()) {
        return definition.access?.rolesOf?.(state, account) ?? [];
    }
    function principalOf(who) {
        return { account: who.account, roles: rolesOf(who.account) };
    }
    function allowed(allow, roles) {
        if (allow == undefined || allow == 'public')
            return true;
        return allow.some(role => roles.includes(role));
    }
    function rights(principal) {
        const roles = principal?.roles ?? [];
        return {
            views: viewNames.filter(name => principal ? allowed(views[name].allow, roles) : views[name].allow == 'public'),
            commands: principal ? commandNames.filter(name => allowed(definition.commands[name].allow, roles)) : [],
            ...(definition.resources ? { resources: principal ? Object.keys(definition.resources).filter(name => allowed(definition.resources[name].allow, roles)) : [] } : {}),
        };
    }
    function openLine(name, principal) {
        const view = views[name];
        const derived = (0, store_derive_1.deriveStore)(store, function projectView(state) { return view.project(state, principal); }, view.keys ? { keys: view.keys } : {});
        const exposed = (0, store_replay_1.exposeStoreReplay)(derived.store, { describe: { view: name, ...(principal ? { account: principal.account } : {}) } });
        return { derived, exposed, api: exposed.api.replay };
    }
    function closeLine(line) {
        line.exposed.close();
        line.derived.close();
    }
    const shared = new Map();
    function sharedLine(name) {
        let line = shared.get(name);
        if (!line)
            shared.set(name, line = openLine(name, null));
        return line;
    }
    function publicViews() {
        if (viewNames.length == 0)
            return null;
        const fragment = {};
        for (const name of viewNames)
            if (views[name].allow == 'public')
                fragment[name] = sharedLine(name).api;
        return fragment;
    }
    const sessions = new Map();
    function openSession(who, session) {
        let active = true;
        let claims = who;
        const owned = new Map();
        function currentPrincipal() { return principalOf(claims); }
        function requireLive() {
            if (!active || (claims.expiresAt != undefined && Date.now() >= claims.expiresAt))
                throw new Error('session is closed or expired');
        }
        function requireView(name) {
            requireLive();
            if (!allowed(views[name].allow, currentPrincipal().roles))
                throw new Error('forbidden: view ' + name);
        }
        const permissions = (0, store_derive_1.deriveStore)(store, function projectPermissions(state) {
            const me = { account: claims.account, roles: rolesOf(claims.account, state) };
            return { ...me, ...rights(me) };
        });
        const exposed = (0, store_replay_1.exposeStoreReplay)(permissions.store, { chunks: false });
        function roleLine(name) {
            let line = owned.get(name);
            if (line)
                return line.api;
            const view = views[name];
            const derived = (0, store_derive_1.deriveStore)(store, function projectAuthorized(state) {
                const me = { account: claims.account, roles: rolesOf(claims.account, state) };
                if (!active || (claims.expiresAt != undefined && Date.now() >= claims.expiresAt) || !allowed(view.allow, me.roles))
                    return {};
                return view.project(state, view.shared ? null : me);
            });
            const resource = (0, store_replay_1.exposeStoreReplay)(derived.store, { chunks: false });
            const remote = resource.api.replay;
            const api = {
                line: remote.line,
                since: function since(seq) { requireView(name); return remote.since(seq); },
                keyframe: function keyframe() { requireView(name); return remote.keyframe(); },
            };
            line = { derived, exposed: resource, api };
            owned.set(name, line);
            return api;
        }
        const offGone = session.onGone(closeSession);
        function closeSession() {
            if (!active)
                return;
            active = false;
            offGone();
            for (const line of owned.values())
                closeLine(line);
            owned.clear();
            exposed.close();
            permissions.close();
            sessions.delete(session);
        }
        return {
            currentPrincipal, requireLive, roleLine, permissions: exposed.api.replay,
            update(next) { claims = next; },
            close: closeSession,
        };
    }
    function sessionOf(who, session) {
        let current = sessions.get(session);
        if (current && current.currentPrincipal().account != who.account) {
            current.close();
            current = undefined;
        }
        if (!current) {
            current = openSession(who, session);
            sessions.set(session, current);
        }
        current.update(who);
        return current;
    }
    function viewsFor(principal, session) {
        const fragment = {};
        for (const name of rights(principal).views) {
            const view = views[name];
            fragment[name] = view.allow == 'public' ? sharedLine(name).api : session.roleLine(name);
        }
        return fragment;
    }
    function snapshot(name, principal) {
        const view = views[name];
        if (!view)
            throw new Error('unknown view: ' + name);
        if (!allowed(view.allow, principal?.roles ?? []))
            throw new Error('forbidden: view ' + name);
        return view.project(store.snapshot(), view.allow == 'public' || view.shared ? null : principal);
    }
    function commandsFor(session, served) {
        const pruned = {};
        const mine = new Set(rights(session.currentPrincipal()).commands);
        for (const name of commandNames) {
            const command = served[name];
            pruned[name] = mine.has(name) && typeof command == 'function' ? function guardedCommand(...args) {
                session.requireLive();
                if (!rights(session.currentPrincipal()).commands.includes(name))
                    throw new Error('forbidden: command ' + name);
                return command(...args);
            } : null;
        }
        return pruned;
    }
    function principal(who, defaults, session) {
        const resource = sessionOf(who, session);
        const me = resource.currentPrincipal();
        return {
            whoami: defaults.whoami,
            me: function currentPermissions() {
                resource.requireLive();
                const principal = resource.currentPrincipal();
                return { ...principal, ...rights(principal) };
            },
            permissions: resource.permissions,
            commands: commandsFor(resource, defaults.commands ?? {}),
            ...(defaults.revoke ? { revoke: defaults.revoke } : {}),
            ...(viewNames.length ? { views: viewsFor(me, resource) } : {}),
        };
    }
    function close() {
        for (const session of sessions.values())
            session.close();
        for (const line of shared.values())
            closeLine(line);
        shared.clear();
    }
    return {
        principalOf,
        rights,
        publicViews,
        snapshot,
        principal,
        close,
    };
}
