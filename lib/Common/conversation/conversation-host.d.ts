import { StoreDrain } from '../Observe/store';
import { tConversationData } from './conversation-data';
export type tConversationState = 'open' | 'closed';
export type tConversationFactMode = 'inherit' | 'isolated';
export type tConversationFactState = 'active' | 'retracted';
export type tConversationListStyle = 'bullet' | 'ordered' | 'check';
export type tConversationEntityKind = 'conversation' | 'channel' | 'message' | 'block' | 'item' | 'fact';
export type tConversationCommand = 'createConversation' | 'createChannel' | 'postMessage' | 'upsertFact' | 'retractFact';
export type Conversation = {
    id: string;
    owner: string;
    title: string;
    participantIds: string[];
    rootChannelId: string;
    state: tConversationState;
    createdAt: number;
    updatedAt: number;
};
export type ConversationChannelParent = {
    channelId: string;
    messageId: string;
};
export type ConversationChannel = {
    id: string;
    conversationId: string;
    title: string;
    createdBy: string;
    parent?: ConversationChannelParent;
    factMode: tConversationFactMode;
    state: tConversationState;
    createdAt: number;
    updatedAt: number;
};
export type tConversationAuthor = {
    kind: 'account';
    account: string;
    label?: string;
} | {
    kind: 'assistant';
    id: string;
    label?: string;
} | {
    kind: 'system';
    id: string;
    label?: string;
};
export type ConversationListItem = {
    id: string;
    text: string;
    checked?: boolean;
};
export type ConversationTableColumn = {
    key: string;
    label: string;
};
type ConversationBlockBase = {
    id: string;
    version: 1;
};
export type tConversationBlock = ConversationBlockBase & ({
    kind: 'text';
    text: string;
} | {
    kind: 'list';
    style: tConversationListStyle;
    items: ConversationListItem[];
} | {
    kind: 'table';
    columns: ConversationTableColumn[];
    rows: Array<Record<string, tConversationData>>;
} | {
    kind: 'fact';
    factId: string;
} | {
    kind: 'resource';
    resourceId: string;
    label?: string;
} | {
    kind: 'artifact';
    artifactId: string;
    label?: string;
} | {
    kind: 'custom';
    type: string;
    data: tConversationData;
});
export type ConversationListItemInput = {
    text: string;
    checked?: boolean;
};
export type tConversationBlockInput = {
    kind: 'text';
    version: 1;
    text: string;
} | {
    kind: 'list';
    version: 1;
    style?: tConversationListStyle;
    items: ConversationListItemInput[];
} | {
    kind: 'table';
    version: 1;
    columns: ConversationTableColumn[];
    rows: Array<Record<string, unknown>>;
} | {
    kind: 'fact';
    version: 1;
    factId: string;
} | {
    kind: 'resource';
    version: 1;
    resourceId: string;
    label?: string;
} | {
    kind: 'artifact';
    version: 1;
    artifactId: string;
    label?: string;
} | {
    kind: 'custom';
    version: 1;
    type: string;
    data: unknown;
};
export type ConversationMessage = {
    id: string;
    conversationId: string;
    channelId: string;
    requestId: string;
    createdBy: string;
    author: tConversationAuthor;
    blocks: tConversationBlock[];
    createdAt: number;
};
export type tConversationFactScope = {
    kind: 'conversation';
} | {
    kind: 'channel';
    channelId: string;
};
export type tConversationFactSource = {
    kind: 'account';
    account: string;
} | {
    kind: 'message';
    messageId: string;
} | {
    kind: 'ai-run';
    runId: string;
} | {
    kind: 'system';
    id: string;
};
export type ConversationFact = {
    id: string;
    conversationId: string;
    scope: tConversationFactScope;
    namespace: string;
    key: string;
    value: tConversationData;
    revision: number;
    state: tConversationFactState;
    provenance: tConversationFactSource[];
    createdBy: string;
    createdAt: number;
    updatedAt: number;
};
export type ConversationStore = {
    conversations: Record<string, Conversation>;
    channels: Record<string, ConversationChannel>;
    messages: Record<string, ConversationMessage>;
    facts: Record<string, ConversationFact>;
};
export type ConversationCreateInput = {
    requestId: string;
    title: string;
    participantIds?: string[];
    rootTitle?: string;
};
export type ConversationCreateResult = {
    conversation: Conversation;
    channel: ConversationChannel;
};
export type ConversationChannelInput = {
    requestId: string;
    conversationId: string;
    title: string;
    parentMessageId?: string;
    factMode?: tConversationFactMode;
};
export type ConversationPostInput = {
    requestId: string;
    conversationId: string;
    channelId: string;
    blocks: tConversationBlockInput[];
};
export type ConversationAppendInput = ConversationPostInput & {
    author: tConversationAuthor;
};
export type ConversationFactInput = {
    requestId: string;
    conversationId: string;
    scope: tConversationFactScope;
    namespace: string;
    key: string;
    value: unknown;
    expectedRevision?: number;
    sourceMessageId?: string;
};
export type ConversationFactRetractInput = {
    requestId: string;
    conversationId: string;
    factId: string;
    expectedRevision?: number;
};
export type ConversationReceipt = {
    account: string;
    requestId: string;
    command: tConversationCommand;
    entityId: string;
    createdAt: number;
};
export type tConversationMutationEvent = {
    type: 'conversation.created';
    conversationId: string;
    actor: string;
    requestId: string;
    conversation: Conversation;
    channel: ConversationChannel;
} | {
    type: 'channel.created';
    conversationId: string;
    actor: string;
    requestId: string;
    channel: ConversationChannel;
} | {
    type: 'message.posted';
    conversationId: string;
    actor: string;
    requestId: string;
    message: ConversationMessage;
} | {
    type: 'fact.upserted';
    conversationId: string;
    actor: string;
    requestId: string;
    fact: ConversationFact;
} | {
    type: 'fact.retracted';
    conversationId: string;
    actor: string;
    requestId: string;
    fact: ConversationFact;
};
export type tConversationEvent = {
    type: 'sync';
    conversations: Conversation[];
    channels: ConversationChannel[];
    messages: ConversationMessage[];
    facts: ConversationFact[];
} | tConversationMutationEvent;
export type ConversationPersistencePort = {
    commit(input: {
        event: tConversationMutationEvent;
        receipt: ConversationReceipt;
    }): void | Promise<void>;
};
export type ConversationInitial = {
    store: ConversationStore;
    receipts?: ConversationReceipt[];
};
export type ConversationPolicy = {
    canRead?: (account: string, conversation: Conversation) => boolean;
    canWrite?: (account: string, conversation: Conversation) => boolean;
    canCreate?: (account: string, input: ConversationCreateInput) => boolean;
};
export type ConversationHostDeps = {
    persistence?: ConversationPersistencePort;
    initial?: ConversationInitial;
    policy?: ConversationPolicy;
    id?: (kind: tConversationEntityKind) => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function createConversationHost(deps?: ConversationHostDeps): {
    control: {
        createConversation: (account: string, input: ConversationCreateInput) => Promise<{
            conversation: Conversation;
            channel: ConversationChannel;
        }>;
        createChannel: (account: string, input: ConversationChannelInput) => Promise<ConversationChannel>;
        appendMessage: (account: string, input: ConversationAppendInput) => Promise<ConversationMessage>;
        upsertFact: (account: string, input: ConversationFactInput, source?: tConversationFactSource) => Promise<ConversationFact>;
        retractFact: (account: string, input: ConversationFactRetractInput) => Promise<ConversationFact>;
        store: import("../Observe/store").Store<ConversationStore>;
    };
    connection: (account: string) => {
        fragment: {
            state: (import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]> & {
                batch?: ReturnType<(replay: {
                    emit: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../events/Listen").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../events/Listen").ListenKey): boolean;
                    off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../events/Listen").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../events/Listen").ListenOff;
                }, prepareRead: () => void) => {
                    v2: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        } | undefined;
                    };
                    v3: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        } | undefined;
                    };
                    v4: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        } | undefined;
                    };
                    v5: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        } | undefined;
                    };
                    v6: {
                        line: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        };
                        since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined;
                        keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        } | undefined;
                    };
                    v7: {
                        line: import("../events/Listen").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
                        since: (seq: number, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null;
                        keyframe: (_snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null;
                        frame: (seq: number, hint?: unknown, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[];
                    };
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                    keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatch | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    } | undefined;
                }>;
            }) | {
                describe: () => Record<string, any>;
                line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>]>;
                since: (seq: number) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[] | null;
                keyframe: () => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]> | null;
                frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[import("../Observe/store").StorePatch]>[];
                batch?: ReturnType<(replay: {
                    emit: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>;
                    emitBatch: (events: readonly [readonly import("../Observe/store").StorePatch[]][]) => void;
                    head: () => number;
                    isStale: () => boolean;
                    lastTs: () => number;
                    close: () => void;
                    getSince: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | undefined;
                    line: import("../events/Listen").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>]>;
                    hasKeyframe: boolean;
                    keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    frame: (sinceSeq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[];
                    on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe/store").StorePatch[]]>;
                    once: (cb: import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]>, opts?: {
                        key?: string | symbol;
                        current?: import("../events/Listen").ListenCurrent<[readonly import("../Observe/store").StorePatch[]]> | undefined;
                    }) => () => void;
                    has(key: import("../events/Listen").ListenKey): boolean;
                    off(keyOrCallback: import("../events/Listen").ListenKey | import("../events/Listen").Listener<[readonly import("../Observe/store").StorePatch[]]> | null): void;
                    count(): number;
                    keys(): import("../events/Listen").ListenKey[];
                    isRunning(): boolean;
                    run(): void;
                    onClose(cb: () => void): import("../events/Listen").ListenOff;
                }, prepareRead: () => void) => {
                    v2: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                        } | undefined;
                    };
                    v3: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV3[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV3) => void) => any;
                        } | undefined;
                    };
                    v4: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV4) => void) => any;
                        } | undefined;
                    };
                    v5: {
                        line: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        };
                        since: (seq: number) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined;
                        keyframe: () => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5 | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | Promise<import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../Observe/store-replay-columnar").tStoreReplayWireBatchV5) => void) => any;
                        } | undefined;
                    };
                    v6: {
                        line: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        };
                        since: (seq: number) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined;
                        keyframe: () => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]> | null | undefined> | null | undefined;
                        frame?: ((seq: number, hint?: unknown) => import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | Promise<import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>[] | null | undefined> | null | undefined) | undefined;
                        frameLine?: {
                            on: (cb: (batch: import("../events/replay-listen").ReplayEvent<[readonly import("../Observe/store").StorePatch[]]>) => void) => any;
                        } | undefined;
                    };
                    v7: {
                        line: import("../events/Listen").ListenApi<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[]>;
                        since: (seq: number, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null;
                        keyframe: (_snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null;
                        frame: (seq: number, hint?: unknown, _snapshot?: import("../Observe/store-replay-msgpack").tStoreReplaySchemaKnowledge) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[];
                    };
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined;
                    keyframe: () => import("../Observe/store-replay-codec").tStoreReplayWireBatch | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch | null | undefined> | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatch[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatch) => void) => any;
                    } | undefined;
                }>;
            };
            events: import("../events/replay-wire").ReplayExpose<[tConversationEvent]>;
            createConversation: (input: ConversationCreateInput) => Promise<{
                conversation: Conversation;
                channel: ConversationChannel;
            }>;
            createChannel: (input: ConversationChannelInput) => Promise<ConversationChannel>;
            postMessage: (input: ConversationPostInput) => Promise<ConversationMessage>;
            upsertFact: (input: ConversationFactInput) => Promise<ConversationFact>;
            retractFact: (input: ConversationFactRetractInput) => Promise<ConversationFact>;
        };
        close(): void;
    };
    close(): void;
};
export type ConversationHost = ReturnType<typeof createConversationHost>;
export {};
