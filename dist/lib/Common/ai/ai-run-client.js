"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAiRunClient = createAiRunClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const Listen_1 = require("../events/Listen");
const replay_wire_1 = require("../events/replay-wire");
function createAiRunClient(deps) {
    const { remote, initial = { runs: {}, approvals: {}, inputs: {} }, drain } = deps;
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const [emitEvent, events] = (0, Listen_1.listen)();
    const stateSync = (0, store_replay_1.syncStoreReplay)(store, remote.state);
    const eventSync = (0, replay_wire_1.replaySubscribe)(remote.events, function forwardEvent(event) { emitEvent(event); });
    async function capabilities() {
        return remote.capabilities();
    }
    async function createRun(request) {
        return remote.createRun(request);
    }
    async function cancelRun(runId, reason) {
        return remote.cancelRun(runId, reason);
    }
    async function resolveApproval(approvalId, decision) {
        return remote.resolveApproval(approvalId, decision);
    }
    async function provideInput(inputId, value) {
        return remote.provideInput(inputId, value);
    }
    return {
        store,
        events,
        ready: Promise.all([stateSync.ready, eventSync.ready]).then(function readyAfterReplay() { }),
        stateSeq: stateSync.seq,
        eventSeq: eventSync.seq,
        capabilities,
        createRun,
        cancelRun,
        resolveApproval,
        provideInput,
        close() {
            stateSync();
            eventSync();
            events.close();
        },
    };
}
