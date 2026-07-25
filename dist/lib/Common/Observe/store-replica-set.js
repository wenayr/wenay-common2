"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStoreReplicaOffers = createStoreReplicaOffers;
exports.createStoreReplicaSet = createStoreReplicaSet;
const common_1 = require("../core/common");
const Listen_1 = require("../events/Listen");
const store_1 = require("./store");
const store_replay_1 = require("./store-replay");
const transport_lifecycle_1 = require("../events/transport-lifecycle");
const store_follower_1 = require("./store-follower");
const store_replay_codec_1 = require("./store-replay-codec");
function errorText(error) {
    if (typeof error?.message == 'string')
        return error.message;
    return String(error);
}
async function optionalRemoteMember(remote, member) {
    if ((0, transport_lifecycle_1.hasRpcMemberLookup)(remote)) {
        await (0, transport_lifecycle_1.getRpcSchemaReady)(remote)?.();
        return (0, transport_lifecycle_1.rpcMemberAvailable)(remote, member);
    }
    return remote?.[member] != null;
}
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
function requiredId(value, label) {
    if (typeof value != 'string' || !value.trim())
        throw new Error('store replica set: ' + label + ' is required');
    return value.trim();
}
function defaultAuthorityCompare(a, b) {
    if (a.epoch != b.epoch)
        return a.epoch - b.epoch;
    const leaderOrder = (a.leaderId ?? '').localeCompare(b.leaderId ?? '');
    if (leaderOrder)
        return leaderOrder;
    return (a.authorityLineId ?? '').localeCompare(b.authorityLineId ?? '');
}
function sameAuthority(a, b) {
    return !!a && !!b && a.originId == b.originId && a.epoch == b.epoch && a.leaderId == b.leaderId &&
        a.authorityLineId == b.authorityLineId;
}
function keyframeState(value) {
    if (value == null)
        return null;
    const patch = (0, store_replay_codec_1.decodeStoreReplayBatchV2)(value).event[0][0];
    if (!patch || patch.path.length || !patch.exists || patch.value == null || typeof patch.value != 'object')
        return null;
    return patch.value;
}
function timer(delay, run) {
    const handle = setTimeout(run, delay);
    handle.unref?.();
    return handle;
}
function createStoreReplicaOffers(initial = []) {
    const offers = new Map();
    const [emitChanges, changes] = (0, Listen_1.listen)();
    function publish() {
        emitChanges(Array.from(offers.values()));
    }
    function upsert(offer) {
        const id = requiredId(offer.id, 'offer id');
        offers.set(id, { ...offer, id });
        publish();
        return function removeThisOffer() {
            if (offers.get(id)?.connect != offer.connect)
                return;
            offers.delete(id);
            publish();
        };
    }
    function replace(next) {
        offers.clear();
        for (const offer of next)
            offers.set(requiredId(offer.id, 'offer id'), offer);
        publish();
    }
    replace(initial);
    return {
        control: {
            upsert,
            remove(id) {
                if (!offers.delete(id))
                    return false;
                publish();
                return true;
            },
            replace,
            clear() {
                if (!offers.size)
                    return;
                offers.clear();
                publish();
            },
        },
        api: {
            list: () => Array.from(offers.values()),
            changes,
        },
    };
}
function createStoreReplicaSet(deps) {
    const storeId = requiredId(deps.storeId, 'storeId');
    const originId = requiredId(deps.originId, 'originId');
    const nodeId = requiredId(deps.nodeId, 'nodeId');
    const lineId = requiredId(deps.lineId ?? nodeId + ':' + Math.random().toString(36).slice(2), 'lineId');
    const now = deps.now ?? Date.now;
    const leadership = deps.leadership ?? {};
    const compareAuthority = leadership.compare ?? defaultAuthorityCompare;
    const reconnectMs = deps.route?.reconnectMs ?? 1000;
    const pingTimeoutMs = deps.route?.pingTimeoutMs ?? 3000;
    const hysteresisMs = deps.route?.hysteresisMs ?? 8;
    const store = deps.store ?? (0, store_1.createStore)((deps.initial ?? {}));
    const exposeOpts = deps.expose ?? {};
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, exposeOpts);
    const offers = new Map();
    const [emitDescriptor, descriptorChanges] = (0, Listen_1.listen)();
    const [emitConflict, conflictListen] = (0, Listen_1.listen)();
    const [emitRoute, routeListen] = (0, Listen_1.listen)();
    let role = leadership.initialRole == 'follower' ? 'offline' : 'leader';
    let leaderId = role == 'leader' ? nodeId : null;
    let epoch = leadership.epoch ?? 0;
    let proof = leadership.proof;
    let authorityLineId = role == 'leader' ? lineId : null;
    let authoritySeq = role == 'leader' ? exposed.replay.head() : -1;
    let authorityCost = role == 'leader' ? 0 : null;
    let authorityPath = role == 'leader' ? [nodeId] : [];
    let activeEntry = null;
    let activeDescriptor = null;
    let upstreamSub = null;
    let conflictCount = 0;
    let lastError = null;
    let maxObservedEpoch = epoch;
    let closed = false;
    let electionTimer = null;
    let probeTimer = null;
    let reconcileScheduled = false;
    let opChain = Promise.resolve();
    let readySettled = false;
    let lastPublishedDescriptor = null;
    let dataStatusScheduled = false;
    let settleReady = function settleReadyLater() { };
    const ready = new Promise(function waitForReplicaReady(resolve) { settleReady = resolve; });
    function settleReplicaReady() {
        if (readySettled || (role != 'leader' && role != 'follower'))
            return;
        readySettled = true;
        settleReady();
    }
    function descriptor() {
        return {
            protocol: 1,
            storeId,
            originId,
            nodeId,
            lineId,
            leaderId,
            epoch,
            role: role == 'leader' ? 'leader' : role == 'follower' ? 'follower' : 'candidate',
            authorityLineId,
            authoritySeq,
            authorityCost,
            path: [...authorityPath],
            headSeq: exposed.replay.head(),
            ...(proof !== undefined ? { proof } : {}),
        };
    }
    function routeSnapshot(entry) {
        const source = entry.descriptor;
        return {
            id: entry.offer.id,
            state: entry.state,
            nodeId: source?.nodeId ?? null,
            leaderId: source?.leaderId ?? null,
            epoch: source?.epoch ?? null,
            lineId: source?.lineId ?? null,
            authoritySeq: source?.authoritySeq ?? -1,
            path: source ? [...source.path] : [],
            rtt: entry.rtt,
            cost: source?.authorityCost != null && entry.rtt != null ? routeCost(entry) : null,
            error: entry.error,
        };
    }
    function publishStatus() {
        dataStatusScheduled = false;
        const routes = {};
        for (const [id, entry] of offers)
            routes[id] = routeSnapshot(entry);
        const next = {
            role,
            nodeId,
            leaderId,
            epoch,
            authorityLineId,
            authoritySeq,
            authorityCost,
            path: [...authorityPath],
            routeId: activeEntry?.offer.id ?? null,
            routeNodeId: activeDescriptor?.nodeId ?? null,
            rtt: activeEntry?.rtt ?? null,
            conflicts: conflictCount,
            error: lastError,
            routes,
        };
        status.replace(next);
        const current = descriptor();
        if (!lastPublishedDescriptor || !(0, common_1.deepEqual)(lastPublishedDescriptor, current)) {
            lastPublishedDescriptor = current;
            emitDescriptor(current);
        }
        settleReplicaReady();
    }
    function scheduleDataStatus() {
        if (closed || dataStatusScheduled)
            return;
        dataStatusScheduled = true;
        queueMicrotask(function publishReplicaDataStatus() {
            if (!dataStatusScheduled || closed)
                return;
            publishStatus();
        });
    }
    const status = (0, store_1.createStore)({
        role,
        nodeId,
        leaderId,
        epoch,
        authorityLineId,
        authoritySeq,
        authorityCost,
        path: [...authorityPath],
        routeId: null,
        routeNodeId: null,
        rtt: null,
        conflicts: 0,
        error: null,
        routes: {},
    });
    function report(error) {
        lastError = errorText(error);
        publishStatus();
    }
    function clearElectionTimer() {
        if (!electionTimer)
            return;
        clearTimeout(electionTimer);
        electionTimer = null;
    }
    function validateDescriptor(value) {
        if (!value || value.protocol != 1)
            throw new Error('unsupported replica protocol');
        if (value.storeId != storeId)
            throw new Error('different storeId: ' + value.storeId);
        if (value.originId != originId)
            throw new Error('different originId: ' + value.originId);
        requiredId(value.nodeId, 'remote nodeId');
        requiredId(value.lineId, 'remote lineId');
        if (!Number.isInteger(value.epoch) || value.epoch < 0)
            throw new Error('invalid remote epoch');
        if (!Number.isInteger(value.headSeq) || value.headSeq < 0)
            throw new Error('invalid remote headSeq');
        if (!Number.isInteger(value.authoritySeq) || value.authoritySeq < -1)
            throw new Error('invalid remote authoritySeq');
        if ((value.role == 'leader' || value.role == 'follower') &&
            (typeof value.authorityCost != 'number' || !Number.isFinite(value.authorityCost) || value.authorityCost < 0)) {
            throw new Error('invalid remote authority cost');
        }
        if (!Array.isArray(value.path) || value.path.some(part => typeof part != 'string' || !part)) {
            throw new Error('invalid remote authority path');
        }
        if (new Set(value.path).size != value.path.length)
            throw new Error('cyclic remote authority path');
        if (value.nodeId == nodeId)
            throw new Error('self route rejected');
        if (value.leaderId != null)
            requiredId(value.leaderId, 'remote leaderId');
        if (value.authorityLineId != null)
            requiredId(value.authorityLineId, 'remote authorityLineId');
        if ((value.role == 'leader' || value.role == 'follower') &&
            (value.path[0] != value.leaderId || value.path[value.path.length - 1] != value.nodeId)) {
            throw new Error('invalid remote authority path');
        }
        if (value.role == 'leader' &&
            (value.nodeId != value.leaderId || value.lineId != value.authorityLineId || value.path.length != 1 || value.authorityCost != 0)) {
            throw new Error('invalid remote leader descriptor');
        }
        return value;
    }
    async function accepted(value) {
        validateDescriptor(value);
        return leadership.accept ? !!(await leadership.accept(value)) : true;
    }
    function clearRetry(entry) {
        if (!entry.retry)
            return;
        clearTimeout(entry.retry);
        entry.retry = null;
    }
    function closeSession(entry) {
        entry.generation++;
        unsubscribeHandle(entry.offChanged);
        unsubscribeHandle(entry.offFail);
        entry.offChanged = null;
        entry.offFail = null;
        const session = entry.session;
        entry.session = null;
        try {
            session?.close();
        }
        catch { }
    }
    function scheduleReconnect(entry) {
        if (closed || entry.state == 'rejected' || !offers.has(entry.offer.id) || entry.retry)
            return;
        entry.retry = timer(reconnectMs, function retryReplicaOffer() {
            entry.retry = null;
            void openEntry(entry);
        });
    }
    function detachUpstream(reason) {
        const from = activeEntry?.offer.id ?? null;
        upstreamSub?.();
        upstreamSub = null;
        activeEntry = null;
        activeDescriptor = null;
        authorityCost = null;
        if (role == 'follower' || role == 'reconciling')
            role = 'offline';
        emitRoute({ from, to: null, reason, rtt: null });
    }
    function failEntry(entry, reason) {
        if (!offers.has(entry.offer.id) || entry.state == 'closed')
            return;
        const wasActive = activeEntry == entry;
        closeSession(entry);
        entry.state = 'failed';
        entry.descriptor = null;
        entry.error = errorText(reason);
        if (wasActive)
            detachUpstream('route failed: ' + entry.offer.id);
        publishStatus();
        scheduleReconnect(entry);
        scheduleReconcile('route failed');
    }
    async function ping(entry, generation) {
        const session = entry.session;
        if (!session || !(await optionalRemoteMember(session.remote, 'ping')))
            return 0;
        if (generation != entry.generation || session != entry.session)
            throw new Error('stale ping generation');
        const probe = session.remote.ping;
        const started = now();
        let timeoutHandle = null;
        const timeout = new Promise(function pingDeadline(_resolve, reject) {
            timeoutHandle = timer(pingTimeoutMs, function pingTimedOut() { reject(new Error('ping timeout')); });
        });
        try {
            await Promise.race([Promise.resolve(probe()), timeout]);
            if (generation != entry.generation)
                throw new Error('stale ping generation');
            return Math.max(0, now() - started);
        }
        finally {
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
        }
    }
    function refreshEntry(entry) {
        if (entry.refreshing)
            return entry.refreshing;
        const generation = entry.generation;
        const run = async function refreshReplicaOffer() {
            const session = entry.session;
            if (!session)
                return;
            try {
                const value = validateDescriptor(await session.remote.descriptor());
                if (value.path.includes(nodeId)) {
                    entry.descriptor = value;
                    entry.state = 'rejected';
                    entry.error = 'cycle route rejected: ' + value.path.concat(nodeId).join(' -> ');
                    publishStatus();
                    scheduleReconcile('cycle route rejected');
                    return;
                }
                if (!(await accepted(value))) {
                    entry.descriptor = value;
                    entry.state = 'rejected';
                    entry.error = 'authority proof rejected';
                    publishStatus();
                    scheduleReconcile('authority proof rejected');
                    return;
                }
                const sample = await ping(entry, generation);
                if (generation != entry.generation || session != entry.session)
                    return;
                entry.descriptor = value;
                entry.rtt = entry.rtt == null ? sample : entry.rtt * 0.7 + sample * 0.3;
                entry.state = 'open';
                entry.error = null;
                maxObservedEpoch = Math.max(maxObservedEpoch, value.epoch);
                publishStatus();
                scheduleReconcile('descriptor changed');
            }
            catch (error) {
                if (generation != entry.generation)
                    return;
                if (/different storeId|different originId|self route|unsupported replica/.test(errorText(error))) {
                    closeSession(entry);
                    entry.state = 'rejected';
                    entry.descriptor = null;
                    entry.error = errorText(error);
                    publishStatus();
                    return;
                }
                failEntry(entry, error);
            }
        };
        entry.refreshing = run().finally(function finishReplicaRefresh() { entry.refreshing = null; });
        return entry.refreshing;
    }
    async function openEntry(entry) {
        if (closed || !offers.has(entry.offer.id) || entry.session || entry.state == 'connecting')
            return;
        clearRetry(entry);
        entry.state = 'connecting';
        entry.error = null;
        const generation = ++entry.generation;
        publishStatus();
        try {
            const session = await entry.offer.connect();
            if (closed || generation != entry.generation || !offers.has(entry.offer.id)) {
                session.close();
                return;
            }
            entry.session = session;
            entry.offFail = session.onFail?.on(function replicaSessionFailed(reason) {
                failEntry(entry, reason ?? new Error('replica session failed'));
            }) ?? null;
            const hasChanged = await optionalRemoteMember(session.remote, 'changed');
            if (closed || generation != entry.generation || entry.session != session)
                return;
            if (hasChanged) {
                entry.offChanged = session.remote.changed.on(function remoteDescriptorChanged() {
                    void refreshEntry(entry);
                });
            }
            await refreshEntry(entry);
        }
        catch (error) {
            if (generation == entry.generation)
                failEntry(entry, error);
        }
    }
    function addOffer(offerValue) {
        const id = requiredId(offerValue.id, 'offer id');
        removeOffer(id);
        const offer = { ...offerValue, id };
        const entry = {
            offer,
            generation: 0,
            state: 'failed',
            session: null,
            descriptor: null,
            rtt: null,
            error: null,
            retry: null,
            offChanged: null,
            offFail: null,
            refreshing: null,
        };
        offers.set(id, entry);
        void openEntry(entry);
        return function removeAddedOffer() { removeOffer(id); };
    }
    function removeOffer(id) {
        const entry = offers.get(id);
        if (!entry)
            return false;
        offers.delete(id);
        clearRetry(entry);
        const wasActive = activeEntry == entry;
        closeSession(entry);
        entry.state = 'closed';
        if (wasActive)
            detachUpstream('route removed: ' + id);
        publishStatus();
        scheduleReconcile('offer removed');
        return true;
    }
    function setOffers(next) {
        const wanted = new Map();
        for (const offer of next)
            wanted.set(requiredId(offer.id, 'offer id'), offer);
        for (const id of Array.from(offers.keys())) {
            const replacement = wanted.get(id);
            if (!replacement || replacement.connect != offers.get(id)?.offer.connect)
                removeOffer(id);
        }
        for (const [id, offer] of wanted) {
            if (!offers.has(id))
                addOffer(offer);
        }
    }
    function viable(entry) {
        const value = entry.descriptor;
        return entry.state == 'open' && !!entry.session && !!value &&
            (value.role == 'leader' || value.role == 'follower') && value.leaderId != null && value.authorityLineId != null;
    }
    function routeCost(entry) {
        const priority = Number.isFinite(entry.offer.priority) ? entry.offer.priority : 0;
        return (entry.descriptor?.authorityCost ?? Number.POSITIVE_INFINITY) + (entry.rtt ?? 0) + priority;
    }
    function chooseRoute(candidates) {
        const authorityLine = candidates[0]?.descriptor?.authorityLineId;
        const sameLineage = candidates.filter(entry => entry.descriptor?.authorityLineId == authorityLine);
        const freshestSeq = Math.max(...sameLineage.map(entry => entry.descriptor.authoritySeq));
        const fresh = sameLineage.filter(entry => entry.descriptor.authoritySeq == freshestSeq);
        fresh.sort((a, b) => routeCost(a) - routeCost(b) || a.offer.id.localeCompare(b.offer.id));
        const best = fresh[0];
        if (!best || !activeEntry || !fresh.includes(activeEntry))
            return best;
        return routeCost(best) + hysteresisMs < routeCost(activeEntry) ? best : activeEntry;
    }
    function bestRemoteAuthority(candidates) {
        let best = null;
        for (const entry of candidates) {
            const value = entry.descriptor;
            if (!best || compareAuthority(value, best) > 0)
                best = value;
        }
        return best;
    }
    function conflictFor(localState, authorityState, localDescriptor, next) {
        if ((0, common_1.deepEqual)(localState, authorityState))
            return null;
        const diff = (0, store_follower_1.diffKeyedState)(localState, authorityState);
        if (!diff.localOnly.length && !diff.conflicts.length)
            return null;
        return { detectedAt: now(), local: localDescriptor, authority: next, localState, authorityState, diff };
    }
    function trackAuthoritySeq(seq) {
        if (activeDescriptor?.lineId == activeDescriptor?.authorityLineId)
            authoritySeq = seq;
        else
            authoritySeq = Math.max(authoritySeq, activeDescriptor?.authoritySeq ?? -1);
        scheduleDataStatus();
    }
    async function follow(entry, next, reason) {
        const session = entry.session;
        if (!session)
            throw new Error('replica route closed before hand-off');
        const previousRole = role;
        const previousEntry = activeEntry;
        const previousDescriptor = activeDescriptor;
        const previousAuthority = descriptor();
        const previousLeaderId = leaderId;
        const previousEpoch = epoch;
        const previousLineId = authorityLineId;
        const previousSeq = authoritySeq;
        const previousCost = authorityCost;
        const previousPath = authorityPath;
        const previousProof = proof;
        const authorityChanged = !sameAuthority(previousDescriptor ?? (previousRole == 'leader' ? previousAuthority : null), next);
        const sameSequenceSpace = sameAuthority(previousDescriptor, next) && previousDescriptor?.lineId == next.lineId;
        const authorityFrame = previousRole == 'leader' && authorityChanged
            ? keyframeState(await session.remote.replay.keyframe())
            : null;
        const pendingConflict = authorityFrame
            ? conflictFor(store.snapshot(), authorityFrame, previousAuthority, next)
            : null;
        role = 'reconciling';
        leaderId = next.leaderId;
        epoch = next.epoch;
        proof = next.proof;
        authorityLineId = next.authorityLineId;
        authoritySeq = next.authoritySeq;
        authorityCost = routeCost(entry);
        authorityPath = [...next.path, nodeId];
        publishStatus();
        let created = false;
        try {
            if (!upstreamSub) {
                created = true;
                upstreamSub = (0, store_replay_1.syncStoreReplayRoute)(store, session.remote.replay, {
                    label: entry.offer.id,
                    since: -1,
                    reset: true,
                    onSeq: trackAuthoritySeq,
                    onError: function activeReplicaRouteFailed(error) { failEntry(entry, error); },
                });
                await upstreamSub.ready;
            }
            else {
                await upstreamSub.switch(session.remote.replay, {
                    label: entry.offer.id,
                    ...(sameSequenceSpace ? {} : { since: -1, reset: true }),
                });
            }
            if (closed || entry.session != session)
                throw new Error('replica route changed during hand-off');
            activeEntry = entry;
            activeDescriptor = next;
            leaderId = next.leaderId;
            epoch = next.epoch;
            proof = next.proof;
            authorityLineId = next.authorityLineId;
            authoritySeq = Math.max(authoritySeq, next.authoritySeq);
            authorityCost = routeCost(entry);
            authorityPath = [...next.path, nodeId];
            role = 'follower';
            lastError = null;
            clearElectionTimer();
            if (pendingConflict) {
                conflictCount++;
                emitConflict(pendingConflict);
            }
            emitRoute({ from: previousEntry?.offer.id ?? null, to: entry.offer.id, reason, rtt: entry.rtt });
            publishStatus();
        }
        catch (error) {
            if (created) {
                upstreamSub?.();
                upstreamSub = null;
            }
            activeEntry = previousEntry;
            activeDescriptor = previousDescriptor;
            leaderId = previousLeaderId;
            epoch = previousEpoch;
            authorityLineId = previousLineId;
            authoritySeq = previousSeq;
            authorityCost = previousCost;
            authorityPath = previousPath;
            proof = previousProof;
            role = previousRole;
            report(error);
            throw error;
        }
    }
    async function promote(reason = 'manual') {
        if (closed)
            throw new Error('store replica set is closed');
        if (role == 'leader')
            return descriptor();
        if (leadership.eligible == false)
            return null;
        const candidates = Array.from(offers.values()).filter(viable).map(entry => entry.descriptor);
        const ctx = { storeId, originId, nodeId, maxEpoch: maxObservedEpoch, candidates };
        const elected = leadership.elect
            ? await leadership.elect(ctx)
            : { epoch: maxObservedEpoch + 1 };
        if (!elected) {
            role = 'offline';
            publishStatus();
            return null;
        }
        if (!Number.isInteger(elected.epoch) || elected.epoch <= maxObservedEpoch) {
            throw new Error('store replica election must return an epoch above ' + maxObservedEpoch);
        }
        const from = activeEntry?.offer.id ?? null;
        upstreamSub?.();
        upstreamSub = null;
        activeEntry = null;
        activeDescriptor = null;
        epoch = elected.epoch;
        maxObservedEpoch = epoch;
        proof = elected.proof;
        leaderId = nodeId;
        authorityLineId = lineId;
        authoritySeq = exposed.replay.head();
        authorityCost = 0;
        authorityPath = [nodeId];
        role = 'leader';
        lastError = null;
        clearElectionTimer();
        emitRoute({ from, to: null, reason: 'promoted: ' + reason, rtt: null });
        publishStatus();
        scheduleReconcile('local promotion');
        return descriptor();
    }
    function scheduleElection(reason) {
        if (closed || role == 'leader' || electionTimer || leadership.autoPromoteMs == null || leadership.eligible == false) {
            if (role != 'leader' && role != 'electing')
                role = 'offline';
            publishStatus();
            return;
        }
        role = 'electing';
        publishStatus();
        electionTimer = timer(leadership.autoPromoteMs, function automaticReplicaElection() {
            electionTimer = null;
            void promote(reason).catch(report);
        });
    }
    async function runReconcile(reason) {
        if (closed)
            return;
        const candidates = Array.from(offers.values()).filter(viable);
        for (const entry of candidates)
            maxObservedEpoch = Math.max(maxObservedEpoch, entry.descriptor.epoch);
        const remoteBest = bestRemoteAuthority(candidates);
        const local = role == 'leader' ? descriptor() : null;
        if (local && (!remoteBest || compareAuthority(local, remoteBest) >= 0)) {
            clearElectionTimer();
            lastError = null;
            publishStatus();
            return;
        }
        if (!remoteBest) {
            if (activeEntry || upstreamSub)
                detachUpstream('authority unavailable');
            scheduleElection(reason);
            return;
        }
        clearElectionTimer();
        const routes = candidates.filter(entry => sameAuthority(entry.descriptor, remoteBest));
        const chosen = chooseRoute(routes);
        if (!chosen) {
            scheduleElection('no viable route');
            return;
        }
        const next = chosen.descriptor;
        if (activeEntry == chosen && role == 'follower' && sameAuthority(activeDescriptor, next)) {
            activeDescriptor = next;
            leaderId = next.leaderId;
            epoch = next.epoch;
            proof = next.proof;
            authorityLineId = next.authorityLineId;
            authoritySeq = Math.max(authoritySeq, next.authoritySeq);
            authorityCost = routeCost(chosen);
            authorityPath = [...next.path, nodeId];
            lastError = null;
            publishStatus();
            return;
        }
        await follow(chosen, next, reason);
    }
    function reconcile(reason = 'manual') {
        const run = opChain.then(function serializedReplicaReconcile() { return runReconcile(reason); });
        opChain = run.catch(function rememberReplicaReconcileError(error) { report(error); });
        return run;
    }
    function scheduleReconcile(reason) {
        if (closed || reconcileScheduled)
            return;
        reconcileScheduled = true;
        Promise.resolve().then(function runScheduledReplicaReconcile() {
            reconcileScheduled = false;
            void reconcile(reason).catch(function scheduledReplicaError() { });
        });
    }
    async function probe() {
        await Promise.all(Array.from(offers.values(), function refreshOpenReplica(entry) {
            return entry.session ? refreshEntry(entry) : openEntry(entry);
        }));
        await reconcile('probe');
    }
    const offHead = exposed.replay.line.on(function localReplicaHeadChanged() {
        if (role == 'leader')
            authoritySeq = exposed.replay.head();
        scheduleDataStatus();
    });
    const offOfferSource = deps.offers?.changes.on(function replaceDiscoveredOffers(next) { setOffers(next); }) ?? null;
    if (deps.offers)
        setOffers(deps.offers.list());
    if (deps.route?.probeIntervalMs != null) {
        probeTimer = setInterval(function periodicReplicaProbe() { void probe().catch(report); }, deps.route.probeIntervalMs);
        probeTimer.unref?.();
    }
    publishStatus();
    if (role != 'leader' && !offers.size)
        scheduleElection('initial election');
    function close() {
        if (closed)
            return;
        closed = true;
        clearElectionTimer();
        if (probeTimer)
            clearInterval(probeTimer);
        probeTimer = null;
        unsubscribeHandle(offOfferSource);
        upstreamSub?.();
        upstreamSub = null;
        for (const entry of Array.from(offers.values())) {
            clearRetry(entry);
            closeSession(entry);
            entry.state = 'closed';
        }
        offers.clear();
        role = 'closed';
        activeEntry = null;
        activeDescriptor = null;
        offHead();
        publishStatus();
        exposed.close();
        descriptorChanges.close();
        conflictListen.close();
        routeListen.close();
    }
    const fragment = {
        descriptor,
        changed: descriptorChanges,
        replay: exposed.api.replay,
        ping: () => now(),
    };
    return {
        control: {
            store,
            addOffer,
            removeOffer,
            setOffers,
            probe,
            reconcile,
            promote,
            canWrite: () => role == 'leader',
            close,
        },
        api: {
            store,
            status,
            ready,
            descriptor,
            changed: descriptorChanges,
            conflicts: conflictListen,
            routes: routeListen,
            replay: exposed.replay,
            fragment,
            canWrite: () => role == 'leader',
        },
        close,
    };
}
