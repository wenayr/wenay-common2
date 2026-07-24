// Domain SDK state clients: batch is the additive default and legacy stays selectable.

import {isDeepStrictEqual} from 'node:util'
import {createAiRunClient} from '../src/Common/ai/ai-run-client'
import {AiRun, createAiRunHost} from '../src/Common/ai/ai-run-host'
import {createArtifactClient} from '../src/Common/artifact/artifact-client'
import {ArtifactRecord, createArtifactHost} from '../src/Common/artifact/artifact-host'
import {createConversationClient} from '../src/Common/conversation/conversation-client'
import {Conversation, createConversationHost} from '../src/Common/conversation/conversation-host'
import {createFileJobClient} from '../src/Common/resource/file-job-client'
import {createFileJobHost, FileResource} from '../src/Common/resource/file-job-host'
import {Store} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function settle(source: Store<any>, clients: Store<any>[]) {
    await flushReactive(source.state)
    await new Promise<void>(function waitForProjection(resolve) { setImmediate(resolve) })
    for (const client of clients) await flushReactive(client.state)
}

function assertModesAndState(
    label: string,
    compact: {store: Store<any>, stateMode: () => string, stateSeq?: () => number, seq?: () => number},
    legacy: {store: Store<any>, stateMode: () => string, stateSeq?: () => number, seq?: () => number},
) {
    const compactSeq = (compact.stateSeq ?? compact.seq)!()
    const legacySeq = (legacy.stateSeq ?? legacy.seq)!()
    ok(compact.stateMode() == 'batch', label + ': batch is the default coordinate mode')
    ok(legacy.stateMode() == 'legacy', label + ': batch:false preserves legacy coordinates')
    ok(legacySeq == compactSeq + 1,
        label + ': two patches advance legacy twice and compact batch once (' + legacySeq + ' vs ' + compactSeq + ')')
    ok(isDeepStrictEqual(compact.store.snapshot(), legacy.store.snapshot()),
        label + ': both coordinate modes converge to the same state')
}

function withoutBatch<T extends {state: any}>(fragment: T) {
    const {batch: _batch, ...legacyState} = fragment.state
    return {...fragment, state: legacyState}
}

function assertMissingBatchFallback(
    label: string,
    compact: {store: Store<any>},
    fallback: {store: Store<any>, stateMode: () => string},
) {
    ok(fallback.stateMode() == 'legacy', label + ': a new client falls back when an old host has no batch member')
    ok(isDeepStrictEqual(compact.store.snapshot(), fallback.store.snapshot()),
        label + ': missing-batch fallback converges to the same state')
}

function aiRun(id: string): AiRun {
    return {
        id,
        owner: 'a',
        requestId: 'request-' + id,
        kind: 'assistant',
        resourceIds: [],
        state: 'completed',
        progress: 1,
        artifacts: [],
        createdAt: 1,
        updatedAt: 1,
    }
}

function conversation(id: string): Conversation {
    return {
        id,
        owner: 'a',
        title: id,
        participantIds: ['a'],
        rootChannelId: 'root-' + id,
        state: 'open',
        createdAt: 1,
        updatedAt: 1,
    }
}

function artifact(id: string): ArtifactRecord {
    return {
        id,
        owner: 'a',
        descriptor: {kind: 'report', label: id, runtime: 'download'},
        state: 'ready',
        retention: {class: 'persistent'},
        createdAt: 1,
        updatedAt: 1,
    }
}

function file(id: string): FileResource {
    return {
        id,
        owner: 'a',
        name: id,
        size: 1,
        state: 'uploaded',
        createdAt: 1,
        updatedAt: 1,
    }
}

