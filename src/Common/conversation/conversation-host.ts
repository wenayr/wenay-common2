// =====================================================================
// Conversation host — authorized channels, messages and scoped facts
// =====================================================================

import {createStore, StoreChange, StoreDrain} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'
import {
    collectStoreProjectionChanges,
    reconcileStoreProjection,
    reconcileStoreProjectionRecord,
} from '../Observe/store-projection'
import {listen as createListenPair} from '../events/Listen'
import {replayListen} from '../events/replay-listen'
import {exposeReplay} from '../events/replay-wire'
import {copyConversationData, tConversationData} from './conversation-data'

export type tConversationState = 'open' | 'closed'
export type tConversationFactMode = 'inherit' | 'isolated'
export type tConversationFactState = 'active' | 'retracted'
export type tConversationListStyle = 'bullet' | 'ordered' | 'check'
export type tConversationEntityKind = 'conversation' | 'channel' | 'message' | 'block' | 'item' | 'fact'
export type tConversationCommand = 'createConversation' | 'createChannel' | 'postMessage' | 'upsertFact' | 'retractFact'

export type Conversation = {
    id: string
    owner: string
    title: string
    participantIds: string[]
    rootChannelId: string
    state: tConversationState
    createdAt: number
    updatedAt: number
}

export type ConversationChannelParent = {
    channelId: string
    messageId: string
}

export type ConversationChannel = {
    id: string
    conversationId: string
    title: string
    createdBy: string
    parent?: ConversationChannelParent
    factMode: tConversationFactMode
    state: tConversationState
    createdAt: number
    updatedAt: number
}

export type tConversationAuthor =
    | {kind: 'account', account: string, label?: string}
    | {kind: 'assistant', id: string, label?: string}
    | {kind: 'system', id: string, label?: string}

export type ConversationListItem = {
    id: string
    text: string
    checked?: boolean
}

export type ConversationTableColumn = {
    key: string
    label: string
}

type ConversationBlockBase = {
    id: string
    version: 1
}

export type tConversationBlock = ConversationBlockBase & (
    | {kind: 'text', text: string}
    | {kind: 'list', style: tConversationListStyle, items: ConversationListItem[]}
    | {kind: 'table', columns: ConversationTableColumn[], rows: Array<Record<string, tConversationData>>}
    | {kind: 'fact', factId: string}
    | {kind: 'resource', resourceId: string, label?: string}
    | {kind: 'artifact', artifactId: string, label?: string}
    | {kind: 'custom', type: string, data: tConversationData}
)

export type ConversationListItemInput = {
    text: string
    checked?: boolean
}

export type tConversationBlockInput =
    | {kind: 'text', version: 1, text: string}
    | {kind: 'list', version: 1, style?: tConversationListStyle, items: ConversationListItemInput[]}
    | {kind: 'table', version: 1, columns: ConversationTableColumn[], rows: Array<Record<string, unknown>>}
    | {kind: 'fact', version: 1, factId: string}
    | {kind: 'resource', version: 1, resourceId: string, label?: string}
    | {kind: 'artifact', version: 1, artifactId: string, label?: string}
    | {kind: 'custom', version: 1, type: string, data: unknown}

export type ConversationMessage = {
    id: string
    conversationId: string
    channelId: string
    requestId: string
    createdBy: string
    author: tConversationAuthor
    blocks: tConversationBlock[]
    createdAt: number
}

export type tConversationFactScope =
    | {kind: 'conversation'}
    | {kind: 'channel', channelId: string}

export type tConversationFactSource =
    | {kind: 'account', account: string}
    | {kind: 'message', messageId: string}
    | {kind: 'ai-run', runId: string}
    | {kind: 'system', id: string}

export type ConversationFact = {
    id: string
    conversationId: string
    scope: tConversationFactScope
    namespace: string
    key: string
    value: tConversationData
    revision: number
    state: tConversationFactState
    provenance: tConversationFactSource[]
    createdBy: string
    createdAt: number
    updatedAt: number
}

export type ConversationStore = {
    conversations: Record<string, Conversation>
    channels: Record<string, ConversationChannel>
    messages: Record<string, ConversationMessage>
    facts: Record<string, ConversationFact>
}

