"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPeerClient = createPeerClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const replay_wire_1 = require("../events/replay-wire");
const route_coordinator_1 = require("../events/route-coordinator");
const route_signal_webrtc_1 = require("../events/route-signal-webrtc");
function createPeerClient(deps) {
    const { remote, account, initial, rtc, session, accept, policy, peerInitial = () => ({}), history, drain, journal = 'resume', onPublishError, } = deps;
    const repair = deps.repair ?? 'tail';
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const exposed = (0, store_replay_1.exposeStoreReplay)(store, history !== undefined ? { history } : {});
    let repairing = null;
    function repairEnvelopes(from) {
        const line = exposed.replay;
        if (repair == 'tail' && from >= 0) {
            const tail = line.getSince(from);
            if (tail)
                return tail;
            if (journal == 'sacred') {
                throw new Error('peer publish: local journal evicted seq ' + from + ', sacred relay is unrepairable — raise {history}');
            }
        }
        const kf = exposed.replay.keyframe();
        return kf ? [kf] : [];
    }
    async function runRepair(from) {
        for (const env of repairEnvelopes(from)) {
            const res = await remote.publish(env);
            if (res != null && typeof res == 'object') {
                throw new Error('peer publish: repair rejected at relay seq ' + res.seq);
            }
        }
    }
    function queueRepair(from) {
        if (repairing)
            return;
        repairing = runRepair(from)
            .catch(function reportRepairError(e) {
            if (onPublishError)
                onPublishError(e);
            else
                setTimeout(function rethrowRepairError() { throw e; }, 0);
        })
            .finally(() => { repairing = null; });
    }
    function handleVerdict(res) {
        if (res != null && typeof res == 'object' && typeof res.seq == 'number')
            queueRepair(res.seq);
    }
    const offPublish = exposed.replay.line.on(function publishEnvelope(env) {
        Promise.resolve(remote.publish(env)).then(handleVerdict, function onPublishReject(e) {
            onPublishError?.(e);
        });
    });
    const warmup = exposed.replay.keyframe();
    if (warmup)
        Promise.resolve(remote.publish(warmup)).then(handleVerdict, e => onPublishError?.(e));
    async function resync() {
        const node = remote.peers[account];
        const relaySeq = Number(await node?.seq?.() ?? -1);
        const localSeq = exposed.replay.keyframe()?.seq ?? -1;
        if (relaySeq >= localSeq)
            return;
        await runRepair(relaySeq);
    }
    const port = {
        send: env => remote.signal.send(env),
        signals: { on: cb => remote.signal.signals.on(cb) },
    };
    const stopAccept = rtc
        ? (0, route_signal_webrtc_1.acceptWebRtcDirect)({
            port, rtc, self: account,
            serve: () => (0, replay_wire_1.exposeReplay)(exposed.replay),
            ...(accept ? { accept } : {}),
        })
        : null;
    function relayConnector(other) {
        let state = 'idle';
        return {
            info: { label: 'relay', kind: 'relay', ordered: true, reliable: true },
            open() {
                const node = remote.peers[other];
                state = 'open';
                return {
                    line: { on: (cb) => node.line.on(cb) },
                    since: (seq) => node.since(seq),
                    keyframe: () => node.keyframe(),
                    frame: (seq, hint) => node.frame(seq, hint),
                };
            },
            close: () => { state = 'closed'; },
            state: () => state,
        };
    }
    const coord = (0, route_coordinator_1.createRouteCoordinator)({
        ...(policy ? { policy } : {}),
        connect(ref, kind) {
            const other = ref.a == account ? ref.b : ref.a;
            if (kind == 'relay')
                return relayConnector(other);
            if (!rtc)
                throw new Error('peer client: promoteDirect needs an rtc factory (deps.rtc)');
            return (0, route_signal_webrtc_1.createWebRtcConnector)({
                port, rtc, self: account, peer: other, pair: ref.key, session,
            });
        },
    });
    const views = new Map();
    function makeView(other) {
        const link = coord.pair(account, other);
        const mirror = (0, store_1.createStore)(peerInitial(), drain !== undefined ? { drain } : {});
        const sub = link.subscribe(function mirrorPatch(patch) {
            (0, store_1.applyStorePatch)(mirror, patch);
        });
        const view = {
            account: other,
            store: mirror,
            ready: sub.ready,
            seq: sub.seq,
            route: link.label,
            state: link.state,
            promoteDirect: link.promoteDirect,
            reinterposeRelay: link.reinterposeRelay,
            fallback: link.fallback,
            block: link.block,
            close() {
                views.delete(other);
                sub();
                link.close();
            },
        };
        return view;
    }
    function peer(other) {
        const existing = views.get(other);
        if (existing)
            return existing;
        const view = makeView(other);
        views.set(other, view);
        return view;
    }
    return {
        store,
        peer,
        onRoute: coord.onRoute,
        resync,
        close() {
            for (const view of Array.from(views.values()))
                view.close();
            coord.close();
            stopAccept?.();
            offPublish();
            exposed.close();
        },
    };
}