async function testAi() {
    const host = createAiRunHost({runner: {run() {}}, drain: 'micro'})
    const compactConnection = host.connection('a')
    const legacyConnection = host.connection('a')
    const fallbackConnection = host.connection('a')
    const compact = createAiRunClient({remote: compactConnection.fragment, drain: 'micro'})
    const legacy = createAiRunClient({remote: legacyConnection.fragment, drain: 'micro', batch: false})
    const fallback = createAiRunClient({remote: withoutBatch(fallbackConnection.fragment), drain: 'micro'})
    await Promise.all([compact.ready, legacy.ready, fallback.ready])

    host.store.state.runs.one = aiRun('one')
    host.store.state.runs.two = aiRun('two')
    await settle(host.store, [compact.store, legacy.store, fallback.store])
    assertModesAndState('AI', compact, legacy)
    assertMissingBatchFallback('AI', compact, fallback)

    compact.close()
    legacy.close()
    fallback.close()
    compactConnection.close()
    legacyConnection.close()
    fallbackConnection.close()
    host.close()
}

async function testConversation() {
    const host = createConversationHost({drain: 'micro'})
    const compactConnection = host.connection('a')
    const legacyConnection = host.connection('a')
    const fallbackConnection = host.connection('a')
    const compact = createConversationClient({remote: compactConnection.fragment, drain: 'micro'})
    const legacy = createConversationClient({remote: legacyConnection.fragment, drain: 'micro', batch: false})
    const fallback = createConversationClient({remote: withoutBatch(fallbackConnection.fragment), drain: 'micro'})
    await Promise.all([compact.ready, legacy.ready, fallback.ready])

    host.control.store.state.conversations.one = conversation('one')
    host.control.store.state.conversations.two = conversation('two')
    await settle(host.control.store, [compact.store, legacy.store, fallback.store])
    assertModesAndState('Conversation', compact, legacy)
    assertMissingBatchFallback('Conversation', compact, fallback)

    compact.close()
    legacy.close()
    fallback.close()
    compactConnection.close()
    legacyConnection.close()
    fallbackConnection.close()
    host.close()
}

async function testArtifact() {
    const host = createArtifactHost({
        storage: {open: () => ({url: 'https://artifact.example/item', expiresAt: Date.now() + 1_000})},
        drain: 'micro',
    })
    const compactConnection = host.connection('a')
    const legacyConnection = host.connection('a')
    const fallbackConnection = host.connection('a')
    const compact = createArtifactClient({remote: compactConnection.fragment, drain: 'micro'})
    const legacy = createArtifactClient({remote: legacyConnection.fragment, drain: 'micro', batch: false})
    const fallback = createArtifactClient({remote: withoutBatch(fallbackConnection.fragment), drain: 'micro'})
    await Promise.all([compact.ready, legacy.ready, fallback.ready])

    host.store.state.artifacts.one = artifact('one')
    host.store.state.artifacts.two = artifact('two')
    await settle(host.store, [compact.store, legacy.store, fallback.store])
    assertModesAndState('Artifact', compact, legacy)
    assertMissingBatchFallback('Artifact', compact, fallback)

    compact.close()
    legacy.close()
    fallback.close()
    compactConnection.close()
    legacyConnection.close()
    fallbackConnection.close()
    host.close()
}

async function testFileJob() {
    const host = createFileJobHost({
        storage: {beginUpload: () => ({})},
        runner: {run() {}},
        drain: 'micro',
    })
    const compactConnection = host.connection('a')
    const legacyConnection = host.connection('a')
    const fallbackConnection = host.connection('a')
    const compact = createFileJobClient({remote: compactConnection.fragment, drain: 'micro'})
    const legacy = createFileJobClient({remote: legacyConnection.fragment, drain: 'micro', batch: false})
    const fallback = createFileJobClient({remote: withoutBatch(fallbackConnection.fragment), drain: 'micro'})
    await Promise.all([compact.ready, legacy.ready, fallback.ready])

    host.store.state.files.one = file('one')
    host.store.state.files.two = file('two')
    await settle(host.store, [compact.store, legacy.store, fallback.store])
    assertModesAndState('File/job', compact, legacy)
    assertMissingBatchFallback('File/job', compact, fallback)

    compact.close()
    legacy.close()
    fallback.close()
    compactConnection.close()
    legacyConnection.close()
    fallbackConnection.close()
    host.close()
}

async function main() {
    console.log('\n[domain-sdk-batch-mode] additive client mode selection and coordinate semantics')
    await testAi()
    await testConversation()
    await testArtifact()
    await testFileJob()
    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