export type ConversationCreateInput = {
    requestId: string
    title: string
    participantIds?: string[]
    rootTitle?: string
}

export type ConversationCreateResult = {
    conversation: Conversation
    channel: ConversationChannel
}

export type ConversationChannelInput = {
    requestId: string
    conversationId: string
    title: string
    parentMessageId?: string
    factMode?: tConversationFactMode
}

export type ConversationPostInput = {
    requestId: string
    conversationId: string
    channelId: string
    blocks: tConversationBlockInput[]
}

export type ConversationAppendInput = ConversationPostInput & {
    author: tConversationAuthor
}

export type ConversationFactInput = {
    requestId: string
    conversationId: string
    scope: tConversationFactScope
    namespace: string
    key: string
    value: unknown
    expectedRevision?: number
    sourceMessageId?: string
}

export type ConversationFactRetractInput = {
    requestId: string
    conversationId: string
    factId: string
    expectedRevision?: number
}

export type ConversationReceipt = {
    account: string
    requestId: string
    command: tConversationCommand
    entityId: string
    createdAt: number
}

export type tConversationMutationEvent =
    | {type: 'conversation.created', conversationId: string, actor: string, requestId: string, conversation: Conversation, channel: ConversationChannel}
    | {type: 'channel.created', conversationId: string, actor: string, requestId: string, channel: ConversationChannel}
    | {type: 'message.posted', conversationId: string, actor: string, requestId: string, message: ConversationMessage}
    | {type: 'fact.upserted', conversationId: string, actor: string, requestId: string, fact: ConversationFact}
    | {type: 'fact.retracted', conversationId: string, actor: string, requestId: string, fact: ConversationFact}

export type tConversationEvent =
    | {type: 'sync', conversations: Conversation[], channels: ConversationChannel[], messages: ConversationMessage[], facts: ConversationFact[]}
    | tConversationMutationEvent

export type ConversationPersistencePort = {
    /** Atomically persist the semantic mutation and its account-scoped idempotency receipt. */
    commit(input: {event: tConversationMutationEvent, receipt: ConversationReceipt}): void | Promise<void>
}

export type ConversationInitial = {
    store: ConversationStore
    receipts?: ConversationReceipt[]
}

export type ConversationPolicy = {
    canRead?: (account: string, conversation: Conversation) => boolean
    canWrite?: (account: string, conversation: Conversation) => boolean
    canCreate?: (account: string, input: ConversationCreateInput) => boolean
}

export type ConversationHostDeps = {
    persistence?: ConversationPersistencePort
    initial?: ConversationInitial
    policy?: ConversationPolicy
    id?: (kind: tConversationEntityKind) => string
    now?: () => number
    history?: number
    drain?: StoreDrain
}

type ConversationView = {
    refresh: (change: StoreChange) => void
    close: () => void
}

function requiredString(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error(label + ' is required')
    return value
}

function copyAuthor(author: tConversationAuthor): tConversationAuthor {
    return {...author}
}

function copyScope(scope: tConversationFactScope): tConversationFactScope {
    return {...scope}
}

function copySource(source: tConversationFactSource): tConversationFactSource {
    return {...source}
}

function copyBlock(block: tConversationBlock): tConversationBlock {
    if (block.kind == 'list') return {...block, items: block.items.map(item => ({...item}))}
    if (block.kind == 'table') return {
        ...block,
        columns: block.columns.map(column => ({...column})),
        rows: block.rows.map(row => copyConversationData(row, 'conversation table row') as Record<string, tConversationData>),
    }
    if (block.kind == 'custom') return {...block, data: copyConversationData(block.data)}
    return {...block}
}

function copyConversation(conversation: Conversation): Conversation {
    return {...conversation, participantIds: [...conversation.participantIds]}
}

function copyChannel(channel: ConversationChannel): ConversationChannel {
    return {...channel, ...(channel.parent ? {parent: {...channel.parent}} : {})}
}

function copyMessage(message: ConversationMessage): ConversationMessage {
    return {...message, author: copyAuthor(message.author), blocks: message.blocks.map(copyBlock)}
}

function copyFact(fact: ConversationFact): ConversationFact {
    return {
        ...fact,
        scope: copyScope(fact.scope),
        value: copyConversationData(fact.value, 'conversation fact'),
        provenance: fact.provenance.map(copySource),
    }
}

