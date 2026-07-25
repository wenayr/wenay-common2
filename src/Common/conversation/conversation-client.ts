// =====================================================================
// Conversation client — filtered mirror, semantic events and derived views
// =====================================================================

import {createStore, StoreDrain} from '../Observe/store'
import {StoreReplayRemote, syncStoreReplay} from '../Observe/store-replay'
import {listen as createListenPair} from '../events/Listen'
import {ReplayRemote, replaySubscribe} from '../events/replay-wire'
import {
    Conversation,
    ConversationChannel,
    ConversationChannelInput,
    ConversationCreateInput,
    ConversationCreateResult,
    ConversationFact,
    ConversationFactInput,
    ConversationFactRetractInput,
    ConversationMessage,
    ConversationPostInput,
    ConversationStore,
    tConversationEvent,
} from './conversation-host'

export type ConversationRemote = {
    state: StoreReplayRemote
    events: ReplayRemote<[tConversationEvent]>
    createConversation: (input: ConversationCreateInput) => ConversationCreateResult | Promise<ConversationCreateResult>
    createChannel: (input: ConversationChannelInput) => ConversationChannel | Promise<ConversationChannel>
    postMessage: (input: ConversationPostInput) => ConversationMessage | Promise<ConversationMessage>
    upsertFact: (input: ConversationFactInput) => ConversationFact | Promise<ConversationFact>
    retractFact: (input: ConversationFactRetractInput) => ConversationFact | Promise<ConversationFact>
}

export type ConversationClientDeps = {
    remote: ConversationRemote
    initial?: ConversationStore
    drain?: StoreDrain
}

function factIdentity(fact: ConversationFact) {
    return fact.namespace + '\u0000' + fact.key
}

export function createConversationClient(deps: ConversationClientDeps) {
    const {remote, initial = {conversations: {}, channels: {}, messages: {}, facts: {}}, drain} = deps
    const store = createStore<ConversationStore>(initial, drain !== undefined ? {drain} : {})
    const [emitEvent, events] = createListenPair<[tConversationEvent]>()
    const stateSync = syncStoreReplay(store, remote.state)
    const eventSync = replaySubscribe(remote.events, function forwardEvent(event) { emitEvent(event) })

    async function createConversation(input: ConversationCreateInput) {
        return remote.createConversation(input)
    }

    async function createChannel(input: ConversationChannelInput) {
        return remote.createChannel(input)
    }

    async function postMessage(input: ConversationPostInput) {
        return remote.postMessage(input)
    }

    async function upsertFact(input: ConversationFactInput) {
        return remote.upsertFact(input)
    }

    async function retractFact(input: ConversationFactRetractInput) {
        return remote.retractFact(input)
    }

    function conversations() {
        return Object.values(store.state.conversations).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }

    function channels(conversationId: string) {
        return Object.values(store.state.channels)
            .filter(channel => channel.conversationId == conversationId)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }

    function channelMessages(channelId: string) {
        return Object.values(store.state.messages)
            .filter(message => message.channelId == channelId)
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    }

    function channelFacts(channelId: string) {
        const channel = store.state.channels[channelId]
        if (!channel) return []
        const visible = new Map<string, ConversationFact>()
        if (channel.factMode == 'inherit') {
            for (const fact of Object.values(store.state.facts)) {
                if (fact.conversationId == channel.conversationId && fact.scope.kind == 'conversation') visible.set(factIdentity(fact), fact)
            }
            const path: ConversationChannel[] = []
            const seen = new Set<string>()
            let current: ConversationChannel | undefined = channel
            while (current && !seen.has(current.id)) {
                seen.add(current.id)
                path.push(current)
                current = current.parent ? store.state.channels[current.parent.channelId] : undefined
            }
            for (const branch of path.reverse()) {
                for (const fact of Object.values(store.state.facts)) {
                    if (fact.conversationId == channel.conversationId && fact.scope.kind == 'channel' && fact.scope.channelId == branch.id) {
                        visible.set(factIdentity(fact), fact)
                    }
                }
            }
        } else {
            for (const fact of Object.values(store.state.facts)) {
                if (fact.conversationId == channel.conversationId && fact.scope.kind == 'channel' && fact.scope.channelId == channel.id) {
                    visible.set(factIdentity(fact), fact)
                }
            }
        }
        return Array.from(visible.values())
            .filter(fact => fact.state == 'active')
            .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key))
    }

    return {
        store,
        events,
        ready: Promise.all([stateSync.ready, eventSync.ready]).then(function readyAfterReplay() {}),
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
            stateSync()
            eventSync()
            events.close()
        },
    }
}

export type ConversationClient = ReturnType<typeof createConversationClient>
