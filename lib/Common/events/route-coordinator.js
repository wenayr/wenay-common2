"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRouteCoordinator = createRouteCoordinator;
const Listen_1 = require("./Listen");
const replay_route_1 = require("./replay-route");
const transport_lifecycle_1 = require("./transport-lifecycle");
function unsubscribeHandle(handle) {
    if (typeof handle == 'function') {
        handle();
        return;
    }
    if (typeof handle?.off == 'function')
        handle.off();
    else if (typeof handle?.unsubscribe == 'function')
        handle.unsubscribe();
}
function optionalRemoteMember(remote, member) {
    if ((0, transport_lifecycle_1.hasRpcMemberLookup)(remote))
        return (0, transport_lifecycle_1.rpcMemberAvailable)(remote, member);
    try {
        return remote?.[member] != null;
    }
    catch {
        return false;
    }
}
function lazyRemote(connector) {
    let opened = null;
    function get() {
        return opened ??= Promise.resolve(connector.open());
    }
    function lazyLine(pick) {
        return {
            on(cb) {
                let off = null;
                let dead = false;
                get()
                    .then(pick)
                    .then(function attachLazyLine(line) { if (!dead)
                    off = line.on(cb); })
                    .catch(function swallowOpenError() { });
                return function offLazyLine() { dead = true; unsubscribeHandle(off); };
            },
        };
    }
    async function since(seq) {
        return (await get()).since(seq);
    }
    async function keyframe() {
        return (await get()).keyframe();
    }
    async function frame(seq, hint) {
        const remote = await get();
        await (0, transport_lifecycle_1.getRpcSchemaReady)(remote)?.();
        return optionalRemoteMember(remote, 'frame') ? remote.frame(seq, hint) : null;
    }
    return {
        line: lazyLine(r => r.line),
        frameLine: lazyLine(async function resolveFrameLine(r) {
            await (0, transport_lifecycle_1.getRpcSchemaReady)(r)?.();
            return optionalRemoteMember(r, 'frameLine') ? r.frameLine : r.line;
        }),
        since,
        keyframe,
        frame,
    };
}
function createRouteCoordinator(deps) {
    const { policy = {}, connect, shadow, catchUpTimeoutMs } = deps;
    const links = new Map();
    const [emitRoute, routeListen] = (0, Listen_1.listen)();
    async function allowed(hook, ctx, absent = true) {
        return hook ? !!(await hook(ctx)) : absent;
    }
    function pairKey(a, b) {
        return a <= b ? a + '|' + b : b + '|' + a;
    }
    function createLink(a, b) {
        const ref = { a, b, key: pairKey(a, b) };
        let state = 'relay';
        let lastReason;
        let relayConn = null;
        let relayRemote = null;
        let directConn = null;
        let directRemote = null;
        let shadowSub = null;
        const subs = new Set();
        let opChain = Promise.resolve();
        function chained(run) {
            const p = opChain.then(run, run);
            opChain = p.catch(() => { });
            return p;
        }
        function setState(to, reason) {
            if (state == 'closed')
                return;
            const from = state;
            state = to;
            lastReason = reason;
            emitRoute({ ...ref, from, to, reason });
        }
        function ctx(reason) {
            return { ...ref, state, reason };
        }
        function ensureRelay() {
            if (!relayConn || relayConn.state() == 'closed' || relayConn.state() == 'failed') {
                relayConn = connect(ref, 'relay');
                relayRemote = lazyRemote(relayConn);
                watchFail(relayConn, 'relay');
            }
            return relayRemote;
        }
        function watchFail(conn, kind) {
            conn.onFail?.on(function onConnectorFail(reason) {
                if (kind == 'relay') {
                    if (conn == relayConn)
                        emitRoute({ ...ref, from: state, to: state, reason });
                    return;
                }
                if (conn == directConn && (state == 'direct' || state == 'direct+shadowRelay')) {
                    demoteToRelay('fallback', reason).catch(() => { });
                }
            });
        }
        function currentRemote() {
            const direct = (state == 'direct' || state == 'direct+shadowRelay') && directRemote;
            return direct || ensureRelay();
        }
        function currentLabel() {
            const direct = (state == 'direct' || state == 'direct+shadowRelay') && directConn;
            return direct ? directConn.info.label : (relayConn?.info.label ?? 'relay');
        }
        async function switchSubs(remote, label, timeoutMs) {
            const jobs = Array.from(subs, function switchOne(sub) {
                return sub.switch(remote, { label, timeoutMs });
            });
            return Promise.all(jobs);
        }
        function resyncStraySubs() {
            const remote = currentRemote();
            const label = currentLabel();
            for (const sub of subs) {
                if (sub.label() != label)
                    sub.switch(remote, { label }).catch(() => { });
            }
        }
        function attachShadow() {
            if (!shadow || shadowSub)
                return;
            const since = subs.size ? Math.min(...Array.from(subs, sub => sub.seq())) : -1;
            shadowSub = (0, replay_route_1.replayRouteSubscribe)(ensureRelay(), function shadowTap(...ev) { shadow(ref, ...ev); }, { label: 'shadowRelay', since });
        }
        function dropShadow() {
            shadowSub?.();
            shadowSub = null;
        }
        function closeDirect() {
            dropShadow();
            directConn?.close();
            directConn = null;
            directRemote = null;
        }
        async function demoteToRelay(finalState, reason) {
            return chained(async function demoteOp() {
                if (state == 'blocked' || state == 'closed')
                    return { ok: false, state, reason: state };
                if (state != 'direct' && state != 'direct+shadowRelay') {
                    if (finalState == 'fallback')
                        setState('fallback', reason);
                    return { ok: true, state };
                }
                if (finalState == 'relay' && !(await allowed(policy.canReinterpose, ctx(reason)))) {
                    return { ok: false, state, reason: 'policy: canReinterpose' };
                }
                setState('relay:reinterposing', reason);
                const remote = ensureRelay();
                try {
                    await switchSubs(remote, relayConn.info.label);
                    closeDirect();
                    setState(finalState, reason);
                    resyncStraySubs();
                    return { ok: true, state };
                }
                catch (e) {
                    setState(shadowSub ? 'direct+shadowRelay' : 'direct', e);
                    return { ok: false, state, reason: e };
                }
            });
        }
        async function promoteDirect(opts = {}) {
            return chained(async function promoteOp() {
                const { timeoutMs = catchUpTimeoutMs, reason } = opts;
                if (state == 'blocked' || state == 'closed')
                    return { ok: false, state, reason: state };
                if (state == 'direct' || state == 'direct+shadowRelay')
                    return { ok: true, state };
                if (await allowed(policy.mustRelay, ctx(reason), false)) {
                    return { ok: false, state, reason: 'policy: mustRelay' };
                }
                if (!(await allowed(policy.canDirect, ctx(reason)))) {
                    return { ok: false, state, reason: 'policy: canDirect' };
                }
                if (!(await allowed(policy.canExposeEndpoint, ctx(reason)))) {
                    return { ok: false, state, reason: 'policy: canExposeEndpoint' };
                }
                const wantShadow = await allowed(policy.mustShadowRelay, ctx(reason), false);
                setState('direct:connecting', reason);
                const conn = connect(ref, 'direct');
                const remote = lazyRemote(conn);
                try {
                    await switchSubs(remote, conn.info.label, timeoutMs);
                    directConn = conn;
                    directRemote = remote;
                    watchFail(conn, 'direct');
                    if (wantShadow) {
                        setState('direct+shadowRelay', reason);
                        attachShadow();
                    }
                    else {
                        relayConn?.close();
                        relayConn = null;
                        relayRemote = null;
                        setState('direct', reason);
                    }
                    resyncStraySubs();
                    return { ok: true, state };
                }
                catch (e) {
                    conn.close();
                    try {
                        await switchSubs(ensureRelay(), relayConn.info.label);
                    }
                    catch { }
                    setState('fallback', e);
                    return { ok: false, state, reason: e };
                }
            });
        }
        function block(reason) {
            return chained(async function blockOp() {
                if (state == 'closed')
                    return { ok: false, state, reason: state };
                closeDirect();
                relayConn?.close();
                relayConn = null;
                relayRemote = null;
                for (const sub of Array.from(subs))
                    sub();
                subs.clear();
                setState('blocked', reason);
                return { ok: true, state };
            });
        }
        function subscribe(cb, opts = {}) {
            if (state == 'blocked' || state == 'closed') {
                throw new Error('route coordinator: pair ' + ref.key + ' is ' + state);
            }
            const sub = (0, replay_route_1.replayRouteSubscribe)(currentRemote(), cb, { ...opts, label: currentLabel() });
            subs.add(sub);
            function off() {
                subs.delete(sub);
                sub();
            }
            return Object.assign(off, {
                ready: sub.ready,
                seq: sub.seq,
                label: sub.label,
                active: sub.active,
            });
        }
        function close() {
            if (state == 'closed')
                return;
            closeDirect();
            relayConn?.close();
            relayConn = null;
            relayRemote = null;
            for (const sub of Array.from(subs))
                sub();
            subs.clear();
            links.delete(ref.key);
            setState('closed');
        }
        const link = {
            ref,
            state: () => state,
            reason: () => lastReason,
            label: currentLabel,
            metrics: () => ({
                relay: relayConn ? { state: relayConn.state(), ...relayConn.metrics?.() } : null,
                direct: directConn ? { state: directConn.state(), ...directConn.metrics?.() } : null,
            }),
            subscribe,
            promoteDirect,
            reinterposeRelay: (reason) => demoteToRelay('relay', reason),
            fallback: (reason) => demoteToRelay('fallback', reason),
            block,
            close,
        };
        return link;
    }
    function resolve(pairOrKey) {
        const key = typeof pairOrKey == 'string' ? pairOrKey
            : 'ref' in pairOrKey ? pairOrKey.ref.key : pairOrKey.key;
        const link = links.get(key);
        if (!link)
            throw new Error('route coordinator: unknown pair ' + key);
        return link;
    }
    return {
        pair(a, b) {
            const key = pairKey(a, b);
            let link = links.get(key);
            if (!link || link.state() == 'closed') {
                link = createLink(a, b);
                links.set(key, link);
            }
            return link;
        },
        state: (pairOrKey) => resolve(pairOrKey).state(),
        promoteDirect: (pairOrKey, opts) => resolve(pairOrKey).promoteDirect(opts),
        reinterposeRelay: (pairOrKey, reason) => resolve(pairOrKey).reinterposeRelay(reason),
        fallback: (pairOrKey, reason) => resolve(pairOrKey).fallback(reason),
        block: (pairOrKey, reason) => resolve(pairOrKey).block(reason),
        onRoute: (cb) => routeListen.on(cb),
        pairs: () => Array.from(links.values()),
        close() {
            for (const link of Array.from(links.values()))
                link.close();
        },
    };
}
