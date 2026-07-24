import {flushReactive} from '../src/Common/Observe/reactive'
import {StorePatch} from '../src/Common/Observe/store'
import {exposeReplay} from '../src/Common/events/replay-wire'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from '../src/Common/events/replay-channel'
import {replayListen} from '../src/Common/events/replay-listen'
import {
    createTransportLifecycle,
    RPC_MEMBER_LOOKUP,
    RPC_SCHEMA_READY,
    RPC_TRANSPORT_LIFECYCLE,
} from '../src/Common/events/transport-lifecycle'
import {createPatchRelayJournal, createPeerClient, createPeerHost, PatchEnvelope, PeerRemote} from '../src/Common/peer/peer-index'
import {readPeerRelayFrame, readPeerRelaySeq} from '../src/Common/peer/peer-remote-compat'
import {
    PEER_PUBLISH_BATCH_MAX_BYTES,
    PEER_PUBLISH_BATCH_MAX_ITEMS,
    peerPublishBatchBytes,
    splitPeerPublishEnvelopes,
} from '../src/Common/peer/peer-publish-batch'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const json = (value: any) => JSON.stringify(value)

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

function envelope(seq: number, path: PropertyKey[], value: any): PatchEnvelope {
    return {seq, ts: seq, event: [{path, value, exists: value != undefined}]}
}

function root(seq: number, value: any) {
    return envelope(seq, [], value)
}

function splitPeerPublishEnvelopesSlow<T>(envelopes: readonly T[]) {
    const batches: T[][] = []
    let batch: T[] = []

    function flush() {
        if (!batch.length) return
        batches.push(batch)
        batch = []
    }

    for (const item of envelopes) {
        let candidateBytes = peerPublishBatchBytes([...batch, item])
        if (batch.length > 0 && (batch.length >= PEER_PUBLISH_BATCH_MAX_ITEMS ||
            candidateBytes > PEER_PUBLISH_BATCH_MAX_BYTES)) {
            flush()
            candidateBytes = peerPublishBatchBytes([item])
        }
        batch.push(item)
        if (batch.length >= PEER_PUBLISH_BATCH_MAX_ITEMS ||
            candidateBytes >= PEER_PUBLISH_BATCH_MAX_BYTES) flush()
    }
    flush()
    return batches
}

function createPeerRemote(
    journal: ReturnType<typeof createPatchRelayJournal>,
    stats: {legacy: PatchEnvelope[], batches: PatchEnvelope[][]},
    batch: boolean,
) {
    const remote: PeerRemote = {
        signal: {send: async () => false, signals: {on: () => () => {}}},
        publish(env) {
            stats.legacy.push(env)
            return journal.push(env)
        },
        peers: {owner: journal.remote as any},
    }
    if (batch) {
        remote.publishBatch = function publishBatch(envelopes) {
            stats.batches.push(envelopes)
            return journal.pushBatch(envelopes)
        }
    }
    return remote
}

function createChannelPair() {
    const aMessages = new Set<(data: string) => void>()
    const bMessages = new Set<(data: string) => void>()
    const aSent: string[] = []
    const bSent: string[] = []

    function side(sent: string[], target: Set<(data: string) => void>, own: Set<(data: string) => void>): ReplayMessageChannel {
        return {
            send(data) {
                sent.push(data)
                for (const cb of Array.from(target)) cb(data)
            },
            onMessage(cb) {
                own.add(cb)
                return function offMessage() { own.delete(cb) }
            },
        }
    }

    return {
        a: side(aSent, bMessages, aMessages),
        b: side(bSent, aMessages, bMessages),
        aSent,
        bSent,
    }
}

function messageType(raw: string) {
    return JSON.parse(raw).t
}