function emptyStore(): ConversationStore {
    return {conversations: {}, channels: {}, messages: {}, facts: {}}
}

function copyStore(source: ConversationStore): ConversationStore {
    const result = emptyStore()
    for (const [id, value] of Object.entries(source.conversations)) result.conversations[id] = copyConversation(value)
    for (const [id, value] of Object.entries(source.channels)) result.channels[id] = copyChannel(value)
    for (const [id, value] of Object.entries(source.messages)) result.messages[id] = copyMessage(value)
    for (const [id, value] of Object.entries(source.facts)) result.facts[id] = copyFact(value)
    return result
}

function copyMutationEvent(event: tConversationMutationEvent): tConversationMutationEvent {
    if (event.type == 'conversation.created') return {...event, conversation: copyConversation(event.conversation), channel: copyChannel(event.channel)}
    if (event.type == 'channel.created') return {...event, channel: copyChannel(event.channel)}
    if (event.type == 'message.posted') return {...event, message: copyMessage(event.message)}
    return {...event, fact: copyFact(event.fact)}
}

function validateRevision(value: number | undefined) {
    if (value != null && (!Number.isInteger(value) || value < 0)) throw new Error('conversation fact: expectedRevision must be a non-negative integer')
}

function validateAuthor(author: tConversationAuthor) {
    if (!author || (author.kind != 'account' && author.kind != 'assistant' && author.kind != 'system')) throw new Error('conversation message: invalid author')
    if (author.kind == 'account') requiredString(author.account, 'conversation message author account')
    else requiredString(author.id, 'conversation message author id')
}

export function createConversationHost(deps: ConversationHostDeps = {}) {
    const {persistence, policy, history, drain, now = Date.now} = deps
    const initial = deps.initial?.store ? copyStore(deps.initial.store) : emptyStore()
    const store = createStore<ConversationStore>(initial, drain !== undefined ? {drain} : {})
    const receipts = new Map<string, ConversationReceipt>()
    const factKeys = new Map<string, string>()
    const views = new Set<ConversationView>()
    const [emitEvent, eventLine] = createListenPair<[tConversationMutationEvent]>()
    const usedIds = new Set<string>()
    const counters: Record<tConversationEntityKind, number> = {conversation: 0, channel: 0, message: 0, block: 0, item: 0, fact: 0}
    let operationTail = Promise.resolve()
    let closed = false

    function collectIds() {
        for (const id of Object.keys(store.state.conversations)) usedIds.add(id)
        for (const id of Object.keys(store.state.channels)) usedIds.add(id)
        for (const message of Object.values(store.state.messages)) {
            usedIds.add(message.id)
            for (const block of message.blocks) {
                usedIds.add(block.id)
                if (block.kind == 'list') for (const item of block.items) usedIds.add(item.id)
            }
        }
        for (const fact of Object.values(store.state.facts)) usedIds.add(fact.id)
    }

    function factKey(conversationId: string, scope: tConversationFactScope, namespace: string, key: string) {
        return conversationId + '\u0000' + scope.kind + '\u0000' + (scope.kind == 'channel' ? scope.channelId : '') + '\u0000' + namespace + '\u0000' + key
    }

    collectIds()
    for (const receipt of deps.initial?.receipts ?? []) receipts.set(receipt.account + '\u0000' + receipt.requestId, {...receipt})
    for (const fact of Object.values(store.state.facts)) factKeys.set(factKey(fact.conversationId, fact.scope, fact.namespace, fact.key), fact.id)

    function newId(kind: tConversationEntityKind) {
        for (let attempt = 0; attempt < 10_000; attempt++) {
            const id = deps.id ? deps.id(kind) : kind + '-' + (++counters[kind])
            requiredString(id, 'conversation ' + kind + ' id')
            if (usedIds.has(id)) continue
            usedIds.add(id)
            return id
        }
        throw new Error('conversation id factory did not produce a unique ' + kind + ' id')
    }

    function serialize<T>(work: () => Promise<T>) {
        const result = operationTail.then(work, work)
        operationTail = result.then(function operationDone() {}, function operationFailed() {})
        return result
    }

    // === Business policy ===

    function readable(account: string, conversation: Conversation) {
        return policy?.canRead ? policy.canRead(account, conversation) : conversation.participantIds.includes(account)
    }

    function writable(account: string, conversation: Conversation) {
        return policy?.canWrite ? policy.canWrite(account, conversation) : conversation.participantIds.includes(account)
    }

    function requireConversation(account: string, conversationId: string, action: string) {
        const conversation = store.state.conversations[conversationId]
        if (!conversation || !writable(account, conversation)) throw new Error('conversation ' + action + ': forbidden or missing')
        if (conversation.state != 'open') throw new Error('conversation ' + action + ': conversation is closed')
        return conversation
    }

    function requireTrustedConversation(conversationId: string, action: string) {
        const conversation = store.state.conversations[conversationId]
        if (!conversation) throw new Error('conversation ' + action + ': missing')
        if (conversation.state != 'open') throw new Error('conversation ' + action + ': conversation is closed')
        return conversation
    }

    function requireChannel(conversationId: string, channelId: string, action: string) {
        const channel = store.state.channels[channelId]
        if (!channel || channel.conversationId != conversationId) throw new Error('conversation ' + action + ': channel is missing')
        if (channel.state != 'open') throw new Error('conversation ' + action + ': channel is closed')
        return channel
    }

    function project(account: string): ConversationStore {
        const projected = emptyStore()
        for (const [id, conversation] of Object.entries(store.state.conversations)) {
            if (readable(account, conversation)) projected.conversations[id] = copyConversation(conversation)
        }
        for (const [id, channel] of Object.entries(store.state.channels)) {
            if (projected.conversations[channel.conversationId]) projected.channels[id] = copyChannel(channel)
        }
        for (const [id, message] of Object.entries(store.state.messages)) {
            if (projected.conversations[message.conversationId]) projected.messages[id] = copyMessage(message)
        }
        for (const [id, fact] of Object.entries(store.state.facts)) {
            if (projected.conversations[fact.conversationId]) projected.facts[id] = copyFact(fact)
        }
        return projected
    }

    function syncEvent(account: string): tConversationEvent {
        const state = project(account)
        return {
            type: 'sync',
            conversations: Object.values(state.conversations),
            channels: Object.values(state.channels),
            messages: Object.values(state.messages),
            facts: Object.values(state.facts),
        }
    }

    function refreshViews(change: StoreChange) {
        if (closed) return
        for (const view of views) view.refresh(change)
    }

    const offStore = store.listenPaths().on(refreshViews)

    function createView(account: string) {
        const state = createStore<ConversationStore>(project(account), drain !== undefined ? {drain} : {})
        const stateReplay = exposeStoreReplay(state, history == undefined ? {} : {history})
        const [emitViewEvent, events] = replayListen<[tConversationEvent]>({
            current: () => [syncEvent(account)],
            history: history ?? 1024,
        })
        const offEvents = eventLine.on(function forwardReadableEvent(event) {
            const conversation = store.state.conversations[event.conversationId]
            if (conversation && readable(account, conversation)) emitViewEvent(copyMutationEvent(event))
        })
        function refreshChannel(id: string) {
            const channel = store.state.channels[id]
            const visible = !!channel && !!state.state.conversations[channel.conversationId]
            reconcileStoreProjectionRecord(state, 'channels', id, {
                exists: visible,
                ...(visible ? {value: copyChannel(channel!)} : {}),
            })
        }
        function refreshMessage(id: string) {
            const message = store.state.messages[id]
            const visible = !!message && !!state.state.conversations[message.conversationId]
            reconcileStoreProjectionRecord(state, 'messages', id, {
                exists: visible,
                ...(visible ? {value: copyMessage(message!)} : {}),
            })
        }
        function refreshFact(id: string) {
            const fact = store.state.facts[id]
            const visible = !!fact && !!state.state.conversations[fact.conversationId]
            reconcileStoreProjectionRecord(state, 'facts', id, {
                exists: visible,
                ...(visible ? {value: copyFact(fact!)} : {}),
            })
        }
        function refreshConversation(id: string) {
            const conversation = store.state.conversations[id]
            const wasVisible = !!state.state.conversations[id]
            const visible = !!conversation && readable(account, conversation)
            reconcileStoreProjectionRecord(state, 'conversations', id, {
                exists: visible,
                ...(visible ? {value: copyConversation(conversation!)} : {}),
            })
            if (visible == wasVisible) return
            const channels = visible ? store.state.channels : state.state.channels
            const messages = visible ? store.state.messages : state.state.messages
            const facts = visible ? store.state.facts : state.state.facts
            for (const channel of Object.values(channels)) if (channel.conversationId == id) refreshChannel(channel.id)
            for (const message of Object.values(messages)) if (message.conversationId == id) refreshMessage(message.id)
            for (const fact of Object.values(facts)) if (fact.conversationId == id) refreshFact(fact.id)
        }
        function refreshProjection(change: StoreChange) {
            // A custom policy may close over tenant membership outside the changed record.
            if (policy?.canRead) { reconcileStoreProjection(state, project(account)); return }
            const changed = collectStoreProjectionChanges(change, ['conversations', 'channels', 'messages', 'facts'])
            if (!changed) { reconcileStoreProjection(state, project(account)); return }
            for (const id of changed.get('conversations') ?? []) refreshConversation(String(id))
            for (const id of changed.get('channels') ?? []) refreshChannel(String(id))
            for (const id of changed.get('messages') ?? []) refreshMessage(String(id))
            for (const id of changed.get('facts') ?? []) refreshFact(String(id))
        }
        let view: ConversationView
        view = {
            refresh: refreshProjection,
            close() {
                views.delete(view)
                offEvents()
                stateReplay.close()
                events.close()
            },
        }
        return {view, stateReplay, events}
    }

    // === Data construction ===

    function createBlock(input: tConversationBlockInput): tConversationBlock {
        if (!input || input.version != 1) throw new Error('conversation block: version 1 is required')
        const id = newId('block')
        if (input.kind == 'text') return {id, version: 1, kind: 'text', text: requiredString(input.text, 'conversation text block')}
        if (input.kind == 'list') {
            const style = input.style ?? 'bullet'
            if (style != 'bullet' && style != 'ordered' && style != 'check') throw new Error('conversation list block: invalid style')
            if (!Array.isArray(input.items)) throw new Error('conversation list block: items are required')
            return {
                id, version: 1, kind: 'list', style,
                items: input.items.map(item => ({
                    id: newId('item'),
                    text: requiredString(item?.text, 'conversation list item text'),
                    ...(item.checked != null ? {checked: !!item.checked} : {}),
                })),
            }
        }
        if (input.kind == 'table') {
            if (!Array.isArray(input.columns) || !Array.isArray(input.rows)) throw new Error('conversation table block: columns and rows are required')
            const columns = input.columns.map(column => ({
                key: requiredString(column?.key, 'conversation table column key'),
                label: requiredString(column?.label, 'conversation table column label'),
            }))
            if (new Set(columns.map(column => column.key)).size != columns.length) throw new Error('conversation table block: column keys must be unique')
            const rows = input.rows.map(row => copyConversationData(row, 'conversation table row') as Record<string, tConversationData>)
            return {id, version: 1, kind: 'table', columns, rows}
        }
        if (input.kind == 'fact') return {id, version: 1, kind: 'fact', factId: requiredString(input.factId, 'conversation fact block id')}
        if (input.kind == 'resource') return {
            id, version: 1, kind: 'resource', resourceId: requiredString(input.resourceId, 'conversation resource block id'),
            ...(input.label != null ? {label: requiredString(input.label, 'conversation resource block label')} : {}),
        }
        if (input.kind == 'artifact') return {
            id, version: 1, kind: 'artifact', artifactId: requiredString(input.artifactId, 'conversation artifact block id'),
            ...(input.label != null ? {label: requiredString(input.label, 'conversation artifact block label')} : {}),
        }
        if (input.kind == 'custom') return {
            id, version: 1, kind: 'custom', type: requiredString(input.type, 'conversation custom block type'),
            data: copyConversationData(input.data, 'conversation custom block data'),
        }
        throw new Error('conversation block: unsupported kind')
    }

    function receiptKey(account: string, requestId: string) {
        return account + '\u0000' + requestId
    }

    function previousReceipt(account: string, requestId: string, command: tConversationCommand) {
        const previous = receipts.get(receiptKey(account, requestId))
        if (previous && previous.command != command) throw new Error('conversation command: requestId was already used for ' + previous.command)
        return previous
    }

    function makeReceipt(account: string, requestId: string, command: tConversationCommand, entityId: string): ConversationReceipt {
        return {account, requestId, command, entityId, createdAt: now()}
    }

    async function commit(event: tConversationMutationEvent, receipt: ConversationReceipt, apply: () => void) {
        await persistence?.commit({event: copyMutationEvent(event), receipt: {...receipt}})
        apply()
        receipts.set(receiptKey(receipt.account, receipt.requestId), {...receipt})
        if (!closed) emitEvent(copyMutationEvent(event))
    }

    function requireRequest(input: {requestId: string}) {
        return requiredString(input?.requestId, 'conversation command requestId')
    }

    // === Serialized commands ===

    async function performCreateConversation(account: string, input: ConversationCreateInput) {
        if (closed) throw new Error('conversation host closed')
        requiredString(account, 'conversation account')
        const requestId = requireRequest(input)
        const previous = previousReceipt(account, requestId, 'createConversation')
        if (previous) {
            const conversation = store.state.conversations[previous.entityId]
            const channel = conversation && store.state.channels[conversation.rootChannelId]
            if (!conversation || !channel) throw new Error('conversation create: receipt target is missing')
            return {conversation: copyConversation(conversation), channel: copyChannel(channel)}
        }
        requiredString(input.title, 'conversation title')
        if (policy?.canCreate && !policy.canCreate(account, input)) throw new Error('conversation create: forbidden')
        const participantIds: string[] = []
        for (const participant of [account, ...(input.participantIds ?? [])]) {
            requiredString(participant, 'conversation participant')
            if (!participantIds.includes(participant)) participantIds.push(participant)
        }
        const createdAt = now()
        const conversationId = newId('conversation')
        const channelId = newId('channel')
        const conversation: Conversation = {
            id: conversationId, owner: account, title: input.title, participantIds, rootChannelId: channelId,
            state: 'open', createdAt, updatedAt: createdAt,
        }
        const channel: ConversationChannel = {
            id: channelId, conversationId, title: input.rootTitle ?? 'Main', createdBy: account,
            factMode: 'inherit', state: 'open', createdAt, updatedAt: createdAt,
        }
        const event: tConversationMutationEvent = {type: 'conversation.created', conversationId, actor: account, requestId, conversation, channel}
        const receipt = makeReceipt(account, requestId, 'createConversation', conversationId)
        await commit(event, receipt, function applyConversation() {
            store.state.conversations[conversationId] = conversation
            store.state.channels[channelId] = channel
        })
        return {conversation: copyConversation(conversation), channel: copyChannel(channel)}
    }

    async function performCreateChannel(account: string, input: ConversationChannelInput, trusted = false) {
        if (closed) throw new Error('conversation host closed')
        const requestId = requireRequest(input)
        const previous = previousReceipt(account, requestId, 'createChannel')
        if (previous) {
            const channel = store.state.channels[previous.entityId]
            if (!channel) throw new Error('conversation channel create: receipt target is missing')
            return copyChannel(channel)
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'channel create')
            : requireConversation(account, input.conversationId, 'channel create')
        requiredString(input.title, 'conversation channel title')
        const factMode = input.factMode ?? 'inherit'
        if (factMode != 'inherit' && factMode != 'isolated') throw new Error('conversation channel create: invalid factMode')
        let parent: ConversationChannelParent | undefined
        if (input.parentMessageId != null) {
            const message = store.state.messages[input.parentMessageId]
            if (!message || message.conversationId != conversation.id) throw new Error('conversation channel create: parent message is missing')
            parent = {channelId: message.channelId, messageId: message.id}
        }
        const createdAt = now()
        const channel: ConversationChannel = {
            id: newId('channel'), conversationId: conversation.id, title: input.title, createdBy: account,
            ...(parent ? {parent} : {}), factMode, state: 'open', createdAt, updatedAt: createdAt,
        }
        const event: tConversationMutationEvent = {type: 'channel.created', conversationId: conversation.id, actor: account, requestId, channel}
        const receipt = makeReceipt(account, requestId, 'createChannel', channel.id)
        await commit(event, receipt, function applyChannel() { store.state.channels[channel.id] = channel })
        return copyChannel(channel)
    }

    async function performPostMessage(account: string, input: ConversationAppendInput, trusted = false) {
        if (closed) throw new Error('conversation host closed')
        const requestId = requireRequest(input)
        const previous = previousReceipt(account, requestId, 'postMessage')
        if (previous) {
            const message = store.state.messages[previous.entityId]
            if (!message) throw new Error('conversation message post: receipt target is missing')
            return copyMessage(message)
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'message post')
            : requireConversation(account, input.conversationId, 'message post')
        const channel = requireChannel(conversation.id, input.channelId, 'message post')
        validateAuthor(input.author)
        if (!Array.isArray(input.blocks) || input.blocks.length == 0) throw new Error('conversation message post: at least one block is required')
        const message: ConversationMessage = {
            id: newId('message'), conversationId: conversation.id, channelId: channel.id, requestId,
            createdBy: account, author: copyAuthor(input.author), blocks: input.blocks.map(createBlock), createdAt: now(),
        }
        const event: tConversationMutationEvent = {type: 'message.posted', conversationId: conversation.id, actor: account, requestId, message}
        const receipt = makeReceipt(account, requestId, 'postMessage', message.id)
        await commit(event, receipt, function applyMessage() {
            store.state.messages[message.id] = message
            channel.updatedAt = message.createdAt
            conversation.updatedAt = message.createdAt
        })
        return copyMessage(message)
    }

    function validateFactScope(conversationId: string, scope: tConversationFactScope) {
        if (!scope || (scope.kind != 'conversation' && scope.kind != 'channel')) throw new Error('conversation fact: invalid scope')
        if (scope.kind == 'channel') requireChannel(conversationId, scope.channelId, 'fact')
    }

    function factSources(account: string, conversationId: string, sourceMessageId?: string, trustedSource?: tConversationFactSource) {
        const sources: tConversationFactSource[] = [{kind: 'account', account}]
        if (sourceMessageId != null) {
            const message = store.state.messages[sourceMessageId]
            if (!message || message.conversationId != conversationId) throw new Error('conversation fact: source message is missing')
            sources.push({kind: 'message', messageId: message.id})
        }
        if (trustedSource) sources.push(copySource(trustedSource))
        return sources
    }

    async function performUpsertFact(account: string, input: ConversationFactInput, trusted = false, trustedSource?: tConversationFactSource) {
        if (closed) throw new Error('conversation host closed')
        const requestId = requireRequest(input)
        const previous = previousReceipt(account, requestId, 'upsertFact')
        if (previous) {
            const fact = store.state.facts[previous.entityId]
            if (!fact) throw new Error('conversation fact upsert: receipt target is missing')
            return copyFact(fact)
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'fact upsert')
            : requireConversation(account, input.conversationId, 'fact upsert')
        validateFactScope(conversation.id, input.scope)
        const namespace = requiredString(input.namespace, 'conversation fact namespace')
        const key = requiredString(input.key, 'conversation fact key')
        validateRevision(input.expectedRevision)
        const indexKey = factKey(conversation.id, input.scope, namespace, key)
        const currentId = factKeys.get(indexKey)
        const current = currentId ? store.state.facts[currentId] : undefined
        const revision = current?.revision ?? 0
        if (input.expectedRevision != null && input.expectedRevision != revision) throw new Error('conversation fact upsert: revision conflict')
        const updatedAt = now()
        const sources = factSources(account, conversation.id, input.sourceMessageId, trustedSource)
        const fact: ConversationFact = current ? {
            ...copyFact(current), value: copyConversationData(input.value, 'conversation fact value'), revision: revision + 1,
            state: 'active', provenance: [...current.provenance.map(copySource), ...sources], updatedAt,
        } : {
            id: newId('fact'), conversationId: conversation.id, scope: copyScope(input.scope), namespace, key,
            value: copyConversationData(input.value, 'conversation fact value'), revision: 1, state: 'active',
            provenance: sources, createdBy: account, createdAt: updatedAt, updatedAt,
        }
        const event: tConversationMutationEvent = {type: 'fact.upserted', conversationId: conversation.id, actor: account, requestId, fact}
        const receipt = makeReceipt(account, requestId, 'upsertFact', fact.id)
        await commit(event, receipt, function applyFact() {
            store.state.facts[fact.id] = fact
            factKeys.set(indexKey, fact.id)
            conversation.updatedAt = updatedAt
        })
        return copyFact(fact)
    }

    async function performRetractFact(account: string, input: ConversationFactRetractInput, trusted = false) {
        if (closed) throw new Error('conversation host closed')
        const requestId = requireRequest(input)
        const previous = previousReceipt(account, requestId, 'retractFact')
        if (previous) {
            const fact = store.state.facts[previous.entityId]
            if (!fact) throw new Error('conversation fact retract: receipt target is missing')
            return copyFact(fact)
        }
        const conversation = trusted
            ? requireTrustedConversation(input.conversationId, 'fact retract')
            : requireConversation(account, input.conversationId, 'fact retract')
        const current = store.state.facts[input.factId]
        if (!current || current.conversationId != conversation.id) throw new Error('conversation fact retract: fact is missing')
        validateRevision(input.expectedRevision)
        if (input.expectedRevision != null && input.expectedRevision != current.revision) throw new Error('conversation fact retract: revision conflict')
        const updatedAt = now()
        const fact: ConversationFact = {
            ...copyFact(current), revision: current.revision + 1, state: 'retracted',
            provenance: [...current.provenance.map(copySource), {kind: 'account', account}], updatedAt,
        }
        const event: tConversationMutationEvent = {type: 'fact.retracted', conversationId: conversation.id, actor: account, requestId, fact}
        const receipt = makeReceipt(account, requestId, 'retractFact', fact.id)
        await commit(event, receipt, function applyRetraction() {
            store.state.facts[fact.id] = fact
            conversation.updatedAt = updatedAt
        })
        return copyFact(fact)
    }

    function createConversation(account: string, input: ConversationCreateInput) {
        return serialize(() => performCreateConversation(account, input))
    }

    function createChannel(account: string, input: ConversationChannelInput, trusted = false) {
        return serialize(() => performCreateChannel(account, input, trusted))
    }

    function postMessage(account: string, input: ConversationPostInput) {
        return serialize(() => performPostMessage(account, {...input, author: {kind: 'account', account}}, false))
    }

    function appendMessage(account: string, input: ConversationAppendInput) {
        return serialize(() => performPostMessage(account, input, true))
    }

    function upsertFact(account: string, input: ConversationFactInput, trusted = false, source?: tConversationFactSource) {
        return serialize(() => performUpsertFact(account, input, trusted, source))
    }

    function retractFact(account: string, input: ConversationFactRetractInput, trusted = false) {
        return serialize(() => performRetractFact(account, input, trusted))
    }

    function connection(account: string) {
        if (closed) throw new Error('conversation host closed')
        requiredString(account, 'conversation account')
        const {view, stateReplay, events} = createView(account)
        views.add(view)
        let connectionClosed = false
        return {
            fragment: {
                state: stateReplay.api.replay,
                events: exposeReplay(events),
                createConversation: (input: ConversationCreateInput) => createConversation(account, input),
                createChannel: (input: ConversationChannelInput) => createChannel(account, input),
                postMessage: (input: ConversationPostInput) => postMessage(account, input),
                upsertFact: (input: ConversationFactInput) => upsertFact(account, input),
                retractFact: (input: ConversationFactRetractInput) => retractFact(account, input),
            },
            close() {
                if (connectionClosed) return
                connectionClosed = true
                view.close()
            },
        }
    }

    return {
        control: {
            createConversation,
            createChannel: (account: string, input: ConversationChannelInput) => createChannel(account, input, true),
            appendMessage,
            upsertFact: (account: string, input: ConversationFactInput, source?: tConversationFactSource) => upsertFact(account, input, true, source),
            retractFact: (account: string, input: ConversationFactRetractInput) => retractFact(account, input, true),
            /** Server-only projection. Receipts remain private and are persisted only through the adapter. */
            store,
        },
        connection,
        close() {
            if (closed) return
            closed = true
            offStore()
            for (const view of Array.from(views)) view.close()
            eventLine.close()
            receipts.clear()
        },
    }
}

export type ConversationHost = ReturnType<typeof createConversationHost>
