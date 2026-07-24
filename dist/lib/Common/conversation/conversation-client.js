"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConversationClient = createConversationClient;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const Listen_1 = require("../events/Listen");
const replay_wire_1 = require("../events/replay-wire");
function factIdentity(fact) {
    return fact.namespace + '\u0000' + fact.key;
}
function createConversationClient(deps) {
    const { remote, initial = { conversations: {}, channels: {}, messages: {}, facts: {} }, drain, batch = true } = deps;
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const [emitEvent, events] = (0, Listen_1.listen)();
    const stateSync = (0, store_replay_1.syncStoreReplay)(store, remote.state, { batch });
    const eventSync = (0, replay_wire_1.replaySubscribe)(remote.events, function forwardEvent(event) { emitEvent(event); });
    async function createConversation(input) {
        return remote.createConversation(input);
    }
    async function createChannel(input) {
        return remote.createChannel(input);
    }
    async function postMessage(input) {
        return remote.postMessage(input);
    }
    async function upsertFact(input) {
        return remote.upsertFact(input);
    }
    async function retractFact(input) {
        return remote.retractFact(input);
    }
    function conversations() {
        return Object.values(store.state.conversations).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    function channels(conversationId) {
        return Object.values(store.state.channels)
            .filter(channel => channel.conversationId == conversationId)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    function channelMessages(channelId) {
        return Object.values(store.state.messages)
            .filter(message => message.channelId == channelId)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    function channelFacts(channelId) {
        const channel = store.state.channels[channelId];
        if (!channel)
            return [];
        const visible = new Map();
        if (channel.factMode == 'inherit') {
            for (const fact of Object.values(store.state.facts)) {
                if (fact.conversationId == channel.conversationId && fact.scope.kind == 'conversation')
                    visible.set(factIdentity(fact), fact);
            }
            const path = [];
            const seen = new Set();
            let current = channel;
            while (current && !seen.has(current.id)) {
                seen.add(current.id);
                path.push(current);
                current = current.parent ? store.state.channels[current.parent.channelId] : undefined;
            }
            for (const branch of path.reverse()) {
                for (const fact of Object.values(store.state.facts)) {
                    if (fact.conversationId == channel.conversationId && fact.scope.kind == 'channel' && fact.scope.channelId == branch.id) {
                        visible.set(factIdentity(fact), fact);
                    }
                }
            }
        }
        else {
            for (const fact of Object.values(store.state.facts)) {
                if (fact.conversationId == channel.conversationId && fact.scope.kind == 'channel' && fact.scope.channelId == channel.id) {
                    visible.set(factIdentity(fact), fact);
                }
            }
        }
        return Array.from(visible.values())
            .filter(fact => fact.state == 'active')
            .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    }
    return {
        store,
        events,
        ready: Promise.all([stateSync.ready, eventSync.ready]).then(function readyAfterReplay() { }),
        stateSeq: stateSync.seq,
        stateMode: () => stateSync.mode,
        eventSeq: eventSync.seq,
        createConversation,
        createChannel,
        postMessage,
        upsertFact,
        retractFact,
        conversations,
        channels,
        channelMessages,
        channelFacts,
        close() {
            stateSync();
            eventSync();
            events.close();
        },
    };
}
