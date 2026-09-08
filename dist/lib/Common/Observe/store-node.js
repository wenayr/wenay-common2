"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreNode = createStoreNode;
const Listen_1 = require("../events/Listen");
const rpc_server_auto_1 = require("../rcp/rpc-server-auto");
const rpc_session_registry_1 = require("../rcp/rpc-session-registry");
const command_token_1 = require("../command/command-token");
const command_fragment_1 = require("../command/command-fragment");
const store_replica_set_1 = require("./store-replica-set");
const store_follower_1 = require("./store-follower");
function createStoreNode(deps) {
    const { nodeId } = deps.line;
    const log = deps.log ?? console.log;
    const weight = deps.roster.weight ?? 4;
    const heartbeatMs = deps.roster.heartbeatMs ?? 2000;
    const graceMs = deps.roster.graceMs ?? 2000;
    const commands = deps.commands ?? [];
    const wrap = deps.serve.wrap ?? function serveUnwrapped(fragment) { return fragment; };
    const readKey = deps.serve.keys?.read ?? 'app';
    const writeKey = deps.serve.keys?.write ?? 'scale';
    const rpcOpt = deps.serve.opt ? { opt: deps.serve.opt } : {};
    let started = false;
    let leaving = false;
    let torndown = false;
    let readersOf = null;
    let upstream = null;
    let replica = null;
    let control = null;
    let offControl = [];
    let beat = null;
    let grace = null;
    let served = false;
    let rehomes = 0;
    let rehome = null;
    function releaseControl() {
        for (const off of offControl)
            off();
        offControl = [];
        control?.close();
        control = null;
    }
    async function start() {
        if (started)
            return;
        started = true;
        try {
            await startBody();
        }
        catch (error) {
            started = false;
            if (beat) {
                clearInterval(beat);
                beat = null;
            }
            releaseControl();
            replica?.close();
            replica = null;
            readersOf = null;
            upstream = null;
            throw error;
        }
    }
    function abandoned() {
        return leaving || torndown;
    }
    async function startBody() {
        const link = await deps.upstream();
        if (abandoned())
            return;
        upstream = link;
        let firstLink = link;
        const { initial, ...coordinates } = deps.line;
        const line = (0, store_replica_set_1.createStoreReplicaSet)({
            ...coordinates,
            lineId: coordinates.lineId ?? nodeId + '-line',
            initial: initial ?? {},
            leadership: { initialRole: 'follower', eligible: false },
        });
        replica = line;
        line.control.addOffer({
            id: 'to-upstream',
            connect: async function connectUpstream() {
                const fresh = firstLink ?? await deps.upstream();
                firstLink = null;
                if (fresh != upstream) {
                    upstream = fresh;
                    if (served && rehome)
                        await rehome(fresh);
                }
                return {
                    remote: fresh.replica,
                    onFail: { on: (cb) => fresh.onFail.on(cb) },
                    close() { },
                };
            },
        });
        await line.api.ready;
        if (abandoned())
            return;
        log(`store node ${nodeId}: line caught up (seq ${line.api.status.state.authoritySeq})`);
        const auth = deps.auth;
        const scaleSessions = (0, rpc_session_registry_1.createSessionRegistry)();
        function isRevoked(account) {
            return control?.store.state.revoked?.[account] != undefined;
        }
        function readers() {
            return line.api.fragment.replay.line.count();
        }
        readersOf = readers;
        const liveByToken = (0, command_fragment_1.bindCommandNames)(commands, function bindLiveForward(name) {
            return function forwardThroughCurrentLink(token, requestId, input) {
                const link = upstream?.commandsByToken;
                if (!link)
                    return Promise.reject(new Error('store node: no upstream link for commands'));
                return link[name](token, requestId, input);
            };
        });
        function forwardedHop() {
            return auth && upstream?.commandsByToken && commands.length
                ? (0, command_token_1.forwardCommandsByToken)({ upstream: liveByToken, names: commands })
                : null;
        }
        const audience = deps.serve.audience ?? {};
        deps.serve.onConnection(function onNodeConnection(socket) {
            if (replica != line || torndown)
                return;
            const [gone, goneListen] = (0, Listen_1.listen)();
            const readerDefaults = {
                replica: line.api.fragment,
                node: () => nodeId,
                store: line.control.store,
            };
            const readerFragment = audience.reader ? audience.reader(readerDefaults) : { replica: readerDefaults.replica, node: readerDefaults.node };
            if (readerFragment) {
                (0, rpc_server_auto_1.createRpcServerAuto)({
                    socket,
                    socketKey: readKey,
                    object: wrap(readerFragment),
                    disconnectListen: goneListen,
                    ...rpcOpt,
                });
            }
            const session = { nodeId, onGone: (cb) => goneListen.on(cb) };
            let bound = null;
            const gated = auth ? (0, rpc_server_auto_1.createRpcServerAuto)({
                socket,
                socketKey: writeKey,
                object: {},
                auth: {
                    gate: true,
                    resolveAuth(presented) {
                        const principal = auth.verify(presented);
                        const account = principal.account;
                        if (isRevoked(account)) {
                            throw Object.assign(new Error('account revoked at the authority'), { revoke: true });
                        }
                        if (bound != account) {
                            if (bound)
                                scaleSessions.untrack(bound, gated.control);
                            bound = account;
                            scaleSessions.track(account, gated.control);
                        }
                        const forwarded = forwardedHop();
                        const principalDefaults = {
                            whoami: () => account + ' @ ' + nodeId,
                            ...(forwarded ? { commands: forwarded.fragment(presented) } : {}),
                            store: line.control.store,
                        };
                        const { store: _store, ...served } = principalDefaults;
                        return {
                            object: wrap(audience.principal ? audience.principal(principal, principalDefaults, session) : served),
                            ack: { ok: true, who: account, node: nodeId },
                            ...(principal.expiresAt != undefined ? { expiresAt: principal.expiresAt } : {}),
                            renewBeforeMs: auth.renewBeforeMs ?? 15_000,
                        };
                    },
                },
                disconnectListen: goneListen,
                ...rpcOpt,
            }) : null;
            socket.on('disconnect', function nodeClientGone() {
                gone();
                if (bound && gated)
                    scaleSessions.untrack(bound, gated.control);
            });
        });
        const url = deps.roster.url();
        function register(at) {
            return at.register({
                nodeId, url, weight, readers: readers(),
                ...(typeof globalThis.process?.pid == 'number' ? { pid: globalThis.process.pid } : {}),
            });
        }
        await register(upstream ?? link);
        if (abandoned()) {
            try {
                await (upstream ?? link).goodbye(nodeId);
            }
            catch { }
            return;
        }
        log(`store node ${nodeId}: serving at ${url}`);
        beat = setInterval(function nodeHeartbeat() {
            void Promise.resolve().then(function beatNow() { return upstream?.heartbeat(nodeId, { readers: readers() }); }).catch(function heartbeatLost() { });
        }, heartbeatMs);
        beat.unref?.();
        async function followControl(from) {
            releaseControl();
            const follower = (0, store_follower_1.createStoreFollower)({ remote: from.control, initial: { nodes: {}, revoked: {} } });
            control = follower;
            await follower.ready;
            if (abandoned() || control != follower)
                return;
            log(`store node ${nodeId}: following the control line (seq ${follower.status.state.seq})`);
            let known = new Set(Object.keys(follower.store.snapshot().revoked ?? {}));
            for (const account of known)
                scaleSessions.cut(account, 'account revoked at the authority');
            offControl.push(follower.store.node.at('revoked').on(function cutRevokedSessions(section) {
                const next = new Set(Object.keys(section ?? {}));
                for (const account of next) {
                    if (known.has(account))
                        continue;
                    scaleSessions.cut(account, 'account revoked at the authority');
                    log(`store node ${nodeId}: revocation fact applied — ${account}`);
                }
                known = next;
            }));
            let seenSelf = false;
            offControl.push(follower.store.node.at('nodes').at(nodeId).on(function ownRowChanged(value) {
                const entry = value;
                if (entry) {
                    seenSelf = true;
                    if (entry.draining)
                        leave('drained by the authority');
                }
                else if (seenSelf) {
                    leave('removed from the roster');
                }
            }, { current: true }));
        }
        await followControl(upstream ?? link);
        served = true;
        rehome = async function rehomeOnto(fresh) {
            if (abandoned())
                return;
            log(`store node ${nodeId}: re-homing onto a new authority link`);
            try {
                await register(fresh);
            }
            catch (error) {
                log(`store node ${nodeId}: re-registration failed — ${String(error?.message ?? error)}`);
            }
            await followControl(fresh);
            rehomes++;
        };
    }
    function teardown() {
        if (torndown)
            return;
        torndown = true;
        if (beat)
            clearInterval(beat);
        releaseControl();
        replica?.close();
    }
    function leave(reason) {
        if (leaving || torndown)
            return;
        leaving = true;
        log(`store node ${nodeId}: leaving — ${reason}`);
        if (beat)
            clearInterval(beat);
        void Promise.resolve().then(function withdraw() {
            return upstream?.goodbye(nodeId);
        }).catch(function withdrawalFailed() { });
        grace = setTimeout(function finishLeave() {
            teardown();
            deps.onLeave(reason);
        }, graceMs);
    }
    function close() {
        if (grace != null)
            clearTimeout(grace);
        teardown();
    }
    return {
        start,
        leave,
        view: {
            nodeId,
            status: () => ({ started, leaving, rehomes, readers: readersOf?.() ?? 0, seq: replica?.api.status.state.authoritySeq }),
        },
        close,
    };
}
