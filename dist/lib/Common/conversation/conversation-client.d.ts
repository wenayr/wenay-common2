import { StoreDrain } from '../Observe/store';
import { StoreReplayRemote } from '../Observe/store-replay';
import { ReplayRemote } from '../events/replay-wire';
import { Conversation, ConversationChannel, ConversationChannelInput, ConversationCreateInput, ConversationCreateResult, ConversationFact, ConversationFactInput, ConversationFactRetractInput, ConversationMessage, ConversationPostInput, ConversationStore, tConversationEvent } from './conversation-host';
export type ConversationRemote = {
    state: StoreReplayRemote;
    events: ReplayRemote<[tConversationEvent]>;
    createConversation: (input: ConversationCreateInput) => ConversationCreateResult | Promise<ConversationCreateResult>;
    createChannel: (input: ConversationChannelInput) => ConversationChannel | Promise<ConversationChannel>;
    postMessage: (input: ConversationPostInput) => ConversationMessage | Promise<ConversationMessage>;
    upsertFact: (input: ConversationFactInput) => ConversationFact | Promise<ConversationFact>;
    retractFact: (input: ConversationFactRetractInput) => ConversationFact | Promise<ConversationFact>;
};
export type ConversationClientDeps = {
    remote: ConversationRemote;
    initial?: ConversationStore;
    drain?: StoreDrain;
};
export declare function createConversationClient(deps: ConversationClientDeps): {
    store: import("../Observe/store").Store<ConversationStore>;
    events: import("../events/Listen").ListenApi<[tConversationEvent]>;
    ready: Promise<void>;
    stateSeq: () => number;
    stateMode: () => "v2";
    eventSeq: () => number;
    createConversation: (input: ConversationCreateInput) => Promise<ConversationCreateResult>;
    createChannel: (input: ConversationChannelInput) => Promise<ConversationChannel>;
    postMessage: (input: ConversationPostInput) => Promise<ConversationMessage>;
    upsertFact: (input: ConversationFactInput) => Promise<ConversationFact>;
    retractFact: (input: ConversationFactRetractInput) => Promise<ConversationFact>;
    conversations: () => Conversation[];
    channels: (conversationId: string) => ConversationChannel[];
    channelMessages: (channelId: string) => ConversationMessage[];
    channelFacts: (channelId: string) => ConversationFact[];
    close(): void;
};
export type ConversationClient = ReturnType<typeof createConversationClient>;
