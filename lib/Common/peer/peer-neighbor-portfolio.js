"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerNeighborPortfolio = createPeerNeighborPortfolio;
const Listen_1 = require("../events/Listen");
const peer_packet_mesh_1 = require("./peer-packet-mesh");
const DEFAULT_WEIGHTS = {
    diversityKey: 4,
    reachability: 2,
    pathDisjointness: 4,
    quality: 1,
};
function finiteNonNegative(value, label) {
    if (typeof value != 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('peer neighbor portfolio: ' + label + ' must be a non-negative finite number');
    }
    return value;
}
function nonNegativeInteger(value, label) {
    finiteNonNegative(value, label);
    if (!Number.isInteger(value))
        throw new Error('peer neighbor portfolio: ' + label + ' must be an integer');
    return value;
}
function requiredId(value, label) {
    if (typeof value != 'string' || !value.trim()) {
        throw new Error('peer neighbor portfolio: ' + label + ' is required');
    }
    return value.trim();
}
function stringSet(values, label) {
    const out = new Set();
    for (const value of values ?? [])
        out.add(requiredId(value, label));
    return out;
}
function normalizeQuality(quality) {
    const rttMs = quality?.rttMs;
    const loss = quality?.loss;
    if (rttMs != undefined)
        finiteNonNegative(rttMs, 'quality.rttMs');
    if (loss != undefined && (typeof loss != 'number' || !Number.isFinite(loss) || loss < 0 || loss > 1)) {
        throw new Error('peer neighbor portfolio: quality.loss must be between 0 and 1');
    }
    return { rttMs, loss };
}
function normalizeCandidate(candidate) {
    const offer = candidate?.offer;
    if (!offer || typeof offer.connect != 'function') {
        throw new Error('peer neighbor portfolio: candidate offer.connect must be a function');
    }
    const id = requiredId(offer.id, 'offer id');
    const peerId = requiredId(offer.peerId, 'peer id');
    if (offer.priority != undefined)
        finiteNonNegative(offer.priority, 'offer priority');
    const degree = candidate.degree == undefined ? undefined : nonNegativeInteger(candidate.degree, 'degree');
    const minDegree = candidate.minDegree == undefined ? undefined : nonNegativeInteger(candidate.minDegree, 'minDegree');
    const paths = (candidate.paths ?? []).map(function normalizePath(path) {
        return Array.from(stringSet(path, 'path node'));
    });
    return {
        offer: { ...offer, id, peerId },
        quality: normalizeQuality(candidate.quality),
        degree,
        minDegree,
        diversityKeys: Array.from(stringSet(candidate.diversityKeys, 'diversity key')),
        reachable: Array.from(stringSet(candidate.reachable, 'reachable node')),
        paths,
    };
}
function sameOffer(a, b) {
    return a.id == b.id && a.peerId == b.peerId && a.priority == b.priority && a.connect == b.connect;
}
function setOverlap(a, b) {
    if (!a.size || !b.size)
        return 0;
    let intersection = 0;
    for (const value of a)
        if (b.has(value))
            intersection++;
    return intersection / (a.size + b.size - intersection);
}
function pathNodes(candidate) {
    const nodes = new Set();
    for (const path of candidate.paths)
        for (const node of path)
            nodes.add(node);
    return nodes;
}
function createPeerNeighborPortfolio(deps) {
    const nodeId = requiredId(deps.nodeId, 'nodeId');
    const budget = nonNegativeInteger(deps.budget ?? 10, 'budget');
    const qualityLinks = nonNegativeInteger(deps.qualityLinks ?? Math.min(3, budget), 'qualityLinks');
    const rescueLinks = nonNegativeInteger(deps.rescueLinks ?? Math.min(1, budget), 'rescueLinks');
    const minDegree = nonNegativeInteger(deps.minDegree ?? 3, 'minDegree');
    const lossPenaltyMs = finiteNonNegative(deps.lossPenaltyMs ?? 1000, 'lossPenaltyMs');
    const unknownRttMs = finiteNonNegative(deps.unknownRttMs ?? 250, 'unknownRttMs');
    const unknownLoss = deps.unknownLoss ?? 0.05;
    if (unknownLoss < 0 || unknownLoss > 1) {
        throw new Error('peer neighbor portfolio: unknownLoss must be between 0 and 1');
    }
    if (qualityLinks > budget)
        throw new Error('peer neighbor portfolio: qualityLinks cannot exceed budget');
    if (rescueLinks > budget)
        throw new Error('peer neighbor portfolio: rescueLinks cannot exceed budget');
    const weights = { ...DEFAULT_WEIGHTS, ...deps.weights };
    for (const [key, value] of Object.entries(weights))
        finiteNonNegative(value, 'weights.' + key);
    const candidates = new Map();
    const selectedOffers = (0, peer_packet_mesh_1.createPeerPacketOffers)();
    const [emitChanges, changes] = (0, Listen_1.listen)();
    let selection = [];
    let selectedCandidates = [];
    let closed = false;
    function defaultQualityCost(candidate) {
        const priority = candidate.offer.priority ?? 0;
        const rtt = candidate.quality.rttMs ?? unknownRttMs;
        const loss = candidate.quality.loss ?? unknownLoss;
        return priority + rtt + loss * lossPenaltyMs;
    }
    function qualityCost(candidate) {
        const cost = deps.qualityCost
            ? deps.qualityCost(candidate)
            : defaultQualityCost(candidate);
        return finiteNonNegative(cost, 'quality cost');
    }
    function degreeDeficit(candidate) {
        if (candidate.degree == undefined)
            return 0;
        return Math.max(0, (candidate.minDegree ?? minDegree) - candidate.degree);
    }
    function compareQuality(a, b) {
        return qualityCost(a) - qualityCost(b) || a.offer.id.localeCompare(b.offer.id);
    }
    function diversityScore(candidate, selected) {
        const usedKeys = new Set();
        const reached = new Set();
        for (const current of selected) {
            for (const key of current.diversityKeys)
                usedKeys.add(key);
            for (const target of current.reachable)
                reached.add(target);
        }
        let newKeys = 0;
        let newReachable = 0;
        for (const key of candidate.diversityKeys)
            if (!usedKeys.has(key))
                newKeys++;
        for (const target of candidate.reachable)
            if (!reached.has(target))
                newReachable++;
        const ownPathNodes = pathNodes(candidate);
        let disjointness = 0;
        let comparisons = 0;
        for (const current of selected) {
            const otherPathNodes = pathNodes(current);
            if (!ownPathNodes.size || !otherPathNodes.size)
                continue;
            disjointness += 1 - setOverlap(ownPathNodes, otherPathNodes);
            comparisons++;
        }
        if (comparisons)
            disjointness /= comparisons;
        const normalizedQuality = 1 / (1 + qualityCost(candidate) / 100);
        return newKeys * weights.diversityKey +
            Math.log2(1 + newReachable) * weights.reachability +
            disjointness * weights.pathDisjointness +
            normalizedQuality * weights.quality;
    }
    function selectCandidate(candidate, role, score, selected, rows) {
        selected.push(candidate);
        rows.push({
            id: candidate.offer.id,
            peerId: candidate.offer.peerId,
            role,
            qualityCost: qualityCost(candidate),
            degreeDeficit: degreeDeficit(candidate),
            diversityScore: score,
        });
    }
    function computeSelection() {
        if (!budget)
            return { selected: [], rows: [] };
        const available = Array.from(candidates.values()).filter(candidate => candidate.offer.peerId != nodeId);
        const selected = [];
        const rows = [];
        available.sort(compareQuality);
        for (const candidate of available.slice(0, qualityLinks)) {
            selectCandidate(candidate, 'quality', 0, selected, rows);
        }
        const selectedIds = new Set(selected.map(candidate => candidate.offer.id));
        let rescued = selected.filter(candidate => degreeDeficit(candidate) > 0).length;
        while (selected.length < budget && rescued < rescueLinks) {
            const rescue = available
                .filter(candidate => !selectedIds.has(candidate.offer.id) && degreeDeficit(candidate) > 0)
                .sort(function compareRescue(a, b) {
                return degreeDeficit(b) - degreeDeficit(a) || compareQuality(a, b);
            })[0];
            if (!rescue)
                break;
            selectCandidate(rescue, 'rescue', 0, selected, rows);
            selectedIds.add(rescue.offer.id);
            rescued++;
        }
        while (selected.length < budget) {
            let best;
            let bestScore = Number.NEGATIVE_INFINITY;
            for (const candidate of available) {
                if (selectedIds.has(candidate.offer.id))
                    continue;
                const score = diversityScore(candidate, selected);
                if (score > bestScore || score == bestScore && best && compareQuality(candidate, best) < 0) {
                    best = candidate;
                    bestScore = score;
                }
            }
            if (!best)
                break;
            selectCandidate(best, 'diversity', bestScore, selected, rows);
            selectedIds.add(best.offer.id);
        }
        return { selected, rows };
    }
    function publishOffers(next) {
        const previous = selectedCandidates;
        const changed = previous.length != next.length || next.some(function offerChanged(candidate, index) {
            return !previous[index] || !sameOffer(previous[index].offer, candidate.offer);
        });
        selectedCandidates = [...next];
        if (changed)
            selectedOffers.control.replace(next.map(candidate => candidate.offer));
    }
    function reconcile() {
        if (closed)
            return;
        const next = computeSelection();
        publishOffers(next.selected);
        selection = next.rows;
        emitChanges(selection.map(row => ({ ...row })));
    }
    function upsert(candidate) {
        if (closed)
            throw new Error('peer neighbor portfolio: closed');
        const stored = normalizeCandidate(candidate);
        candidates.set(stored.offer.id, stored);
        reconcile();
        return function removeThisCandidate() {
            if (candidates.get(stored.offer.id) != stored)
                return;
            candidates.delete(stored.offer.id);
            reconcile();
        };
    }
    function replace(next) {
        if (closed)
            throw new Error('peer neighbor portfolio: closed');
        const normalized = next.map(normalizeCandidate);
        candidates.clear();
        for (const candidate of normalized)
            candidates.set(candidate.offer.id, candidate);
        reconcile();
    }
    replace(deps.initial ?? []);
    return {
        control: {
            upsert,
            remove(id) {
                if (!candidates.delete(id))
                    return false;
                reconcile();
                return true;
            },
            replace,
            sample(id, quality) {
                const candidate = candidates.get(id);
                if (!candidate)
                    return false;
                candidate.quality = normalizeQuality(quality);
                reconcile();
                return true;
            },
            clear() {
                if (!candidates.size)
                    return;
                candidates.clear();
                reconcile();
            },
            reconcile,
        },
        offers: selectedOffers.api,
        view: {
            selected: () => selection.map(row => ({ ...row })),
            candidates: () => Array.from(candidates.values(), candidate => ({
                ...candidate,
                offer: { ...candidate.offer },
                quality: { ...candidate.quality },
                diversityKeys: [...candidate.diversityKeys],
                reachable: [...candidate.reachable],
                paths: candidate.paths.map(path => [...path]),
            })),
        },
        events: { changes },
        close() {
            if (closed)
                return;
            closed = true;
            candidates.clear();
            selection = [];
            selectedCandidates = [];
            selectedOffers.control.clear();
            changes.close();
        },
    };
}