async function main() {
    console.log('\n[peer-replay-batch] relay validates a batch before committing it')
    {
        const journal = createPatchRelayJournal({history: 32})
        const delivered: number[] = []
        journal.remote.line.on(ev => delivered.push(ev.seq))
        journal.push(root(0, {n: 0}))
        delivered.length = 0

        const gap = journal.pushBatch([envelope(1, ['n'], 1), envelope(3, ['n'], 3)])
        ok(json(gap) == json({seq: 0}), 'gap verdict points at the real pre-batch head')
        ok(journal.seq() == 0 && journal.snapshot().n == 0 && delivered.length == 0,
            'a rejected gap leaves fold, head and live line untouched')

        const malformed = journal.pushBatch([envelope(1, ['n'], 1), {seq: 2, ts: 2, event: [{} as StorePatch]}])
        ok(malformed == false && journal.seq() == 0 && delivered.length == 0,
            'a malformed suffix cannot partially commit a valid prefix')

        const tooMany = Array.from({length: 65}, (_, i) => envelope(i + 1, ['n'], i + 1))
        ok(journal.pushBatch(tooMany) == false && journal.seq() == 0 && delivered.length == 0,
            'relay rejects an over-item batch before validation or commit')

        const tooLarge = [envelope(1, ['a'], 'Ж'.repeat(20_000)), envelope(2, ['b'], 'Ж'.repeat(20_000))]
        ok(journal.pushBatch(tooLarge) == false && journal.seq() == 0 && delivered.length == 0,
            'relay rejects an over-byte UTF-8 batch before validation or commit')

        ok(journal.pushBatch([envelope(1, ['n'], 1), envelope(2, ['tag'], 'ok')]) == true,
            'a contiguous ordered batch is accepted')
        ok(journal.seq() == 2 && journal.snapshot().n == 1 && journal.snapshot().tag == 'ok'
            && json(delivered) == json([1, 2]), 'accepted envelopes retain owner seq and live order')
    }
    {
        const journal = createPatchRelayJournal({history: 32})
        let lineClosed = false
        const journalLine = journal.remote.line as any
        journalLine.onClose(function rememberTerminalRelayClose() { lineClosed = true })
        journal.push(root(0, {large: 'x'.repeat(16_000)}))
        journal.push(envelope(1, ['n'], 1))
        journal.close()

        ok(lineClosed && journal.push(envelope(2, ['n'], 2)) == false
            && journal.pushBatch([]) == false,
        'closed relay rejects both single and empty-batch publication')
        ok(journal.snapshot() == undefined && journal.remote.keyframe() == null
            && journal.remote.since(-1) == null,
        'closed relay releases its folded snapshot and replay ring')
    }
    {
        const journal = createPatchRelayJournal({history: 3})
        journal.push(root(0, {generation: 'first'}))
        for (let i = 1; i <= 7; i++) journal.push(envelope(i, ['n'], i))
        ok(json(journal.remote.since(4)?.map(event => event.seq)) == json([5, 6, 7]),
            'wrapped relay history retains chronological order')
        ok(journal.remote.since(3) == null,
            'wrapped relay history reports an evicted coordinate')

        journal.push(root(0, {generation: 'second'}))
        ok(json(journal.remote.since(-1)?.map(event => event.seq)) == json([0])
            && journal.snapshot().generation == 'second',
        'a lower root resets the circular history and folded keyframe together')
        for (let i = 1; i <= 4; i++) journal.push(envelope(i, ['n'], i))
        ok(json(journal.remote.since(1)?.map(event => event.seq)) == json([2, 3, 4])
            && journal.remote.since(0) == null,
        'history continues wrapping correctly after a root reset')
    }
    {
        const noHistory = createPatchRelayJournal({history: 0})
        noHistory.push(root(0, {n: 0}))
        ok(noHistory.remote.since(-1) == null && noHistory.remote.keyframe()?.seq == 0,
            'history zero keeps folded keyframes but no resumable tail')

        const oneHistory = createPatchRelayJournal({history: 1})
        oneHistory.push(root(0, {n: 0}))
        oneHistory.push(envelope(1, ['n'], 1))
        oneHistory.push(envelope(2, ['n'], 2))
        ok(json(oneHistory.remote.since(1)?.map(event => event.seq)) == json([2])
            && oneHistory.remote.since(0) == null,
        'history one keeps exactly the newest envelope')
    }
    {
        const journal = createPatchRelayJournal({history: 32})
        journal.push(root(0, {}))
        const smallBinary = new Uint8Array(30 * 1024)
        const acceptedBatch = [
            envelope(1, ['a'], smallBinary),
            envelope(2, ['b'], smallBinary),
        ]
        const accepted = journal.pushBatch(acceptedBatch)
        ok(accepted == true && journal.seq() == 2,
            'relay counts native binary bytes instead of expanded Uint8Array JSON keys')
        ok(json(splitPeerPublishEnvelopes([...acceptedBatch, envelope(3, ['c'], smallBinary)]).map(batch => batch.length))
            == json([2, 1]), 'client splitter applies the same native-binary byte model')

        const largeBinary = new Uint8Array(40 * 1024)
        const rejected = journal.pushBatch([
            envelope(3, ['c'], largeBinary),
            envelope(4, ['d'], largeBinary),
        ])
        ok(rejected == false && journal.seq() == 2,
            'relay applies the same binary-aware byte ceiling atomically')
    }
    {
        let seed = 0x5eed
        function nextPseudoRandom() {
            seed = (seed * 1664525 + 1013904223) >>> 0
            return seed
        }
        const values: unknown[] = [undefined, NaN, BigInt(7), new Uint8Array(3)]
        for (let i = 0; i < 1000; i++) {
            const binaryCount = nextPseudoRandom() % 5 + 1
            values.push({
                binaries: Array.from({length: binaryCount}, function makeBinary(_, index) {
                    return new Uint8Array((nextPseudoRandom() % 191) + index + 1)
                }),
                omitted: i % 3 == 0 ? undefined : i,
                rich: new Map([['i', i], ['at', new Date(i * 1000)]]),
                text: 'Ж'.repeat(nextPseudoRandom() % 2600),
            })
        }
        const fast = splitPeerPublishEnvelopes(values)
        const slow = splitPeerPublishEnvelopesSlow(values)
        ok(json(fast.map(batch => batch.length)) == json(slow.map(batch => batch.length)),
            'incremental splitter exactly matches full RPC remeasurement at every boundary')
        ok(fast.flat().every((value, index) => Object.is(value, values[index])),
            'incremental splitter preserves value identity and order')
    }
    {
        const journal = createPatchRelayJournal({history: 32})
        const firstGot: number[] = []
        const siblingGot: number[] = []
        let resolveThrown = function resolveThrownLater(_error: unknown) {}
        const thrown = new Promise<unknown>(resolve => { resolveThrown = resolve })
        function rememberSubscriberError(error: unknown) { resolveThrown(error) }
        process.once('uncaughtException', rememberSubscriberError)
        journal.remote.line.on(function throwingFirstSubscriber(ev) {
            firstGot.push(ev.seq)
            if (ev.seq == 0) throw new Error('relay subscriber failed at seq 0')
        })
        journal.remote.line.on(function rememberSiblingDelivery(ev) {
            siblingGot.push(ev.seq)
        })

        const accepted = journal.pushBatch([root(0, {n: 0}), envelope(1, ['n'], 1)])
        const thrownResult = await Promise.race([thrown, delay(100).then(() => 'timeout')])
        process.off('uncaughtException', rememberSubscriberError)
        ok(accepted == true && journal.seq() == 1 && journal.snapshot().n == 1,
            'subscriber failure cannot interrupt an already validated relay batch')
        ok(json(firstGot) == json([0, 1]) && json(siblingGot) == json([0, 1]),
            'every envelope still reaches the throwing subscriber and its sibling')
        ok(thrownResult instanceof Error && thrownResult.message == 'relay subscriber failed at seq 0',
            'relay subscriber failure is reported after the complete batch commits')
    }
    {
        const journal = createPatchRelayJournal({history: 32})
        const delivered: number[] = []
        let reentrantVerdict: any
        journal.remote.line.on(function reentrantRelaySubscriber(event) {
            delivered.push(event.seq)
            if (event.seq == 0) reentrantVerdict = journal.push(envelope(1, ['winner'], 'reentrant'))
        })
        const accepted = journal.pushBatch([
            root(0, {}),
            envelope(1, ['winner'], 'outer'),
        ])
        const tail = journal.remote.since(-1)
        ok(accepted == true && reentrantVerdict == true && journal.snapshot().winner == 'outer',
            'validated batch state commits before a subscriber can re-enter the relay')
        ok(json(delivered) == json([0, 1]) && json(tail?.map(event => event.event[0].value)) == json([{}, 'outer']),
            're-entrant duplicate cannot replace or suppress the committed outer suffix')
    }

    console.log('\n[peer-replay-batch] owner -> relay uses one call and falls back to legacy')
    {
        const host = createPeerHost()
        const connection = host.connection('old-owner')
        connection.fragment.publish(root(0, {n: 0}))
        connection.fragment.publish(envelope(1, ['n'], 1))
        ok(host.relay('old-owner').snapshot().n == 1,
            'new host keeps the original publish method for an old peer client')
        connection.close()
        host.close()
    }
    {
        const host = createPeerHost()
        const connection = host.connection('owner')
        const peers = connection.fragment.peers
        let signalClosed = false
        connection.fragment.signal.signals.onClose(function rememberHostSignalClose() { signalClosed = true })
        connection.fragment.publish(root(0, {n: 0}))
        void peers.other
        host.close()

        let connectionRejected = false
        let relayRejected = false
        try { host.connection('late') } catch { connectionRejected = true }
        try { host.relay('late') } catch { relayRejected = true }
        ok(signalClosed && connectionRejected && relayRejected
            && connection.fragment.publish(envelope(1, ['n'], 1)) == false,
        'peer host close is terminal for live ports, old publishers and new access')
        ok(host.accounts().length == 0 && host.presence.list().length == 0
            && Object.keys(peers).length == 0 && !('owner' in peers) && !('other' in peers),
        'peer host close clears relay and dynamic peer keyspaces')
    }
    {
        type State = {a: number, b: number, c: number}
        const journal = createPatchRelayJournal({history: 64})
        const stats = {legacy: [] as PatchEnvelope[], batches: [] as PatchEnvelope[][]}
        const client = createPeerClient<State>({
            remote: createPeerRemote(journal, stats, true),
            account: 'owner', initial: {a: 0, b: 0, c: 0}, drain: flush => flush(),
        })
        await waitFor('batch warmup', () => journal.seq() >= 0)
        stats.legacy.length = 0
        stats.batches.length = 0

        client.store.state.a = 1
        client.store.state.b = 2
        client.store.state.c = 3
        await flushReactive(client.store.state)
        await waitFor('batched live publish', () => journal.snapshot().c == 3)
        const nonEmpty = stats.batches.filter(batch => batch.length)
        ok(nonEmpty.length == 1 && nonEmpty[0].length == 3 && stats.legacy.length == 0,
            'three live envelopes cross owner -> relay in one publishBatch call')
        ok(json(nonEmpty[0].map(ev => ev.seq)) == json([1, 2, 3]), 'batch preserves contiguous owner coordinates')

        client.store.state.a = 4
        client.store.state.b = 5
        client.close()
        await delay(0)
        ok(journal.snapshot().a == 1 && journal.snapshot().b == 2,
            'close is terminal and discards a pending micro-batch without a post-close send')
    }
    {
        type State = {a: number, b: number, c: number}
        const journal = createPatchRelayJournal({history: 64})
        const stats = {legacy: [] as PatchEnvelope[], batches: [] as PatchEnvelope[][]}
        const client = createPeerClient<State>({
            remote: createPeerRemote(journal, stats, false),
            account: 'owner', initial: {a: 0, b: 0, c: 0}, drain: 'micro',
        })
        await waitFor('legacy warmup', () => journal.seq() >= 0)
        stats.legacy.length = 0

        client.store.state.a = 1
        client.store.state.b = 2
        client.store.state.c = 3
        await flushReactive(client.store.state)
        await waitFor('legacy live publish', () => journal.snapshot().c == 3)
        ok(stats.legacy.length == 3, 'new client falls back to one publish per envelope on an old relay')
        client.close()
    }
    {
        type State = {n: number}
        const journal = createPatchRelayJournal({history: 32})
        const stats = {legacy: [] as PatchEnvelope[], batches: [] as PatchEnvelope[][]}
        let schemaKnown = false
        let schemaWaits = 0
        let speculativeCalls = 0
        const remote = createPeerRemote(journal, stats, false) as PeerRemote & Record<PropertyKey, any>
        remote.publishBatch = function rejectSpeculativeBatch() {
            speculativeCalls++
            throw new Error('old host has no publishBatch')
        }
        const lookup = function lookupPeerMember(member: string) {
            return member == 'publishBatch' && schemaKnown ? false : undefined
        }
        Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
        Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: lookup})
        const schemaReady = async function waitForPeerSchema() {
            schemaWaits++
            await delay(2)
            schemaKnown = true
        }
        Object.defineProperty(schemaReady, RPC_SCHEMA_READY, {value: true})
        Object.defineProperty(remote, RPC_SCHEMA_READY, {value: schemaReady})

        const client = createPeerClient<State>({remote, account: 'owner', initial: {n: 0}, drain: flush => flush()})
        await waitFor('schema-negotiated legacy warmup', () => journal.seq() >= 0)
        ok(schemaWaits == 1 && speculativeCalls == 0 && stats.legacy.length == 1,
            'branded RPC waits for MAP and never probes publishBatch on an old host')
        client.close()
    }
    {
        type State = {a: string, b: string, c: string}
        const journal = createPatchRelayJournal({history: 64})
        const stats = {legacy: [] as PatchEnvelope[], batches: [] as PatchEnvelope[][]}
        const client = createPeerClient<State>({
            remote: createPeerRemote(journal, stats, true),
            account: 'owner', initial: {a: '', b: '', c: ''}, drain: flush => flush(),
        })
        await waitFor('large batch warmup', () => journal.seq() >= 0)
        stats.batches.length = 0

        const large = 'x'.repeat(30_000)
        client.store.state.a = large
        client.store.state.b = large
        client.store.state.c = large
        await waitFor('byte-bounded owner publish', () => journal.snapshot().c.length == large.length)
        const payloadBatches = stats.batches.filter(batch => batch.length)
        ok(json(payloadBatches.map(batch => batch.length)) == json([2, 1]),
            'owner batches split near 64 KiB before the 64-item ceiling')
        ok(payloadBatches.flat().length == 3, 'byte splitting preserves every owner envelope')

        stats.batches.length = 0
        stats.legacy.length = 0
        const oversize = 'z'.repeat(70 * 1024)
        client.store.state.a = oversize
        await waitFor('oversize owner envelope', () => journal.snapshot().a.length == oversize.length)
        ok(stats.batches.length == 0 && stats.legacy.length == 1,
            'an oversize owner envelope bypasses the bounded batch without being dropped')

        stats.batches.length = 0
        stats.legacy.length = 0
        const unicode = 'Ж'.repeat(20_000)
        client.store.state.a = unicode
        client.store.state.b = unicode
        client.store.state.c = unicode
        await waitFor('UTF-8 bounded owner publish', () => journal.snapshot().c == unicode)
        ok(json(stats.batches.map(batch => batch.length)) == json([1, 1, 1]) && stats.legacy.length == 0,
            'owner batching counts UTF-8 bytes and full array framing')
        client.close()
    }
    console.log('\n[peer-replay-batch] batching capability follows transport generations')
    {
        type State = {n: number}
        const journal = createPatchRelayJournal({history: 64})
        const stats = {legacy: [] as PatchEnvelope[], batches: [] as PatchEnvelope[][]}
        let batchAvailable = true
        const lifecycle = createTransportLifecycle(true)
        const remote = createPeerRemote(journal, stats, true) as PeerRemote & Record<PropertyKey, any>
        const lookup = function lookupPeerMember(member: string) {
            return member == 'publishBatch' ? batchAvailable : undefined
        }
        Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
        Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: lookup})
        Object.defineProperty(remote, RPC_TRANSPORT_LIFECYCLE, {value: lifecycle.api})

        const client = createPeerClient<State>({remote, account: 'owner', initial: {n: 0}, drain: flush => flush()})
        await waitFor('generation warmup', () => journal.seq() >= 0)
        stats.legacy.length = 0
        stats.batches.length = 0

        batchAvailable = false
        lifecycle.control.disconnect('rolling downgrade')
        lifecycle.control.connect()
        client.store.state.n = 1
        await waitFor('legacy generation publish', () => journal.snapshot().n == 1)
        ok(stats.legacy.length == 1 && stats.batches.length == 0,
            'new client downgrades to publish after reconnecting to a legacy host')

        stats.legacy.length = 0
        stats.batches.length = 0
        batchAvailable = true
        lifecycle.control.disconnect('rolling upgrade')
        lifecycle.control.connect()
        client.store.state.n = 2
        await waitFor('batch generation publish', () => journal.snapshot().n == 2)
        ok(stats.batches.length == 1 && stats.legacy.length == 0,
            'the next generation upgrades back to publishBatch from current schema')
        client.close()
    }

    console.log('\n[peer-replay-batch] live publish batches stay single-flight')
    {
        type State = Record<string, number>
        const initial = Object.fromEntries(Array.from({length: 130}, (_, i) => ['k' + i, 0]))
        const journal = createPatchRelayJournal({history: 256})
        let active = 0
        let maxActive = 0
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: env => journal.push(env),
            async publishBatch(envelopes) {
                active++
                maxActive = Math.max(maxActive, active)
                await delay(3)
                try { return journal.pushBatch(envelopes) }
                finally { active-- }
            },
            peers: {owner: journal.remote as any},
        }
        const client = createPeerClient<State>({remote, account: 'owner', initial, history: 256, drain: flush => flush()})
        await waitFor('serialized live warmup', () => journal.seq() >= 0)
        maxActive = 0

        for (let i = 0; i < 130; i++) client.store.state['k' + i] = i + 1
        const syncing = client.resync()
        await delay(1)
        client.store.state.k0 = 999
        await syncing
        ok(maxActive == 1 && journal.seq() == 131 && journal.snapshot().k129 == 130
            && journal.snapshot().k0 == 999,
        'live batches stay single-flight and resync drains writes appended while it waits')
        client.close()
    }
    console.log('\n[peer-replay-batch] resync owns the publish boundary while relay seq is pending')
    {
        type State = {n: number}
        let resolveRelaySeq = function resolveRelaySeqLater(_seq: number) {}
        const relaySeq = new Promise<number>(resolve => { resolveRelaySeq = resolve })
        let relaySeqRequested = false
        let tracking = false
        let active = 0
        let maxActive = 0
        let repairStarted = false
        let liveStarted = false
        let releaseLive = function releaseLiveLater() {}
        const live = new Promise<void>(resolve => { releaseLive = resolve })
        const node = {
            line: {on: () => () => {}},
            since: () => null,
            keyframe: () => undefined,
            async seq() {
                relaySeqRequested = true
                return relaySeq
            },
        }
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: async () => true,
            async publishBatch(envelopes) {
                if (!tracking) return true
                active++
                maxActive = Math.max(maxActive, active)
                const isRepair = envelopes[0]?.event[0]?.path.length == 0
                if (isRepair) repairStarted = true
                else {
                    liveStarted = true
                    await live
                }
                active--
                return true
            },
            peers: {owner: node as any},
        }
        const client = createPeerClient<State>({remote, account: 'owner', initial: {n: 0}, drain: flush => flush()})
        await delay(0)
        tracking = true

        const syncing = client.resync()
        await waitFor('relay seq read', () => relaySeqRequested)
        client.store.state.n = 1
        await flushReactive(client.store.state)
        await delay(0)
        resolveRelaySeq(-1)
        await waitFor('resync repair start', () => repairStarted)
        await waitFor('post-resync live start', () => liveStarted)

        ok(maxActive == 1,
            `resync seq/read/repair and a live publishBatch share one single-flight lane (max ${maxActive})`)
        releaseLive()
        await syncing
        await waitFor('serialized resync drain', () => active == 0)
        client.close()
    }
    console.log('\n[peer-replay-batch] repair chunks remain strictly ordered')
    {
        type State = Record<string, number>
        const initial = Object.fromEntries(Array.from({length: 130}, (_, i) => ['k' + i, 0]))
        const journal = createPatchRelayJournal({history: 256})
        let dropLive = false
        let active = 0
        let maxActive = 0
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: env => journal.push(env),
            async publishBatch(envelopes) {
                if (dropLive) return true
                active++
                maxActive = Math.max(maxActive, active)
                await delay(2)
                try { return journal.pushBatch(envelopes) }
                finally { active-- }
            },
            peers: {owner: journal.remote as any},
        }
        const client = createPeerClient<State>({remote, account: 'owner', initial, history: 256, drain: flush => flush()})
        await waitFor('repair warmup', () => journal.seq() >= 0)
        dropLive = true
        for (let i = 0; i < 130; i++) client.store.state['k' + i] = i + 1
        await flushReactive(client.store.state)
        await delay(10)
        ok(journal.seq() == 0, 'test transport intentionally leaves the relay behind')

        dropLive = false
        maxActive = 0
        await client.resync()
        ok(maxActive == 1 && journal.seq() == 130 && journal.snapshot().k129 == 130,
            'multi-chunk repair awaits each publishBatch before sending the next coordinate range')
        client.close()
    }

    console.log('\n[peer-replay-batch] optional old-host relay methods fall back narrowly')
    {
        const tail = [envelope(2, ['n'], 2)]
        const oldNode = {
            line: {on: () => () => {}},
            since: async () => tail,
            keyframe: async () => root(0, {n: 0}),
            seq: async () => { throw new Error('Not a function: peers,owner,seq') },
            frame: async () => { throw new Error('Not a function: peers,owner,frame') },
        }
        ok(await readPeerRelaySeq(oldNode) == -1,
            'missing old-host seq falls back to the full-repair coordinate')
        ok(json(await readPeerRelayFrame(oldNode, 1)) == json(tail),
            'missing old-host frame falls back to the legacy since tail')

        let propagated = false
        try {
            await readPeerRelayFrame({...oldNode, frame: async () => { throw new Error('transport failed') }}, 1)
        } catch (error: any) {
            propagated = error.message == 'transport failed'
        }
        ok(propagated, 'non-capability frame failures remain loud')
    }

    console.log('\n[peer-replay-batch] direct replay channel capability and mixed versions')
    {
        const [emit, replay] = replayListen<[number]>({history: 256})
        const pair = createChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[number]>(pair.b)
        const got: number[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        pair.aSent.length = 0

        for (let i = 1; i <= 130; i++) emit(i)
        await delay(0)
        const packets = pair.aSent.map(raw => JSON.parse(raw)).filter(msg => msg.t == 'evs')
        ok(packets.length == 3 && packets.every(msg => msg.evs.length <= 64),
            'new/new sends 130 live envelopes in three bounded packets')
        ok(got.length == 130 && got[0] == 1 && got[129] == 130, 'client unpacks every envelope in order')

        emit(131)
        emit(132)
        stop()
        ok(got[130] == 131 && got[131] == 132, 'server close flushes the pending direct batch')
    }
    {
        const [emit, replay] = replayListen<[number]>({history: 16})
        const pair = createChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        pair.b.send(JSON.stringify({t: 'sub'}))
        pair.aSent.length = 0
        emit(1); emit(2); emit(3)
        ok(json(pair.aSent.map(messageType)) == json(['ev', 'ev', 'ev']),
            'new server keeps legacy one-envelope messages for an old client')
        stop()
    }
    {
        const [emit, replay] = replayListen<[string]>({history: 16})
        const pair = createChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[string]>(pair.b)
        const got: string[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        pair.aSent.length = 0

        const large = 'x'.repeat(30_000)
        emit(large); emit(large); emit(large)
        await delay(0)
        const packets = pair.aSent.map(raw => ({raw, message: JSON.parse(raw)}))
            .filter(item => item.message.t == 'evs')
        ok(json(packets.map(item => item.message.evs.length)) == json([2, 1])
            && packets.every(item => item.raw.length < 64 * 1024),
            'direct live batches split near 64 KiB before the item ceiling')
        ok(got.length == 3 && got.every(value => value.length == large.length),
            'direct byte splitting preserves every envelope')

        pair.aSent.length = 0
        const oversize = 'z'.repeat(70 * 1024)
        emit(oversize)
        await delay(0)
        const oversizePacket = pair.aSent.map(raw => JSON.parse(raw)).find(message => message.t == 'evs')
        ok(oversizePacket?.evs.length == 1 && got[3]?.length == oversize.length,
            'an oversize direct envelope is sent alone without being dropped')
        stop()
    }
    {
        const [emit, replay] = replayListen<[string]>({history: 16})
        const pair = createChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[string]>(pair.b)
        const got: string[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        pair.aSent.length = 0

        const unicode = 'Ж'.repeat(15_000)
        emit(unicode); emit(unicode); emit(unicode)
        await delay(0)
        const encoder = new TextEncoder()
        const packets = pair.aSent.filter(raw => JSON.parse(raw).t == 'evs')
        ok(json(packets.map(raw => JSON.parse(raw).evs.length)) == json([2, 1]) &&
            packets.every(raw => encoder.encode(raw).byteLength <= 64 * 1024),
        'direct batching counts UTF-8 bytes and the complete evs envelope')
        ok(got.length == 3, 'UTF-8 byte splitting preserves every direct envelope')
        stop()
    }
    {
        const [emit, replay] = replayListen<[number]>({history: 16})
        const pair = createChannelPair()
        const stop = serveReplayChannel(exposeReplay(replay), pair.a)
        const remote = channelReplayRemote<[number]>(pair.b)
        const got: number[] = []
        let resolveThrown = function resolveThrownLater(_error: unknown) {}
        const thrown = new Promise<unknown>(resolve => { resolveThrown = resolve })
        function rememberConsumerError(error: unknown) { resolveThrown(error) }
        process.once('uncaughtException', rememberConsumerError)
        remote.line.on(function throwingConsumer(ev) {
            got.push(ev.event[0])
            throw new Error('first consumer ' + ev.event[0])
        })
        const siblingGot: number[] = []
        remote.line.on(function throwingSiblingConsumer(ev) {
            siblingGot.push(ev.event[0])
            throw new Error('second consumer ' + ev.event[0])
        })

        emit(1); emit(2); emit(3)
        const thrownResult = await Promise.race([thrown, delay(100).then(() => 'timeout')])
        process.off('uncaughtException', rememberConsumerError)
        const errors = thrownResult instanceof AggregateError
            ? thrownResult.errors.map(error => error.message)
            : []
        ok(json(got) == json([1, 2, 3]) && json(siblingGot) == json([1, 2, 3])
            && json(errors) == json([
                'first consumer 1', 'second consumer 1',
                'first consumer 2', 'second consumer 2',
                'first consumer 3', 'second consumer 3',
            ]), 'every consumer error survives delivery of the complete physical replay batch')
        stop()
    }
    {
        const [emit, replay] = replayListen<[number]>({history: 16})
        const pair = createChannelPair()
        let off: (() => void) | null = null
        pair.a.onMessage(function oldServerMessage(raw) {
            const msg = JSON.parse(raw)
            if (msg.t == 'sub' && !off) {
                off = replay.line.on(ev => pair.a.send(JSON.stringify({t: 'ev', ev})))
            }
        })
        const remote = channelReplayRemote<[number]>(pair.b)
        const got: number[] = []
        remote.line.on(ev => got.push(ev.event[0]))
        emit(1); emit(2); emit(3)
        ok(json(got) == json([1, 2, 3]), 'new client accepts legacy live messages from an old server')
        ok(JSON.parse(pair.bSent[0]).batch == 1, 'new client advertises batching additively on the legacy sub message')
        const closeOldServer = off as (() => void) | null
        closeOldServer?.()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })
