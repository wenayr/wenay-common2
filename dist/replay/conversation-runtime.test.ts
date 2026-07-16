// Conversation runtime oracle: logical channels, typed blocks, scoped facts,
// persistence receipts and ACL over the real Socket.IO/RPC path.
import express from 'express'
import {createServer} from 'http'
import type {AddressInfo} from 'net'
import {Server as SocketIOServer} from 'socket.io'
import {io} from 'socket.io-client'
import {createConversationClient, createConversationHost, ConversationReceipt, tConversationMutationEvent} from '../src/Common/conversation/conversation-index'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 200; i++) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

async function main() {
    console.log('\n[conversation] channels + blocks + facts over existing RPC')

    let clock = 1_000
    let rejectedRequest: string | undefined
    const commits: Array<{event: tConversationMutationEvent, receipt: ConversationReceipt}> = []
    const host = createConversationHost({
        persistence: {
            commit(input) {
                if (input.receipt.requestId == rejectedRequest) throw new Error('temporary persistence failure')
                commits.push(input)
            },
        },
        now: () => ++clock,
        drain: 'micro',
    })

    const app = express()
    const httpServer = createServer(app)
    const ioServer = new SocketIOServer(httpServer)
    ioServer.on('connection', function onConnection(socket) {
        const account = String(socket.handshake.auth?.account)
        const conversation = host.connection(account)
        const [disconnect, disconnectListen] = createListenPair<[]>()
        socket.on('disconnect', function onDisconnect() { disconnect(); conversation.close() })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {legacy: () => 'still here', conversation: conversation.fragment},
            disconnectListen,
        })
    })
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', resolve)
    })
    const port = (httpServer.address() as AddressInfo).port

    async function connect(account: string) {
        const hub = createRpcClientHub(
            () => io('http://127.0.0.1:' + port, {transports: ['websocket'], forceNew: true, auth: {account}}),
            rpc => ({app: rpc<any>('app')}),
        )
        const clients = await hub.setToken(null)
        await clients.app.readyStrict()
        const conversation = createConversationClient({remote: clients.app.func.conversation, drain: 'micro'})
        const events: string[] = []
        conversation.events.on(function collectEvent(event) { events.push(event.type) })
        await conversation.ready
        return {func: clients.app.func, conversation, events, close: () => hub.socket?.disconnect?.()}
    }

    const a = await connect('a')
    const b = await connect('b')
    const c = await connect('c')
    ok(await a.func.legacy() == 'still here', 'Conversation fragment leaves existing RPC keys untouched')

    const created = await a.conversation.createConversation({
        requestId: 'create-shared', title: 'Shared workspace', rootTitle: 'Main', participantIds: ['b'],
    })
    const duplicateCreate = await a.conversation.createConversation({
        requestId: 'create-shared', title: 'ignored retry payload', participantIds: ['c'],
    })
    ok(created.conversation.id == duplicateCreate.conversation.id && commits.filter(x => x.receipt.requestId == 'create-shared').length == 1,
        'conversation creation is account/request-id idempotent')
    await waitFor('shared conversation projection', () => !!b.conversation.store.state.conversations[created.conversation.id])
    ok(Object.keys(c.conversation.store.state.conversations).length == 0, 'non-participant receives no conversation shell')

    const structured = await a.conversation.postMessage({
        requestId: 'post-structured', conversationId: created.conversation.id, channelId: created.channel.id,
        blocks: [
            {kind: 'text', version: 1, text: 'A structured message'},
            {kind: 'list', version: 1, style: 'check', items: [{text: 'first', checked: true}, {text: 'second'}]},
            {kind: 'table', version: 1, columns: [{key: 'name', label: 'Name'}, {key: 'state', label: 'State'}], rows: [{name: 'stand', state: 'ready'}]},
            {kind: 'custom', version: 1, type: 'demo.metric', data: {value: 7, unit: 'items'}},
        ],
    })
    const duplicatePost = await a.conversation.postMessage({
        requestId: 'post-structured', conversationId: created.conversation.id, channelId: created.channel.id,
        blocks: [{kind: 'text', version: 1, text: 'must not replace the first payload'}],
    })
    ok(structured.id == duplicatePost.id && a.conversation.channelMessages(created.channel.id).length == 1,
        'message retry returns the first immutable message without duplication')
    await waitFor('structured message projection', () => !!b.conversation.store.state.messages[structured.id])
    const mirrored = b.conversation.store.state.messages[structured.id]
    ok(mirrored.blocks[1]?.kind == 'list' && mirrored.blocks[2]?.kind == 'table' && mirrored.blocks[3]?.kind == 'custom',
        'text/list/table/custom blocks survive Store/replay as versioned data')

    const beforeRejected = Object.keys(host.control.store.state.messages).length
    rejectedRequest = 'post-persistence-fails'
    let persistenceFailed = false
    try {
        await a.conversation.postMessage({
            requestId: rejectedRequest, conversationId: created.conversation.id, channelId: created.channel.id,
            blocks: [{kind: 'text', version: 1, text: 'not committed'}],
        })
    } catch { persistenceFailed = true }
    ok(persistenceFailed && Object.keys(host.control.store.state.messages).length == beforeRejected,
        'failed persistence commit leaves Store unchanged')
    rejectedRequest = undefined
    const persistedRetry = await a.conversation.postMessage({
        requestId: 'post-persistence-fails', conversationId: created.conversation.id, channelId: created.channel.id,
        blocks: [{kind: 'text', version: 1, text: 'committed on retry'}],
    })
    ok(!!host.control.store.state.messages[persistedRetry.id], 'same request can retry after an uncommitted persistence failure')

    let executableDataRejected = false
    try {
        await a.conversation.postMessage({
            requestId: 'post-function', conversationId: created.conversation.id, channelId: created.channel.id,
            blocks: [{kind: 'custom', version: 1, type: 'unsafe', data: {run() { return 1 }}}],
        })
    } catch { executableDataRejected = true }
    ok(executableDataRejected, 'custom block rejects executable function payloads')
    let unsafeKeyRejected = false
    try {
        await host.control.appendMessage('demo-system', {
            requestId: 'post-unsafe-key', conversationId: created.conversation.id, channelId: created.channel.id,
            author: {kind: 'system', id: 'oracle'},
            blocks: [{kind: 'custom', version: 1, type: 'unsafe', data: JSON.parse('{"__proto__":{"polluted":true}}')}],
        })
    } catch { unsafeKeyRejected = true }
    ok(unsafeKeyRejected, 'custom block rejects prototype-polluting object keys')

    let outsiderPostRejected = false
    try {
        await c.conversation.postMessage({
            requestId: 'outsider-post', conversationId: created.conversation.id, channelId: created.channel.id,
            blocks: [{kind: 'text', version: 1, text: 'forged'}],
        })
    } catch { outsiderPostRejected = true }
    ok(outsiderPostRejected, 'non-participant cannot address a guessed conversation id')

    const rootFact = await a.conversation.upsertFact({
        requestId: 'fact-root', conversationId: created.conversation.id, scope: {kind: 'conversation'},
        namespace: 'profile', key: 'language', value: 'ru', expectedRevision: 0, sourceMessageId: structured.id,
    })
    const child = await b.conversation.createChannel({
        requestId: 'fork-child', conversationId: created.conversation.id, title: 'Details',
        parentMessageId: structured.id, factMode: 'inherit',
    })
    await waitFor('child and fact projection', () => !!a.conversation.store.state.channels[child.id] && !!b.conversation.store.state.facts[rootFact.id])
    ok(child.parent?.messageId == structured.id && child.parent.channelId == created.channel.id,
        'child dialogue links to its anchor message without copying parent history')
    ok(b.conversation.channelFacts(child.id).some(fact => fact.id == rootFact.id), 'inheriting child sees conversation facts')

    const override = await b.conversation.upsertFact({
        requestId: 'fact-child', conversationId: created.conversation.id, scope: {kind: 'channel', channelId: child.id},
        namespace: 'profile', key: 'language', value: 'en', expectedRevision: 0,
    })
    await waitFor('fact override projection', () => !!a.conversation.store.state.facts[override.id])
    ok(a.conversation.channelFacts(child.id).find(fact => fact.namespace == 'profile' && fact.key == 'language')?.value == 'en',
        'narrower channel fact overrides inherited namespace/key')
    let staleRevisionRejected = false
    try {
        await a.conversation.upsertFact({
            requestId: 'fact-stale', conversationId: created.conversation.id, scope: {kind: 'channel', channelId: child.id},
            namespace: 'profile', key: 'language', value: 'de', expectedRevision: 0,
        })
    } catch { staleRevisionRejected = true }
    ok(staleRevisionRejected, 'stale expectedRevision cannot overwrite a concurrent fact')

    const retracted = await b.conversation.retractFact({
        requestId: 'fact-retract', conversationId: created.conversation.id, factId: override.id, expectedRevision: override.revision,
    })
    await waitFor('fact retraction projection', () => a.conversation.store.state.facts[retracted.id]?.state == 'retracted')
    ok(!a.conversation.channelFacts(child.id).some(fact => fact.namespace == 'profile' && fact.key == 'language'),
        'narrow retraction is a tombstone and does not reveal the inherited value again')

    const isolated = await a.conversation.createChannel({
        requestId: 'fork-isolated', conversationId: created.conversation.id, title: 'Private context shape',
        parentMessageId: structured.id, factMode: 'isolated',
    })
    await waitFor('isolated projection', () => !!b.conversation.store.state.channels[isolated.id])
    ok(b.conversation.channelFacts(isolated.id).length == 0, 'isolated child starts without conversation or ancestor facts')
    ok(a.events.includes('message.posted') && b.events.includes('channel.created') && b.events.includes('fact.upserted'),
        'filtered semantic event replay follows the dynamic projection')

    b.conversation.close()
    b.close()
    const b2 = await connect('b')
    await waitFor('reconnected state', () => !!b2.conversation.store.state.channels[child.id])
    ok(b2.conversation.channelMessages(created.channel.id).filter(message => message.id == structured.id).length == 1,
        'reconnection restores the filtered projection without duplicate messages')
    ok(!JSON.stringify(b2.conversation.store.snapshot()).includes('receipts'), 'idempotency receipts stay outside replicated Store state')

    const rehydrated = createConversationHost({
        initial: {store: host.control.store.snapshot(), receipts: commits.map(commit => commit.receipt)},
        drain: 'micro',
    })
    const rehydratedResult = await rehydrated.control.createConversation('a', {
        requestId: 'create-shared', title: 'must remain original', participantIds: ['c'],
    })
    ok(rehydratedResult.conversation.id == created.conversation.id && Object.keys(rehydrated.control.store.state.conversations).length == 1,
        'rehydrated private receipts preserve idempotency across host restart')
    rehydrated.close()

    a.conversation.close()
    c.conversation.close()
    b2.conversation.close()
    a.close()
    c.close()
    b2.close()
    host.close()
    ioServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
