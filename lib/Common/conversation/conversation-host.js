"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConversationHost = createConversationHost;
const store_1 = require("../Observe/store");
const store_replay_1 = require("../Observe/store-replay");
const store_projection_1 = require("../Observe/store-projection");
const Listen_1 = require("../events/Listen");
const replay_listen_1 = require("../events/replay-listen");
const replay_wire_1 = require("../events/replay-wire");
const conversation_data_1 = require("./conversation-data");
function requiredString(value, label) {
    if (typeof value != 'string' || !value.trim())
        throw new Error(label + ' is required');
    return value;
}
function copyAuthor(author) {
    return { ...author };
}
function copyScope(scope) {
    return { ...scope };
}
function copySource(source) {
    return { ...source };
}
function copyBlock(block) {
    if (block.kind == 'list')
        return { ...block, items: block.items.map(item => ({ ...item })) };
    if (block.kind == 'table')
        return {
            ...block,
            columns: block.columns.map(column => ({ ...column })),
            rows: block.rows.map(row => (0, conversation_data_1.copyConversationData)(row, 'conversation table row')),
        };
    if (block.kind == 'custom')
        return { ...block, data: (0, conversation_data_1.copyConversationData)(block.data) };
    return { ...block };
}
function copyConversation(conversation) {
    return { ...conversation, participantIds: [...conversation.participantIds] };
}
function copyChannel(channel) {
    return { ...channel, ...(channel.parent ? { parent: { ...channel.parent } } : {}) };
}
function copyMessage(message) {
    return { ...message, author: copyAuthor(message.author), blocks: message.blocks.map(copyBlock) };
}
function copyFact(fact) {
    return {
        ...fact,
        scope: copyScope(fact.scope),
        value: (0, conversation_data_1.copyConversationData)(fact.value, 'conversation fact'),
        provenance: fact.provenance.map(copySource),
    };
}
function emptyStore() {
    return { conversations: {}, channels: {}, messages: {}, facts: {} };
}
function copyStore(source) {
    const result = emptyStore();
    for (const [id, value] of Object.entries(source.conversations))
        result.conversations[id] = copyConversation(value);
    for (const [id, value] of Object.entries(source.channels))
        result.channels[id] = copyChannel(value);
    for (const [id, value] of Object.entries(source.messages))
        result.messages[id] = copyMessage(value);
    for (const [id, value] of Object.entries(source.facts))
        result.facts[id] = copyFact(value);
    return result;
}
function copyMutationEvent(event) {
    if (event.type == 'conversation.created')
        return { ...event, conversation: copyConversation(event.conversation), channel: copyChannel(event.channel) };
    if (event.type == 'channel.created')
        return { ...event, channel: copyChannel(event.channel) };
    if (event.type == 'message.posted')
        return { ...event, message: copyMessage(event.message) };
    return { ...event, fact: copyFact(event.fact) };
}
function validateRevision(value) {
    if (value != null && (!Number.isInteger(value) || value < 0))
        throw new Error('conversation fact: expectedRevision must be a non-negative integer');
}
function validateAuthor(author) {
    if (!author || (author.kind != 'account' && author.kind != 'assistant' && author.kind != 'system'))
        throw new Error('conversation message: invalid author');
    if (author.kind == 'account')
        requiredString(author.account, 'conversation message author account');
    else
        requiredString(author.id, 'conversation message author id');
}
function createConversationHost(deps = {}) {
    const { persistence, policy, history, drain, now = Date.now } = deps;
    const initial = deps.initial?.store ? copyStore(deps.initial.store) : emptyStore();
    const store = (0, store_1.createStore)(initial, drain !== undefined ? { drain } : {});
    const receipts = new Map();
    const factKeys = new Map();
    const views = new Set();
    const [emitEvent, eventLine] = (0, Listen_1.listen)();
    const usedIds = new Set();
    const counters = { conversation: 0, channel: 0, message: 0, block: 0, item: 0, fact: 0 };
    let operationTail = Promise.resolve();
    let closed = false;
    function collectIds() {
        for (const id of Object.keys(store.state.conversations))
            usedIds.add(id);
        for (const id of Object.keys(store.state.channels))
            usedIds.add(id);
        for (const message of Object.values(store.state.messages)) {
            usedIds.add(message.id);
            for (const block of message.blocks) {
                usedIds.add(block.id);
                if (block.kind == 'list')
                    for (const item of block.items)
                        usedIds.add(item.id);
            }
        }
        for (const fact of Object.values(store.state.facts))
            usedIds.add(fact.id);
    }
    function factKey(conversationId, scope, namespace, key) {
        return conversationId + '\u0000' + scope.kind + '\u0000' + (scope.kind == 'channel' ? scope.channelId : '') + '\u0000' + namespace + '\u0000' + key;
    }
    collectIds();
    for (const receipt of deps.initial?.receipts ?? [])
        receipts.set(receipt.account + '\u0000' + receipt.requestId, { ...receipt });
    for (const fact of Object.values(store.state.facts))
        factKeys.set(factKey(fact.conversationId, fact.scope, fact.namespace, fact.key), fact.id);
    function newId(kind) {
        for (let attempt = 0; attempt < 10_000; attempt++) {
            const id = deps.id ? deps.id(kind) : kind + '-' + (++counters[kind]);
            requiredString(id, 'conversation ' + kind + ' id');
            if (usedIds.has(id))
                continue;
            usedIds.add(id);
            return id;
        }
        throw new Error('conversation id factory did not produce a unique ' + kind + ' id');
    }
    function serialize(work) {
        const result = operationTail.then(work, work);
        operationTail = result.then(function operationDone() { }, function operationFailed() { });
        return result;
    }
    function readable(account, conversation) {
        return policy?.canRead ? policy.canRead(account, conversation) : conversation.participantIds.includes(account);
    }
    function writable(account, conversation) {
        return policy?.canWrite ? policy.canWrite(account, conversation) : conversation.participantIds.includes(account);
    }
    function requireConversation(account, conversationId, action) {
        const conversation = store.state.conversations[conversationId];
        if (!conversation || !writable(account, conversation))
            throw new Error('conversation ' + action + ': forbidden or missing');
        if (conversation.state != 'open')
            throw new Error('conversation ' + action + ': conversation is closed');
        return conversation;
    }
    function requireTrustedConversation(conversationId, action) {
        const conversation = store.state.conversations[conversationId];
        if (!conversation)
            throw new Error('conversation ' + action + ': missing');
        if (conversation.state != 'open')
            throw new Error('conversation ' + action + ': conversation is closed');
        return conversation;
    }
    function requireChannel(conversationId, channelId, action) {
        const channel = store.state.channels[channelId];
        if (!channel || channel.conversationId != conversationId)
            throw new Error('conversation ' + action + ': channel is missing');
        if (channel.state != 'open')
            throw new Error('conversation ' + action + ': channel is closed');
        return channel;
    }
    function project(account) {
        const projected = emptyStore();
        for (const [id, conversation] of Object.entries(store.state.conversations)) {
            if (readable(account, conversation))
                projected.conversations[id] = copyConversation(conversation);
        }
        for (const [id, channel] of Object.entries(store.state.channels)) {
            if (projected.conversations[channel.conversationId])
                projected.channels[id] = copyChannel(channel);
        }
        for (const [id, message] of Object.entries(store.state.messages)) {
            if (projected.conversations[message.conversationId])
                projected.messages[id] = copyMessage(message);
        }
        for (const [id, fact] of Object.entries(store.state.facts)) {
            if (projected.conversations[fact.conversationId])
                projected.facts[id] = copyFact(fact);
        }
        return projected;
    }
    function syncEvent(account) {
        const state = project(account);
        return {
            type: 'sync',
            conversations: Object.values(state.conversations),
            channels: Object.values(state.channels),
            messages: Object.values(state.messages),
            facts: Object.values(state.facts),
        };
    }
    function refreshViews(change) {
        if (closed)
            return;
        for (const view of views)
            view.refresh(change);
    }
    const offStore = store.listenPaths().on(refreshViews);
    function createView(account) {
        const state = (0, store_1.createStore)(project(account), drain !== undefined ? { drain } : {});
        const stateReplay = (0, store_replay_1.exposeStoreReplay)(state, history == undefined ? {} : { history });
        const [emitViewEvent, events] = (0, replay_listen_1.replayListen)({
            current: () => [syncEvent(account)],
            history: history ?? 1024,
        });
        const offEvents = eventLine.on(function forwardReadableEvent(event) {
            const conversation = store.state.conversations[event.conversationId];
            if (conversation && readable(account, conversation))
                emitViewEvent(copyMutationEvent(event));
        });
        function refreshChannel(id) {
            const channel = store.state.channels[id];
            const visible = !!channel && !!state.state.conversations[channel.conversationId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'channels', id, {
                exists: visible,
                ...(visible ? { value: copyChannel(channel) } : {}),
            });
        }
        function refreshMessage(id) {
            const message = store.state.messages[id];
            const visible = !!message && !!state.state.conversations[message.conversationId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'messages', id, {
                exists: visible,
                ...(visible ? { value: copyMessage(message) } : {}),
            });
        }
        function refreshFact(id) {
            const fact = store.state.facts[id];
            const visible = !!fact && !!state.state.conversations[fact.conversationId];
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'facts', id, {
                exists: visible,
                ...(visible ? { value: copyFact(fact) } : {}),
            });
        }
        function refreshConversation(id) {
            const conversation = store.state.conversations[id];
            const wasVisible = !!state.state.conversations[id];
            const visible = !!conversation && readable(account, conversation);
            (0, store_projection_1.reconcileStoreProjectionRecord)(state, 'conversations', id, {
                exists: visible,
                ...(visible ? { value: copyConversation(conversation) } : {}),
            });
            if (visible == wasVisible)
                return;
            const channels = visible ? store.state.channels : state.state.channels;
            const messages = visible ? store.state.messages : state.state.messages;
            const facts = visible ? store.state.facts : state.state.facts;
            for (const channel of Object.values(channels))
                if (channel.conversationId == id)
                    refreshChannel(channel.id);
            for (const message of Object.values(messages))
                if (message.conversationId == id)
                    refreshMessage(message.id);
            for (const fact of Object.values(facts))
                if (fact.conversationId == id)
                    refreshFact(fact.id);
        }
        function refreshProjection(change) {
            if (policy?.canRead) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            const changed = (0, store_projection_1.collectStoreProjectionChanges)(change, ['conversations', 'channels', 'messages', 'facts']);
            if (!changed) {
                (0, store_projection_1.reconcileStoreProjection)(state, project(account));
                return;
            }
            for (const id of changed.get('conversations') ?? [])
                refreshConversation(String(id));
            for (const id of changed.get('channels') ?? [])
                refreshChannel(String(id));
            for (const id of changed.get('messages') ?? [])
                refreshMessage(String(id));
            for (const id of changed.get('facts') ?? [])
                refreshFact(String(id));
        }
        let view;
        view = {
            refresh: refreshProjection,
            close() {
                views.delete(view);
                offEvents();
                stateReplay.close();
                events.close();
            },
        };
        return { view, stateReplay, events };
    }
    function createBlock(input) {
        if (!input || input.version != 1)
            throw new Error('conversation block: version 1 is required');
        const id = newId('block');
        if (input.kind == 'text')
            return { id, version: 1, kind: 'text', text: requiredString(input.text, 'conversation text block') };
        if (input.kind == 'list') {
            const style = input.style ?? 'bullet';
            if (style != 'bullet' && style != 'ordered' && style != 'check')
                throw new Error('conversation list block: invalid style');
            if (!Array.isArray(input.items))
                throw new Error('conversation list block: items are required');
            return {
                id, version: 1, kind: 'list', style,
                items: input.items.map(item => ({
                    id: newId('item'),
                    text: requiredString(item?.text, 'conversation list item text'),
                    ...(item.checked != null ? { checked: !!item.checked } : {}),
                })),
            };
        }
        if (input.kind == 'table') {
            if (!Array.isArray(input.columns) || !Array.isArray(input.rows))
                throw new Error('conversation table block: columns and rows are required');
            const columns = input.columns.map(column => ({
                key: requiredString(column?.key, 'conversation table column key'),
                label: requiredString(column?.label, 'conversation table column label'),
            }));
            if (new Set(columns.map(column => column.key)).size != columns.length)
                throw new Error('conversation table block: column keys must be unique');
            const rows = input.rows.map(row => (0, conversation_data_1.copyConversationData)(row, 'conversation table row'));
            return { id, version: 1, kind: 'table', columns, rows };
        }
        if (input.kind == 'fact')
            return { id, version: 1, kind: 'fact', factId: requiredString(input.factId, 'conversation fact block id') };
        if (input.kind == 'resource')
            return {
                id, version: 1, kind: 'resource', resourceId: requiredString(input.resourceId, 'conversation resource block id'),
                ...(input.label != null ? { label: requiredString(input.label, 'conversation resource block label') } : {}),
            };
        if (input.kind == 'artifact')
            return {
                id, version: 1, kind: 'artifact', artifactId: requiredString(input.artifactId, 'conversation artifact block id'),
                ...(input.label != null ? { label: requiredString(input.label, 'conversation artifact block label') } : {}),
            };
        if (input.kind == 'custom')
            return {
                id, version: 1, kind: 'custom', type: requiredString(input.type, 'conversation custom block type'),
                data: (0, conversation_data_1.copyConversationData)(input.data, 'conversation custom block data'),
            };
        throw new Error('conversation block: unsupported kind');
    }
    function receiptKey(account, requestId) {
        return account + '\u0000' + requestId;
    }
    function previousReceipt(account, requestId, command) {
        const previous = receipts.get(receiptKey(account, requestId));
        if (previous && previous.command != command)
            throw new Error('conversation command: requestId was already used for ' + previous.command);
        return previous;
    }
    function makeReceipt(account, requestId, command, entityId) {
        return { account, requestId, command, entityId, createdAt: now() };
    }
    async function commit(event, receipt, apply) {
        await persistence?.commit({ event: copyMutationEvent(event), receipt: { ...receipt } });
        apply();
        receipts.set(receiptKey(receipt.account, receipt.requestId), { ...receipt });
        if (!closed)
            emitEvent(copyMutationEvent(event));
    }
    function requireRequest(input) {
        return requiredString(input?.requestId, 'conversation command requestId');
    }
    async function performCreateConversation(account, input) {
        if (closed)
            throw new Error('conversation host closed');
        requiredString(account, 'conversation account');
        const requestId = requireRequest(input);
        const previous = previousReceipt(account, requestId, 'createConversation');
        if (previous) {
            const conversation = store.state.conversations[previous.entityId];
            const channel = conversation && store.state.channels[conversation.rootChannelId];
            if (!conversation || !channel)
                throw new Error('conversation create: receipt target is missing');
            return { conversation: copyConversation(conversation), channel: copyChannel(channel) };
        }
        requiredString(input.title, 'conversation title');
        if (policy?.canCreate && !policy.canCreate(account, input))
            throw new Error('conversation create: forbidden');
        const participantIds = [];
        for (const participant of [account, ...(input.participantIds ?? [])]) {
            requiredString(participant, 'conversation participant');
            if (!participantIds.includes(participant))
                participantIds.push(participant);
        }
        const createdAt = now();
        const conversationId = newId('conversation');
        const channelId = newId('channel');
        const conversation = {
            id: conversationId, owner: account, title: input.title, participantIds, rootChannelId: channelId,
            state: 'open', createdAt, updatedAt: createdAt,
        };
        const channel = {
            id: channelId, conversationId, title: input.rootTitle ?? 'Main', createdBy: account,
            factMode: 'inherit', state: 'open', createdAt, updatedAt: createdAt,
        };
        const event = { type: 'conversation.created', conversationId, actor: account, requestId, conversation, channel };
        const receipt = makeReceipt(account, requestId, 'createConversation', conversationId);
        await commit(event, receipt, function applyConversation() {
            store.state.conversations[conversationId] = conversation;
            store.state.channels[channelId] = channel;
        });
        return { conversation: copyConversation(conversation), channel: copyChannel(channel) };
    }
    async function performCreateChannel(account, input, trusted = false) {
        if (closed)
            throw new Error('conversation host closed');
        const requestId = requireRequest(input);
        const previous = previousReceipt(account, requestId, 'createChannel');
        if (previous) {
            const channel = store.state.channels[previous.entityId];
            if (!channel)
                throw new Error('conversation channel create: receipt target is missing');
            return copyChannel(channel);
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'channel create')
            : requireConversation(account, input.conversationId, 'channel create');
        requiredString(input.title, 'conversation channel title');
        const factMode = input.factMode ?? 'inherit';
        if (factMode != 'inherit' && factMode != 'isolated')
            throw new Error('conversation channel create: invalid factMode');
        let parent;
        if (input.parentMessageId != null) {
            const message = store.state.messages[input.parentMessageId];
            if (!message || message.conversationId != conversation.id)
                throw new Error('conversation channel create: parent message is missing');
            parent = { channelId: message.channelId, messageId: message.id };
        }
        const createdAt = now();
        const channel = {
            id: newId('channel'), conversationId: conversation.id, title: input.title, createdBy: account,
            ...(parent ? { parent } : {}), factMode, state: 'open', createdAt, updatedAt: createdAt,
        };
        const event = { type: 'channel.created', conversationId: conversation.id, actor: account, requestId, channel };
        const receipt = makeReceipt(account, requestId, 'createChannel', channel.id);
        await commit(event, receipt, function applyChannel() { store.state.channels[channel.id] = channel; });
        return copyChannel(channel);
    }
    async function performPostMessage(account, input, trusted = false) {
        if (closed)
            throw new Error('conversation host closed');
        const requestId = requireRequest(input);
        const previous = previousReceipt(account, requestId, 'postMessage');
        if (previous) {
            const message = store.state.messages[previous.entityId];
            if (!message)
                throw new Error('conversation message post: receipt target is missing');
            return copyMessage(message);
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'message post')
            : requireConversation(account, input.conversationId, 'message post');
        const channel = requireChannel(conversation.id, input.channelId, 'message post');
        validateAuthor(input.author);
        if (!Array.isArray(input.blocks) || input.blocks.length == 0)
            throw new Error('conversation message post: at least one block is required');
        const message = {
            id: newId('message'), conversationId: conversation.id, channelId: channel.id, requestId,
            createdBy: account, author: copyAuthor(input.author), blocks: input.blocks.map(createBlock), createdAt: now(),
        };
        const event = { type: 'message.posted', conversationId: conversation.id, actor: account, requestId, message };
        const receipt = makeReceipt(account, requestId, 'postMessage', message.id);
        await commit(event, receipt, function applyMessage() {
            store.state.messages[message.id] = message;
            channel.updatedAt = message.createdAt;
            conversation.updatedAt = message.createdAt;
        });
        return copyMessage(message);
    }
    function validateFactScope(conversationId, scope) {
        if (!scope || (scope.kind != 'conversation' && scope.kind != 'channel'))
            throw new Error('conversation fact: invalid scope');
        if (scope.kind == 'channel')
            requireChannel(conversationId, scope.channelId, 'fact');
    }
    function factSources(account, conversationId, sourceMessageId, trustedSource) {
        const sources = [{ kind: 'account', account }];
        if (sourceMessageId != null) {
            const message = store.state.messages[sourceMessageId];
            if (!message || message.conversationId != conversationId)
                throw new Error('conversation fact: source message is missing');
            sources.push({ kind: 'message', messageId: message.id });
        }
        if (trustedSource)
            sources.push(copySource(trustedSource));
        return sources;
    }
    async function performUpsertFact(account, input, trusted = false, trustedSource) {
        if (closed)
            throw new Error('conversation host closed');
        const requestId = requireRequest(input);
        const previous = previousReceipt(account, requestId, 'upsertFact');
        if (previous) {
            const fact = store.state.facts[previous.entityId];
            if (!fact)
                throw new Error('conversation fact upsert: receipt target is missing');
            return copyFact(fact);
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'fact upsert')
            : requireConversation(account, input.conversationId, 'fact upsert');
        validateFactScope(conversation.id, input.scope);
        const namespace = requiredString(input.namespace, 'conversation fact namespace');
        const key = requiredString(input.key, 'conversation fact key');
        validateRevision(input.expectedRevision);
        const indexKey = factKey(conversation.id, input.scope, namespace, key);
        const currentId = factKeys.get(indexKey);
        const current = currentId ? store.state.facts[currentId] : undefined;
        const revision = current?.revision ?? 0;
        if (input.expectedRevision != null && input.expectedRevision != revision)
            throw new Error('conversation fact upsert: revision conflict');
        const updatedAt = now();
        const sources = factSources(account, conversation.id, input.sourceMessageId, trustedSource);
        const fact = current ? {
            ...copyFact(current), value: (0, conversation_data_1.copyConversationData)(input.value, 'conversation fact value'), revision: revision + 1,
            state: 'active', provenance: [...current.provenance.map(copySource), ...sources], updatedAt,
        } : {
            id: newId('fact'), conversationId: conversation.id, scope: copyScope(input.scope), namespace, key,
            value: (0, conversation_data_1.copyConversationData)(input.value, 'conversation fact value'), revision: 1, state: 'active',
            provenance: sources, createdBy: account, createdAt: updatedAt, updatedAt,
        };
        const event = { type: 'fact.upserted', conversationId: conversation.id, actor: account, requestId, fact };
        const receipt = makeReceipt(account, requestId, 'upsertFact', fact.id);
        await commit(event, receipt, function applyFact() {
            store.state.facts[fact.id] = fact;
            factKeys.set(indexKey, fact.id);
            conversation.updatedAt = updatedAt;
        });
        return copyFact(fact);
    }
    async function performRetractFact(account, input, trusted = false) {
        if (closed)
            throw new Error('conversation host closed');
        const requestId = requireRequest(input);
        const previous = previousReceipt(account, requestId, 'retractFact');
        if (previous) {
            const fact = store.state.facts[previous.entityId];
            if (!fact)
                throw new Error('conversation fact retract: receipt target is missing');
            return copyFact(fact);
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'fact retract')
            : requireConversation(account, input.conversationId, 'fact retract');
        const current = store.state.facts[input.factId];
        if (!current || current.conversationId != conversation.id)
            throw new Error('conversation fact retract: fact is missing');
        validateRevision(input.expectedRevision);
        if (input.expectedRevision != null && input.expectedRevision != current.revision)
            throw new Error('conversation fact retract: revision conflict');
        const updatedAt = now();
        const fact = {
            ...copyFact(current), revision: current.revision + 1, state: 'retracted',
            provenance: [...current.provenance.map(copySource), { kind: 'account', account }], updatedAt,
        };
        const event = { type: 'fact.retracted', conversationId: conversation.id, actor: account, requestId, fact };
        const receipt = makeReceipt(account, requestId, 'retractFact', fact.id);
        await commit(event, receipt, function applyRetraction() {
            store.state.facts[fact.id] = fact;
            conversation.updatedAt = updatedAt;
        });
        return copyFact(fact);
    }
    function createConversation(account, input) {
        return serialize(() => performCreateConversation(account, input));
    }
    function createChannel(account, input, trusted = false) {
        return serialize(() => performCreateChannel(account, input, trusted));
    }
    function postMessage(account, input) {
        return serialize(() => performPostMessage(account, { ...input, author: { kind: 'account', account } }, false));
    }
    function appendMessage(account, input) {
        return serialize(() => performPostMessage(account, input, true));
    }
    function upsertFact(account, input, trusted = false, source) {
        return serialize(() => performUpsertFact(account, input, trusted, source));
    }
    function retractFact(account, input, trusted = false) {
        return serialize(() => performRetractFact(account, input, trusted));
    }
    function connection(account) {
        if (closed)
            throw new Error('conversation host closed');
        requiredString(account, 'conversation account');
        const { view, stateReplay, events } = createView(account);
        views.add(view);
        let connectionClosed = false;
        return {
            fragment: {
                state: stateReplay.api.replay,
                events: (0, replay_wire_1.exposeReplay)(events),
                createConversation: (input) => createConversation(account, input),
                createChannel: (input) => createChannel(account, input),
                postMessage: (input) => postMessage(account, input),
                upsertFact: (input) => upsertFact(account, input),
                retractFact: (input) => retractFact(account, input),
            },
            close() {
                if (connectionClosed)
                    return;
                connectionClosed = true;
                view.close();
            },
        };
    }
    return {
        control: {
            createConversation,
            createChannel: (account, input) => createChannel(account, input, true),
            appendMessage,
            upsertFact: (account, input, source) => upsertFact(account, input, true, source),
            retractFact: (account, input) => retractFact(account, input, true),
            store,
        },
        connection,
        close() {
            if (closed)
                return;
            closed = true;
            offStore();
            for (const view of Array.from(views))
                view.close();
            eventLine.close();
            receipts.clear();
        },
    };
}
