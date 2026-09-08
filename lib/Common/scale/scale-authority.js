"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthority = createAuthority;
const rpc_session_registry_1 = require("../rcp/rpc-session-registry");
const Listen_1 = require("../events/Listen");
const command_host_1 = require("../command/command-host");
const command_fragment_1 = require("../command/command-fragment");
const command_receipts_1 = require("../command/command-receipts");
const command_token_1 = require("../command/command-token");
const node_directory_1 = require("../Observe/node-directory");
const store_durable_1 = require("../Observe/store-durable");
const store_replica_set_1 = require("../Observe/store-replica-set");
const scale_control_1 = require("./scale-control");
function finiteCount(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
}
function createAuthority(deps) {
    const log = deps.log ?? console.log;
    const nodeId = deps.line.nodeId ?? 'authority';
    const weight = deps.roster.weight ?? 1;
    const heartbeatMs = deps.roster.heartbeatMs ?? 3000;
    const staleMs = deps.roster.staleMs;
    const renewBeforeMs = deps.identity.renewBeforeMs ?? 15_000;
    const acceptNode = deps.roster.acceptNode ?? function acceptAnyNode() { return true; };
    const identity = deps.identity;
    const leadership = deps.leadership ?? {};
    const bornLeader = (leadership.role ?? 'leader') == 'leader';
    let closed = false;
    let followedOnce = bornLeader;
    let forcePromote = false;
    const durable = deps.line.durable ? (0, store_durable_1.openDurableStore)({ ...deps.line.durable, initial: deps.line.initial }) : null;
    const replica = (0, store_replica_set_1.createStoreReplicaSet)({
        storeId: deps.line.storeId, originId: deps.line.originId, nodeId,
        lineId: deps.line.lineId ?? nodeId + '-line',
        ...(durable ? { store: durable.store, expose: durable.expose } : { initial: deps.line.initial }),
        leadership: {
            initialRole: bornLeader ? 'leader' : 'follower',
            epoch: leadership.epoch ?? (bornLeader ? 1 : 0),
            eligible: true,
            ...(leadership.autoPromoteMs != undefined ? { autoPromoteMs: leadership.autoPromoteMs } : {}),
            ...(leadership.accept ? { accept: leadership.accept } : {}),
            async elect(ctx) {
                if (!followedOnce && !forcePromote)
                    return null;
                return leadership.elect ? leadership.elect(ctx) : { epoch: ctx.maxEpoch + 1 };
            },
        },
    });
    const archive = durable ? durable.attach(replica.api) : null;
    function leading() {
        return !closed && replica.control.canWrite();
    }
    function requireLeading(verb) {
        if (!leading()) {
            throw new Error(`authority ${nodeId} is standby: ${verb} refused — the leader is ${replica.api.status.state.leaderId ?? 'unknown'}`);
        }
    }
    const controlDurable = deps.control?.durable && bornLeader
        ? (0, store_durable_1.openDurableStore)({ ...deps.control.durable, initial: (0, scale_control_1.emptyControlState)() })
        : null;
    if (controlDurable)
        controlDurable.store.state.nodes = {};
    let controlArchive = null;
    const control = (0, scale_control_1.createControlLine)({
        initial: (0, scale_control_1.emptyControlState)(),
        own: bornLeader,
        describe: { scaleControl: { version: 1, authority: nodeId } },
        label: `authority ${nodeId} control line`,
        log,
        ...(controlDurable ? {
            store: controlDurable.store,
            expose: controlDurable.expose,
            onOwned(exposed) { controlArchive = controlDurable.attach(exposed); },
        } : {}),
    });
    let roster = null;
    let rosterLine = null;
    function buildOwnerFacets() {
        const store = control.store();
        roster = (0, node_directory_1.createNodeDirectory)({ store, ...(staleMs != undefined ? { staleMs } : {}) });
        rosterLine = (0, scale_control_1.projectStoreSection)(store, 'nodes', { nodeDirectory: { version: 2, authority: nodeId } });
        return roster;
    }
    function dropOwnerFacets() {
        roster?.close();
        roster = null;
        rosterLine?.close();
        rosterLine = null;
    }
    function requireRoster(verb) {
        requireLeading(verb);
        if (!roster)
            throw new Error(`authority ${nodeId} is standby: ${verb} refused — it owns no roster`);
        return roster;
    }
    if (bornLeader)
        buildOwnerFacets();
    const corridorDeps = deps.corridor ?? {};
    const commandHost = (0, command_host_1.createCommandHost)({
        commands: corridorDeps.commands ?? {},
        ...(corridorDeps.limits ? { limits: corridorDeps.limits } : {}),
        receipts: {
            ...corridorDeps.receipts,
            ...(bornLeader ? { line: (0, command_receipts_1.createCommandReceipts)({ store: control.store() }).control } : {}),
        },
    });
    async function execute(account, command, requestId, input) {
        requireLeading('command ' + command);
        return commandHost.execute(account, command, requestId, input);
    }
    const corridorHost = { execute, names: commandHost.names };
    function fragment(account) {
        return (0, command_fragment_1.bindCommandNames)(commandHost.names, function bindAuthorityCommand(name) {
            return function authorityCommand(requestId, input) {
                return execute(account, name, requestId, input);
            };
        });
    }
    function isRevoked(account) {
        return control.store().state.revoked[account] != undefined;
    }
    function requireLiveClaims(presented) {
        const principal = identity.verify(presented);
        if (isRevoked(principal.account)) {
            throw Object.assign(new Error('account revoked at the authority'), { revoke: true });
        }
        return principal;
    }
    function mint(account) {
        const token = identity.issue(account);
        const principal = identity.verify(token);
        return {
            token, account,
            ...(principal.expiresAt != undefined ? { expiresAt: principal.expiresAt } : {}),
        };
    }
    function login(account) {
        requireLeading('login');
        const revoked = control.store().state.revoked;
        if (revoked[account])
            delete revoked[account];
        return mint(account);
    }
    function renew(presented) {
        return mint(requireLiveClaims(presented).account);
    }
    const sessions = (0, rpc_session_registry_1.createSessionRegistry)();
    function revokeAccount(account) {
        requireLeading('revoke');
        control.store().state.revoked[account] = { account, ts: Date.now() };
        const cut = sessions.cut(account, 'account revoked at the authority');
        log(`scale authority ${nodeId}: revoked ${account} — ${cut} live sessions cut, nodes follow the replicated fact`);
        return { revoked: true, account, sessionsCut: cut };
    }
    const verified = (0, command_token_1.verifyCommands)({
        host: corridorHost,
        accountOf(presented) { return requireLiveClaims(presented).account; },
    });
    function readers() {
        return replica.api.fragment.replay.line.count();
    }
    let upstreamLink = null;
    let offUpstreamFail = null;
    async function attachUpstream(link) {
        if (closed)
            return;
        upstreamLink = link;
        offUpstreamFail?.();
        offUpstreamFail = link.onFail.on(function upstreamLinkFailed() {
        });
        if (leading())
            return;
        await control.follow(link.control);
        if (closed || upstreamLink != link)
            return;
        followedOnce = true;
        if (started && !leading())
            await announceStandby(link);
    }
    async function announceStandby(link) {
        try {
            await link.register({
                nodeId, url: deps.roster.url(), weight: 0, role: 'standby',
                ...(typeof globalThis.process?.pid == 'number' ? { pid: globalThis.process.pid } : {}),
            });
        }
        catch (error) {
            log(`scale authority ${nodeId}: standby registration failed — ${String(error?.message ?? error)}`);
        }
    }
    if (leadership.upstream) {
        const resolveUpstream = leadership.upstream;
        replica.control.addOffer({
            id: 'to-authority',
            connect: async function connectAuthorityUpstream() {
                const fresh = await resolveUpstream();
                if (fresh != upstreamLink)
                    await attachUpstream(fresh);
                return {
                    remote: fresh.replica,
                    onFail: { on: (cb) => fresh.onFail.on(cb) },
                    close() { },
                };
            },
        });
    }
    const [emitRole, roleChanges] = (0, Listen_1.listen)();
    let announcedRole = null;
    function becomeLeader() {
        control.promote();
        const owned = buildOwnerFacets();
        commandHost.adopt((0, command_receipts_1.createCommandReceipts)({ store: control.store() }).control);
        owned.control.grace();
        for (const view of (0, node_directory_1.nodeDirectoryViews)(owned.control.snapshot())) {
            if (view.nodeId == nodeId || view.role == 'leader')
                owned.control.remove(view.nodeId);
        }
        if (started)
            publishOwnRow();
        log(`scale authority ${nodeId}: LEADER (epoch ${replica.api.status.state.epoch})`);
    }
    function becomeStandby() {
        dropOwnerFacets();
        control.demote();
        commandHost.adopt(null);
        log(`scale authority ${nodeId}: STANDBY — leader is ${replica.api.status.state.leaderId ?? 'unknown'}`);
        if (upstreamLink) {
            void attachUpstream(upstreamLink).catch(function standbyAttachFailed(error) {
                log(`scale authority ${nodeId}: standby follow failed — ${String(error?.message ?? error)}`);
            });
        }
    }
    function syncRole() {
        const next = leading() ? 'leader' : 'standby';
        if (next == announcedRole)
            return;
        const first = announcedRole == null;
        announcedRole = next;
        if (next == 'leader' && (!first || !bornLeader))
            becomeLeader();
        if (next == 'standby' && !first)
            becomeStandby();
        emitRole(next, { leaderId: replica.api.status.state.leaderId, epoch: replica.api.status.state.epoch });
    }
    syncRole();
    const offRole = replica.api.status.node.at('role').on(function replicaRoleChanged() { syncRole(); });
    let started = false;
    let beat = null;
    function authorityMeta() {
        return { readers: readers(), ...deps.roster.meta?.() };
    }
    function publishOwnRow() {
        requireRoster('own row').control.set({ nodeId, url: deps.roster.url(), role: 'leader', weight, meta: authorityMeta() });
    }
    function start() {
        if (closed || started)
            return;
        started = true;
        if (leading())
            publishOwnRow();
        else if (upstreamLink)
            void announceStandby(upstreamLink);
        beat = setInterval(function authorityHeartbeat() {
            if (leading())
                roster?.control.heartbeat(nodeId, { meta: authorityMeta() });
            else
                void Promise.resolve().then(function standbyBeat() { return upstreamLink?.heartbeat(nodeId, {}); }).catch(function standbyBeatLost() { });
        }, heartbeatMs);
        beat.unref?.();
    }
    function identityFor(account) {
        return {
            login: function loginBoundAccount() { return login(account); },
            renew,
        };
    }
    function browser(account) {
        if (!rosterLine)
            throw new Error(`authority ${nodeId} is standby: serve browser refused — serve reader() there`);
        return {
            replica: replica.api.fragment,
            roster: rosterLine.api,
            identity: identityFor(account),
        };
    }
    function reader() {
        return { replica: replica.api.fragment, node: () => nodeId };
    }
    function nodeLink(linkNodeId) {
        const owned = requireRoster('serve node link');
        const controlApi = control.api('serve node link');
        function requireNodeRow(raw, verb) {
            requireLeading('node link ' + verb);
            if (owned != roster)
                throw new Error('node link expired: authority ownership changed');
            const id = String(raw ?? '');
            if (!id)
                throw new Error('node link ' + verb + ' needs a nodeId');
            if (id == nodeId)
                throw new Error('node link refused: ' + id + ' is the authority row');
            if (linkNodeId != undefined && id != linkNodeId) {
                throw new Error('node link bound to ' + linkNodeId + ' refused row ' + id);
            }
            return id;
        }
        return {
            replica: replica.api.fragment,
            control: controlApi,
            commandsByToken: verified.fragment(),
            register(entry) {
                const id = requireNodeRow(entry?.nodeId, 'register');
                if (!acceptNode(id))
                    throw new Error('node link refused: ' + id);
                const url = String(entry?.url ?? '');
                const role = entry?.role == 'standby' ? 'standby' : 'mirror';
                const nodeWeight = role == 'standby' ? 0 : Number(entry?.weight ?? 4);
                const pid = finiteCount(entry?.pid);
                const meta = {
                    ...owned.control.get(id)?.meta,
                    ...(pid ? { pid } : {}),
                    ...(entry?.readers != undefined ? { readers: finiteCount(entry.readers) } : {}),
                };
                owned.control.set({
                    nodeId: id, url, role, weight: Number.isFinite(nodeWeight) ? nodeWeight : 4,
                    ...(Object.keys(meta).length ? { meta } : {}),
                });
                log(`scale authority ${nodeId}: ${role} ${id} registered at ${url}`);
                return { ok: true };
            },
            heartbeat(id, facts) {
                const key = requireNodeRow(id, 'heartbeat');
                const meta = facts?.readers != undefined ? { readers: finiteCount(facts.readers) } : {};
                return { ok: owned.control.heartbeat(key, { meta }) };
            },
            goodbye(id) {
                owned.control.remove(requireNodeRow(id, 'goodbye'));
                return { ok: true };
            },
        };
    }
    function connectionWith(shaper) {
        let serverControl = null;
        let bound = null;
        const [gone, goneListen] = (0, Listen_1.listen)();
        const session = { nodeId, onGone: (cb) => goneListen.on(cb) };
        function rebind(account) {
            if (!serverControl || bound?.account == account)
                return;
            if (bound)
                sessions.untrack(bound.account, bound.control);
            bound = { account, control: serverControl };
            sessions.track(account, serverControl);
        }
        function principalFor(principal) {
            const defaults = {
                whoami: () => principal.account + ' @ ' + nodeId,
                commands: fragment(principal.account),
                revoke: () => revokeAccount(principal.account),
                store: replica.control.store,
            };
            if (!shaper) {
                const { store: _store, ...served } = defaults;
                return served;
            }
            return shaper(principal, defaults, session);
        }
        function resolveAuth(presented) {
            const principal = requireLiveClaims(presented);
            rebind(principal.account);
            return {
                object: principalFor(principal),
                ack: { ok: true, who: principal.account, node: nodeId },
                ...(principal.expiresAt != undefined ? { expiresAt: principal.expiresAt } : {}),
                renewBeforeMs,
            };
        }
        return {
            object: {},
            auth: { gate: true, resolveAuth },
            attach(attached) { serverControl = attached; },
            close() {
                if (bound)
                    sessions.untrack(bound.account, bound.control);
                bound = null;
                serverControl = null;
                gone();
                goneListen.close();
            },
        };
    }
    function connection(shape = {}) {
        return connectionWith(shape.principal ?? null);
    }
    async function promote(reason = 'manual') {
        forcePromote = true;
        try {
            const elected = await replica.control.promote(reason);
            syncRole();
            return elected;
        }
        finally {
            forcePromote = false;
        }
    }
    function close() {
        if (closed)
            return;
        closed = true;
        if (beat)
            clearInterval(beat);
        offRole();
        offUpstreamFail?.();
        commandHost.close();
        dropOwnerFacets();
        controlArchive?.close();
        control.close();
        archive?.close();
        replica.close();
        roleChanges.close();
    }
    const rosterControl = {
        set: (row) => requireRoster('set').control.set(row),
        patch: (id, partial) => requireRoster('patch').control.patch(id, partial),
        heartbeat: (id, partial) => requireRoster('heartbeat').control.heartbeat(id, partial),
        drain: (id) => requireRoster('drain').control.drain(id),
        undrain: (id, w) => requireRoster('undrain').control.undrain(id, w),
        remove: (id) => requireRoster('remove').control.remove(id),
        get: (id) => control.store().state.nodes[id],
        snapshot: () => control.store().snapshot().nodes,
    };
    return {
        line: { control: replica.control, api: replica.api },
        roster: {
            control: rosterControl,
            get api() {
                if (!rosterLine)
                    throw new Error(`authority ${nodeId} is standby: serve roster refused`);
                return rosterLine.api;
            },
        },
        identity: {
            login, renew, revoke: revokeAccount, mint,
            principal: requireLiveClaims,
        },
        corridor: {
            execute,
            names: commandHost.names,
            fragment,
            byToken: verified.fragment,
        },
        serve: { browser, reader, nodeLink, connection },
        control: { promote },
        events: { role: roleChanges },
        view: {
            role: () => (leading() ? 'leader' : 'standby'),
            leaderId: () => replica.api.status.state.leaderId,
            epoch: () => replica.api.status.state.epoch,
            nodes: () => (0, node_directory_1.nodeDirectoryViews)(control.store().snapshot().nodes),
            readers,
            isRevoked,
            restored: () => durable || controlDurable
                ? { seq: durable?.restored.seq ?? 0, fromArchive: durable?.restored.fromArchive ?? false, ...(controlDurable ? { control: controlDurable.restored } : {}) }
                : null,
            archive: () => archive?.stats() ?? null,
        },
        start,
        close,
    };
}
