"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerPacketOffers = createPeerPacketOffers;
exports.createPeerPacketMesh = createPeerPacketMesh;
const Listen_1 = require("../events/Listen");
const MAX_ROUTE_ADVERTISEMENTS = 4096;
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
function timer(delay, run) {
    const handle = setTimeout(run, delay);
    handle.unref?.();
    return handle;
}
function requiredId(value, label) {
    if (typeof value != 'string' || !value.trim())
        throw new Error('peer packet mesh: ' + label + ' is required');
    return value.trim();
}
function errorText(error) {
    if (typeof error?.message == 'string')
        return error.message;
    return String(error);
}
function finiteCost(value) {
    return typeof value == 'number' && Number.isFinite(value) && value >= 0;
}
function nonNegativeInteger(value, label) {
    if (typeof value != 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error('peer packet mesh: ' + label + ' must be a non-negative integer');
    }
    return value;
}
function nonNegativeNumber(value, label) {
    if (!finiteCost(value))
        throw new Error('peer packet mesh: ' + label + ' must be a non-negative finite number');
    return value;
}
function normalizeOffer(offer) {
    const id = requiredId(offer.id, 'offer id');
    const peerId = requiredId(offer.peerId, 'peer id');
    if (typeof offer.connect != 'function')
        throw new Error('peer packet mesh: offer connect must be a function');
    if (offer.priority != undefined)
        nonNegativeNumber(offer.priority, 'offer priority');
    return { ...offer, id, peerId };
}
function closeSession(session) {
    try {
        session?.close();
    }
    catch { }
}
function sameRoute(a, b) {
    return !!a && !!b && a.targetId == b.targetId && a.nextHopId == b.nextHopId &&
        a.offerId == b.offerId && a.cost == b.cost && a.path.join('\u0000') == b.path.join('\u0000');
}
function createPeerPacketOffers(initial = []) {
    const offers = new Map();
    const [emitChanges, changes] = (0, Listen_1.listen)();
    function publish() {
        emitChanges(Array.from(offers.values()));
    }
    function upsert(offer) {
        const stored = normalizeOffer(offer);
        offers.set(stored.id, stored);
        publish();
        return function removeThisOffer() {
            if (offers.get(stored.id) != stored)
                return;
            offers.delete(stored.id);
            publish();
        };
    }
    function replace(next) {
        offers.clear();
        for (const offer of next) {
            const stored = normalizeOffer(offer);
            offers.set(stored.id, stored);
        }
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
function createPeerPacketMesh(deps) {
    const { offers: offerSource, accept, now = Date.now } = deps;
    const maxHops = nonNegativeInteger(deps.maxHops ?? 8, 'maxHops');
    const seenLimit = nonNegativeInteger(deps.seenLimit ?? 4096, 'seenLimit');
    const reconnectMs = nonNegativeNumber(deps.reconnectMs ?? 1000, 'reconnectMs');
    const probeIntervalMs = nonNegativeNumber(deps.probeIntervalMs ?? 10_000, 'probeIntervalMs');
    const pingTimeoutMs = nonNegativeNumber(deps.pingTimeoutMs ?? 3000, 'pingTimeoutMs');
    if (seenLimit < 1)
        throw new Error('peer packet mesh: seenLimit must be at least 1');
    const meshId = requiredId(deps.meshId, 'mesh id');
    const nodeId = requiredId(deps.nodeId, 'node id');
    const instanceId = deps.instanceId == undefined
        ? nodeId + '-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
        : requiredId(deps.instanceId, 'instance id');
    const [emitPacket, packets] = (0, Listen_1.listen)();
    const [emitRoutes, routeChanges] = (0, Listen_1.listen)();
    const [emitStatus, statusChanges] = (0, Listen_1.listen)();
    const entries = new Map();
    const seen = new Map();
    const stats = {
        sent: 0,
        forwarded: 0,
        delivered: 0,
        duplicates: 0,
        invalid: 0,
        rejected: 0,
        noRoute: 0,
    };
    let routes = new Map();
    let routeVersion = 0;
    let sequence = 0;
    let closed = false;
    function createOfferEntry(offer) {
        return {
            offer,
            state: 'closed',
            session: null,
            advertisements: new Map(),
            receivedVersion: -1,
            rtt: null,
            error: null,
            generation: 0,
            offMessages: null,
            offFail: null,
            reconnect: null,
            probe: null,
        };
    }
    function linkCost(entry) {
        return Math.max(0, entry.offer.priority ?? 0) + (entry.rtt ?? 0);
    }
    function publicStatus(entry) {
        return {
            id: entry.offer.id,
            peerId: entry.offer.peerId,
            state: entry.state,
            rtt: entry.rtt,
            cost: entry.state == 'open' ? linkCost(entry) : null,
            error: entry.error,
        };
    }
    function publishStatus() {
        emitStatus(Array.from(entries.values(), publicStatus));
    }
    function routeCandidates(targetId, visited = [], hopBudget = maxHops) {
        const candidates = [];
        const visitedSet = new Set(visited);
        for (const entry of entries.values()) {
            if (entry.state != 'open' || !entry.session || visitedSet.has(entry.offer.peerId))
                continue;
            const direct = entry.offer.peerId == targetId
                ? { targetId, cost: 0, path: [entry.offer.peerId] }
                : entry.advertisements.get(targetId);
            if (!direct)
                continue;
            if (direct.path.length > hopBudget)
                continue;
            if (direct.path.some(id => visitedSet.has(id)))
                continue;
            const cost = linkCost(entry) + direct.cost;
            if (!finiteCost(cost))
                continue;
            candidates.push({
                entry,
                route: {
                    targetId,
                    nextHopId: entry.offer.peerId,
                    offerId: entry.offer.id,
                    cost,
                    path: [nodeId, ...direct.path],
                },
            });
        }
        candidates.sort(function compareRoutes(a, b) {
            return a.route.cost - b.route.cost || a.route.path.length - b.route.path.length ||
                a.route.offerId.localeCompare(b.route.offerId);
        });
        return candidates;
    }
    function recomputeRoutes() {
        const targets = new Set();
        for (const entry of entries.values()) {
            if (entry.state != 'open')
                continue;
            targets.add(entry.offer.peerId);
            for (const target of entry.advertisements.keys())
                targets.add(target);
        }
        targets.delete(nodeId);
        const next = new Map();
        for (const target of targets) {
            const best = routeCandidates(target)[0];
            if (best)
                next.set(target, best.route);
        }
        let changed = next.size != routes.size;
        if (!changed) {
            for (const [target, route] of next) {
                if (!sameRoute(route, routes.get(target))) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed)
            return false;
        routes = next;
        routeVersion++;
        emitRoutes(Array.from(routes.values()));
        broadcastRoutes();
        return true;
    }
    function advertisedRoutes(entry) {
        const out = [{ targetId: nodeId, cost: 0, path: [nodeId] }];
        for (const route of routes.values()) {
            if (route.path.includes(entry.offer.peerId))
                continue;
            out.push({ targetId: route.targetId, cost: route.cost, path: [...route.path] });
        }
        return out;
    }
    async function sendWire(entry, message) {
        if (entry.state != 'open' || !entry.session)
            return false;
        const generation = entry.generation;
        const session = entry.session;
        try {
            const accepted = await session.send(message);
            if (generation != entry.generation || entry.state != 'open' || entry.session != session)
                return false;
            if (accepted == false)
                throw new Error('transport rejected the packet');
            return true;
        }
        catch (error) {
            if (generation == entry.generation && entry.state == 'open' && entry.session == session)
                failEntry(entry, error);
            return false;
        }
    }
    function sendRoutes(entry) {
        const message = {
            protocol: 1,
            kind: 'routes',
            meshId,
            from: nodeId,
            version: routeVersion,
            routes: advertisedRoutes(entry),
        };
        void sendWire(entry, message);
    }
    function broadcastRoutes() {
        for (const entry of entries.values())
            if (entry.state == 'open')
                sendRoutes(entry);
    }
    function seenKey(originId, packetId) {
        return JSON.stringify([originId, packetId]);
    }
    function remember(originId, packetId) {
        const key = seenKey(originId, packetId);
        seen.delete(key);
        seen.set(key, now());
        while (seen.size > seenLimit)
            seen.delete(seen.keys().next().value);
    }
    function validAdvertisement(route, peerId) {
        return route != null && typeof route.targetId == 'string' && finiteCost(route.cost) &&
            !!route.targetId && Array.isArray(route.path) && route.path.length > 0 && route.path.length <= maxHops &&
            route.path.every(id => typeof id == 'string' && !!id) && route.path[0] == peerId &&
            route.path[route.path.length - 1] == route.targetId && !route.path.includes(nodeId) &&
            new Set(route.path).size == route.path.length;
    }
    function handleRoutes(entry, message) {
        if (message.protocol != 1 || message.meshId != meshId || message.from != entry.offer.peerId ||
            !Number.isInteger(message.version) || message.version < 0 || message.version <= entry.receivedVersion ||
            !Array.isArray(message.routes) || message.routes.length > MAX_ROUTE_ADVERTISEMENTS)
            return;
        const first = entry.receivedVersion < 0;
        entry.receivedVersion = message.version;
        entry.advertisements.clear();
        for (const route of message.routes) {
            if (!validAdvertisement(route, entry.offer.peerId) || route.targetId == nodeId)
                continue;
            entry.advertisements.set(route.targetId, { targetId: route.targetId, cost: route.cost, path: [...route.path] });
        }
        recomputeRoutes();
        if (first)
            sendRoutes(entry);
    }
    async function forward(packet) {
        if (packet.ttl <= 0)
            return { ok: false, packetId: packet.packetId, targetId: packet.targetId, reason: 'ttl' };
        const candidates = routeCandidates(packet.targetId, packet.path, packet.ttl);
        if (!candidates.length) {
            stats.noRoute++;
            return { ok: false, packetId: packet.packetId, targetId: packet.targetId, reason: 'no-route' };
        }
        for (const candidate of candidates) {
            const outgoing = { ...packet, ttl: packet.ttl - 1, path: [...packet.path] };
            if (await sendWire(candidate.entry, outgoing)) {
                return {
                    ok: true,
                    packetId: packet.packetId,
                    targetId: packet.targetId,
                    nextHopId: candidate.route.nextHopId,
                    path: [...candidate.route.path],
                };
            }
        }
        stats.noRoute++;
        return { ok: false, packetId: packet.packetId, targetId: packet.targetId, reason: 'no-route' };
    }
    function validPacket(packet, from) {
        return packet != null && packet.protocol == 1 && packet.kind == 'packet' && packet.meshId == meshId &&
            typeof packet.packetId == 'string' && !!packet.packetId && typeof packet.originId == 'string' &&
            !!packet.originId && typeof packet.targetId == 'string' && !!packet.targetId &&
            Number.isInteger(packet.sequence) && packet.sequence >= 0 && Number.isInteger(packet.ttl) &&
            packet.ttl >= 0 && packet.ttl <= maxHops && Array.isArray(packet.path) &&
            packet.path.length > 0 && packet.path.length <= maxHops &&
            packet.path.every(id => typeof id == 'string' && !!id) && packet.path[0] == packet.originId &&
            packet.path[packet.path.length - 1] == from && new Set(packet.path).size == packet.path.length;
    }
    async function handlePacket(entry, packet) {
        if (!validPacket(packet, entry.offer.peerId) || packet.path.includes(nodeId)) {
            stats.invalid++;
            return;
        }
        if (seen.has(seenKey(packet.originId, packet.packetId))) {
            stats.duplicates++;
            return;
        }
        remember(packet.originId, packet.packetId);
        const arrived = { ...packet, path: [...packet.path, nodeId] };
        const generation = entry.generation;
        if (accept) {
            try {
                if (!(await accept(arrived, entry.offer.peerId))) {
                    stats.rejected++;
                    return;
                }
            }
            catch {
                stats.rejected++;
                return;
            }
        }
        if (closed || generation != entry.generation || entry.state != 'open' || entries.get(entry.offer.id) != entry)
            return;
        if (arrived.targetId == nodeId) {
            stats.delivered++;
            emitPacket(arrived.payload, {
                packetId: arrived.packetId,
                originId: arrived.originId,
                targetId: arrived.targetId,
                sequence: arrived.sequence,
                path: [...arrived.path],
                hops: arrived.path.length - 1,
            });
            return;
        }
        stats.forwarded++;
        await forward(arrived);
    }
    function handleMessage(entry, message) {
        if (message == null || typeof message != 'object') {
            stats.invalid++;
            return;
        }
        if (message.kind == 'routes')
            handleRoutes(entry, message);
        else if (message.kind == 'packet')
            void handlePacket(entry, message);
        else
            stats.invalid++;
    }
    function clearEntrySession(entry) {
        unsubscribeHandle(entry.offMessages);
        unsubscribeHandle(entry.offFail);
        entry.offMessages = null;
        entry.offFail = null;
        closeSession(entry.session);
        entry.session = null;
        entry.advertisements.clear();
        if (entry.probe)
            clearTimeout(entry.probe);
        entry.probe = null;
        entry.rtt = null;
    }
    function scheduleReconnect(entry) {
        if (closed || entry.reconnect || !entries.has(entry.offer.id))
            return;
        entry.reconnect = timer(reconnectMs, function reconnectOffer() {
            entry.reconnect = null;
            connectEntry(entry);
        });
    }
    function failEntry(entry, reason) {
        if (entry.state == 'closed' || entry.state == 'failed')
            return;
        entry.generation++;
        clearEntrySession(entry);
        entry.state = 'failed';
        entry.error = errorText(reason);
        publishStatus();
        recomputeRoutes();
        scheduleReconnect(entry);
    }
    async function probeEntry(entry) {
        if (entry.state != 'open' || !entry.session?.ping)
            return;
        const generation = entry.generation;
        const started = now();
        let timeout = null;
        try {
            await Promise.race([
                Promise.resolve(entry.session.ping()),
                new Promise(function rejectSlowPing(_resolve, reject) {
                    timeout = timer(pingTimeoutMs, function pingTimedOut() { reject(new Error('ping timeout')); });
                }),
            ]);
            if (generation != entry.generation || entry.state != 'open')
                return;
            entry.rtt = Math.max(0, now() - started);
            entry.error = null;
            publishStatus();
            recomputeRoutes();
        }
        catch (error) {
            if (generation == entry.generation)
                failEntry(entry, error);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (generation == entry.generation && entry.state == 'open' && probeIntervalMs > 0) {
                entry.probe = timer(probeIntervalMs, function runNextProbe() {
                    entry.probe = null;
                    void probeEntry(entry);
                });
            }
        }
    }
    function connectEntry(entry) {
        if (closed || entry.state == 'connecting' || entry.state == 'open')
            return;
        if (entry.reconnect)
            clearTimeout(entry.reconnect);
        entry.reconnect = null;
        const generation = ++entry.generation;
        entry.state = 'connecting';
        entry.error = null;
        publishStatus();
        Promise.resolve().then(function connectPacketRoute() {
            return entry.offer.connect();
        }).then(function openPacketRoute(session) {
            if (closed || generation != entry.generation || !entries.has(entry.offer.id)) {
                closeSession(session);
                return;
            }
            try {
                if (!session || typeof session.send != 'function' || typeof session.messages?.on != 'function' ||
                    typeof session.close != 'function')
                    throw new Error('connected session contract is invalid');
                if (session.peerId != entry.offer.peerId) {
                    closeSession(session);
                    failEntry(entry, new Error('connected peer identity mismatch'));
                    return;
                }
                entry.session = session;
                entry.state = 'open';
                entry.error = null;
                entry.receivedVersion = -1;
                const offMessages = session.messages.on(function receivePacketMessage(message) { handleMessage(entry, message); });
                if (generation != entry.generation || entry.state != 'open') {
                    unsubscribeHandle(offMessages);
                    return;
                }
                entry.offMessages = offMessages;
                const offFail = session.onFail?.on(function packetRouteFailed(reason) { failEntry(entry, reason); }) ?? null;
                if (generation != entry.generation || entry.state != 'open') {
                    unsubscribeHandle(offFail);
                    return;
                }
                entry.offFail = offFail;
                publishStatus();
                recomputeRoutes();
                sendRoutes(entry);
                void probeEntry(entry);
            }
            catch (error) {
                if (generation == entry.generation) {
                    entry.session = session;
                    failEntry(entry, error);
                }
                else
                    closeSession(session);
            }
        }, function packetRouteOpenFailed(error) {
            if (generation != entry.generation)
                return;
            entry.state = 'failed';
            entry.error = errorText(error);
            publishStatus();
            recomputeRoutes();
            scheduleReconnect(entry);
        });
    }
    function removeEntry(id) {
        const entry = entries.get(id);
        if (!entry)
            return;
        entries.delete(id);
        entry.generation++;
        if (entry.reconnect)
            clearTimeout(entry.reconnect);
        clearEntrySession(entry);
        entry.state = 'closed';
        publishStatus();
        recomputeRoutes();
    }
    function setOffers(next) {
        const replacements = new Map();
        for (const offer of next) {
            const stored = normalizeOffer(offer);
            if (stored.peerId == nodeId)
                continue;
            replacements.set(stored.id, stored);
        }
        for (const [id, entry] of entries) {
            const replacement = replacements.get(id);
            if (!replacement || replacement.connect != entry.offer.connect || replacement.peerId != entry.offer.peerId ||
                replacement.priority != entry.offer.priority)
                removeEntry(id);
        }
        for (const [id, offer] of replacements) {
            if (entries.has(id))
                continue;
            const entry = createOfferEntry(offer);
            entries.set(id, entry);
            connectEntry(entry);
        }
    }
    async function send(target, payload, opts = {}) {
        const targetId = requiredId(target, 'target id');
        const seq = sequence + 1;
        const packetId = opts.packetId == undefined ? instanceId + ':' + seq : requiredId(opts.packetId, 'packet id');
        if (closed)
            return { ok: false, packetId, targetId, reason: 'rejected' };
        sequence = seq;
        if (seen.has(seenKey(nodeId, packetId)))
            return { ok: false, packetId, targetId, reason: 'rejected' };
        const ttl = opts.ttl == undefined ? maxHops : nonNegativeInteger(opts.ttl, 'ttl');
        const packet = {
            protocol: 1,
            kind: 'packet',
            meshId,
            packetId,
            originId: nodeId,
            targetId,
            sequence: seq,
            ttl: Math.min(ttl, maxHops),
            path: [nodeId],
            payload,
        };
        remember(nodeId, packetId);
        stats.sent++;
        if (targetId == nodeId) {
            stats.delivered++;
            emitPacket(payload, { packetId, originId: nodeId, targetId, sequence: seq, path: [nodeId], hops: 0 });
            return { ok: true, packetId, targetId, path: [nodeId] };
        }
        return forward(packet);
    }
    async function broadcast(targets, payload, opts = {}) {
        const unique = Array.from(new Set(targets.map(target => requiredId(target, 'target id'))));
        return Promise.all(unique.map(function sendBroadcast(target) { return send(target, payload, opts); }));
    }
    const offOfferSource = offerSource.changes.on(function replaceDiscoveredOffers(next) { setOffers(next); });
    setOffers(offerSource.list());
    return {
        nodeId,
        meshId,
        send,
        broadcast,
        packets,
        routes: () => Array.from(routes.values(), route => ({ ...route, path: [...route.path] })),
        routeChanges,
        status: () => Array.from(entries.values(), publicStatus),
        statusChanges,
        stats: () => ({ ...stats }),
        async probe() {
            await Promise.all(Array.from(entries.values(), probeEntry));
        },
        close() {
            if (closed)
                return;
            closed = true;
            unsubscribeHandle(offOfferSource);
            for (const id of Array.from(entries.keys()))
                removeEntry(id);
            packets.close();
            routeChanges.close();
            statusChanges.close();
        },
    };
}
