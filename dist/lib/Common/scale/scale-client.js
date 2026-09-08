"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClusterClient = createClusterClient;
const node_directory_1 = require("../Observe/node-directory");
const store_replica_set_1 = require("../Observe/store-replica-set");
function createClusterClient(deps) {
    const log = deps.log ?? console.log;
    const label = deps.placement?.label ? deps.placement.label + ' ' : '';
    const rng = deps.placement?.rng;
    const directory = (0, node_directory_1.followNodeDirectory)(deps.roster);
    const balance = deps.placement?.balance;
    const random = rng ?? Math.random;
    let placedNodeId = null;
    function loadOf(view) {
        return Number(view.meta?.['readers'] ?? 0);
    }
    function pickBalanced(views) {
        const eligible = views.filter(view => view.eligible);
        if (eligible.length == 0)
            return null;
        function scoreOf(view) { return loadOf(view) / Math.max(view.weight, 1e-3); }
        const bestScore = Math.min(...eligible.map(scoreOf));
        const tier = eligible.filter(view => scoreOf(view) - bestScore <= 1e-9);
        const bestWeight = Math.max(...tier.map(view => view.weight));
        const finalists = tier.filter(view => view.weight >= bestWeight - 1e-9);
        return finalists[Math.min(finalists.length - 1, Math.floor(random() * finalists.length))];
    }
    let placementSettled = !balance;
    function ensurePlaced() {
        const views = directory.nodes();
        const keepPlaced = placedNodeId != null && views.some(function stillPlaced(view) {
            return view.nodeId == placedNodeId && view.eligible;
        });
        if (keepPlaced && placementSettled)
            return placedNodeId;
        const picked = balance ? pickBalanced(views) : (0, node_directory_1.pickDirectoryNode)(views, rng ? { rng } : {});
        if (keepPlaced && (!picked || picked.nodeId == placedNodeId))
            return placedNodeId;
        const previous = placedNodeId;
        placedNodeId = picked ? picked.nodeId : null;
        if (placedNodeId && placedNodeId != previous) {
            log(`cluster client ${label}placement → ${placedNodeId} (${balance ? 'emptiest' : 'weighted'} pick)`);
        }
        return placedNodeId;
    }
    const offRepick = directory.onNodes(function repickOnRosterChange() { ensurePlaced(); });
    ensurePlaced();
    function priorityOf(view) {
        return view.nodeId == placedNodeId ? 1 : 1000 + (0, node_directory_1.directoryRoutePriority)(view);
    }
    const offers = (0, node_directory_1.directoryReplicaOffers)({
        directory,
        connect: deps.connect,
        priorityOf: deps.placement?.priorityOf ?? priorityOf,
    });
    const { initial, ...coordinates } = deps.line;
    const client = (0, store_replica_set_1.createStoreReplicaSet)({
        ...coordinates,
        lineId: coordinates.lineId ?? coordinates.nodeId + '-line',
        initial,
        leadership: deps.leadership ?? { initialRole: 'follower', eligible: false },
        offers: offers.api,
    });
    if (!placementSettled)
        void client.api.ready.then(function settlePlacement() { placementSettled = true; });
    function repick() {
        placedNodeId = null;
        const picked = ensurePlaced();
        offers.refresh();
        return picked;
    }
    let lastMoveAt = 0;
    function evaluateBalance() {
        if (!balance || placedNodeId == null)
            return;
        const now = Date.now();
        if (now - lastMoveAt < (balance.cooldownMs ?? 10_000))
            return;
        const views = directory.nodes().filter(view => view.eligible);
        if (views.length < 2)
            return;
        const placed = views.find(view => view.nodeId == placedNodeId);
        if (!placed)
            return;
        const totalLoad = views.reduce((sum, view) => sum + loadOf(view), 0);
        const totalWeight = views.reduce((sum, view) => sum + Math.max(view.weight, 0), 0);
        if (totalWeight <= 0 || totalLoad == 0)
            return;
        function shareOf(view) {
            return Math.max(totalLoad * Math.max(view.weight, 0) / totalWeight, 0.5);
        }
        const placedLoad = loadOf(placed);
        const threshold = (balance.aboveShare ?? 2) * shareOf(placed);
        if (placedLoad < threshold)
            return;
        const target = pickBalanced(views.filter(view => view.nodeId != placedNodeId));
        if (!target || loadOf(target) >= (balance.belowShare ?? 0.6) * shareOf(target))
            return;
        if (placedLoad == threshold && (loadOf(target) + 1) / target.weight >= placedLoad / placed.weight)
            return;
        if (random() > (balance.moveChance ?? 0.5))
            return;
        lastMoveAt = now;
        log(`cluster client ${label}rebalance ${placedNodeId} → ${target.nodeId} (load ${loadOf(placed)} above fair share)`);
        placedNodeId = target.nodeId;
        offers.refresh();
    }
    const balanceTimer = balance ? setInterval(evaluateBalance, balance.checkMs ?? 4000) : null;
    if (balanceTimer)
        balanceTimer.unref?.();
    function close() {
        if (balanceTimer)
            clearInterval(balanceTimer);
        client.close();
        offers.close();
        offRepick();
        directory.close();
    }
    return {
        store: client.api.store,
        status: client.api.status,
        ready: client.api.ready,
        placement: {
            placedNodeId: () => placedNodeId,
            repick,
        },
        view: {
            nodes: () => directory.nodes(),
            route: () => client.api.status.state.routeId,
            roster: () => directory.status.state,
        },
        close,
    };
}
