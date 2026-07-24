import {createPeerClient, createPatchRelayJournal, PatchEnvelope, PeerRemote} from '../src/Common/peer/peer-index'
import {
    PEER_PUBLISH_BATCH_MAX_BYTES,
    PEER_PUBLISH_BATCH_MAX_ITEMS,
    peerPublishBatchBytes,
    splitMeasuredPeerPublishEnvelopes,
    splitPeerPublishEnvelopes,
} from '../src/Common/peer/peer-publish-batch'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) {
        fails++
        console.log('  FAIL', message)
        return
    }
    console.log('  OK  ', message)
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(label: string, condition: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (condition()) return
        await delay(5)
    }
    throw new Error('timeout: ' + label)
}

function envelope(seq: number, path: PropertyKey[], value: any): PatchEnvelope {
    return {seq, ts: seq, event: [{path, value, exists: true}]}
}

async function main() {
    console.log('\n[peer-publish-measure] measured partitions retain exact limits and order')
    {
        const small = Array.from({length: PEER_PUBLISH_BATCH_MAX_ITEMS + 1},
            (_, index) => envelope(index, ['small', index], index))
        const binary = new Uint8Array(30 * 1024)
        const mixed = [
            ...small,
            envelope(small.length, ['binary', 0], binary),
            envelope(small.length + 1, ['binary', 1], binary),
            envelope(small.length + 2, ['binary', 2], binary),
            envelope(small.length + 3, ['large'], 'x'.repeat(70 * 1024)),
            envelope(small.length + 4, ['tail'], 'done'),
        ]
        const measured = splitMeasuredPeerPublishEnvelopes(mixed)
        const plain = splitPeerPublishEnvelopes(mixed)

        ok(measured.every(batch => batch.byteLength == peerPublishBatchBytes(batch.items)),
            'each carried byte length equals an independent full wire measurement')
        ok(measured.every(batch => batch.items.length <= PEER_PUBLISH_BATCH_MAX_ITEMS),
            'every partition respects the item ceiling')
        ok(measured.every(batch => batch.byteLength <= PEER_PUBLISH_BATCH_MAX_BYTES || batch.items.length == 1),
            'only indivisible singleton envelopes may exceed the byte ceiling')
        ok(measured.flatMap(batch => batch.items).every((item, index) => Object.is(item, mixed[index])),
            'measured partitioning preserves exact identity and order')
        ok(JSON.stringify(measured.map(batch => batch.items.length))
            == JSON.stringify(plain.map(batch => batch.length)),
        'the measured client path keeps the original splitter boundaries')
    }

    console.log('\n[peer-publish-measure] relay does not trust a stale client measurement')
    {
        const event = envelope(0, [], {value: 'small'})
        const [measured] = splitMeasuredPeerPublishEnvelopes([event])
        event.event[0].value = {value: 'x'.repeat(70 * 1024)}
        const journal = createPatchRelayJournal({history: 8})

        ok(measured.byteLength <= PEER_PUBLISH_BATCH_MAX_BYTES,
            'the pre-mutation client proof was within the limit')
        ok(journal.pushBatch(measured.items) == false && journal.seq() == -1,
            'relay independently remeasures and rejects the mutated oversized input')
        journal.close()
    }

    console.log('\n[peer-publish-measure] relay prepares a complete batch before commit')
    {
        const journal = createPatchRelayJournal({history: 8})
        const delivered: number[] = []
        journal.push(envelope(0, [], {value: 0}))
        journal.remote.line.on(function rememberAtomicDelivery(event) { delivered.push(event.seq) })
        const invalid = {
            seq: 2,
            ts: 2,
            event: [{path: ['invalid'], exists: 'yes', value: 2}],
        } as unknown as PatchEnvelope

        let threw = false
        let result: unknown
        try {
            result = journal.pushBatch([
                envelope(1, ['value'], 1),
                invalid,
            ])
        } catch {
            threw = true
        }

        ok(!threw && result == false, 'deep-invalid suffix rejects as a malformed batch')
        ok(journal.seq() == 0 && journal.snapshot().value == 0 && delivered.length == 0,
            'deep-invalid suffix leaves fold, journal coordinate and live line untouched')
        ok(journal.push({...invalid, seq: 1}) == false,
            'the legacy single-envelope path rejects the same malformed Store patch')
        ok(journal.seq() == 0 && journal.snapshot().value == 0 && delivered.length == 0,
            'malformed single publication also leaves fold, coordinate and live line untouched')
        journal.close()
    }

    console.log('\n[peer-publish-measure] live client pays one legacy-size walk per envelope')
    {
        type Counted = {payload: {id: number, text: string}}
        type State = {a: Counted | null, b: Counted | null, c: Counted | null}
        const sent: PatchEnvelope[][] = []
        let propertyReads = 0

        function countedValue(id: number): Counted {
            const value = {} as Counted
            Object.defineProperty(value, 'payload', {
                enumerable: true,
                get() {
                    propertyReads++
                    return {id, text: 'v'.repeat(128)}
                },
            })
            return value
        }

        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: async () => true,
            async publishBatch(items) {
                sent.push(items)
                return true
            },
            peers: {
                owner: {
                    line: {on: () => () => {}},
                    since: async () => null,
                    keyframe: async () => null,
                },
            },
        }
        const client = createPeerClient<State>({
            remote,
            account: 'owner',
            initial: {a: null, b: null, c: null},
            drain: flush => flush(),
        })
        await waitFor('warmup batch', () => sent.length == 1)
        sent.length = 0
        propertyReads = 0

        client.store.state.a = countedValue(1)
        client.store.state.b = countedValue(2)
        client.store.state.c = countedValue(3)
        await waitFor('live batch', () => sent.length == 1)

        ok(sent[0].length == 3, 'three synchronous writes remain one ordered publishBatch')
        ok(propertyReads == 3,
            `client sizing traversed each source value once, without split/check re-walks (${propertyReads} reads)`)
        client.close()
    }

    console.log('\n[peer-publish-measure] client close is terminal for publish work and resync')
    {
        type State = {value: number}
        let sends = 0
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: async () => { sends++; return true },
            publishBatch: async () => { sends++; return true },
            peers: {
                owner: {
                    line: {on: () => () => {}},
                    since: async () => null,
                    keyframe: async () => null,
                    seq: async () => -1,
                },
            },
        }
        const client = createPeerClient<State>({
            remote,
            account: 'owner',
            initial: {value: 0},
            drain: flush => flush(),
        })
        await waitFor('terminal warmup', () => sends == 1)
        sends = 0
        client.store.state.value = 1
        client.close()
        client.store.state.value = 2
        await delay(0)
        const closedResync = await client.resync().then(
            () => 'resolved',
            error => String(error),
        )

        ok(sends == 0, 'close discards a buffered batch and later Store writes cannot send')
        ok(closedResync.includes('peer client closed'), 'resync after close rejects with the terminal reason')
    }
    {
        type State = {value: number}
        let sends = 0
        let seqReads = 0
        let releasePublish!: (value: true) => void
        let block = false
        const publishGate = new Promise<true>(function waitForPublishRelease(resolve) { releasePublish = resolve })
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: async () => true,
            async publishBatch() {
                sends++
                if (block) return publishGate
                return true
            },
            peers: {
                owner: {
                    line: {on: () => () => {}},
                    since: async () => null,
                    keyframe: async () => null,
                    async seq() { seqReads++; return -1 },
                },
            },
        }
        const client = createPeerClient<State>({
            remote,
            account: 'owner',
            initial: {value: 0},
            drain: flush => flush(),
        })
        await waitFor('queued barrier warmup', () => sends == 1)
        block = true
        client.store.state.value = 1
        await waitFor('blocked live publish', () => sends == 2)
        const pending = client.resync()
        void client.resync()
        client.close()
        const settled = await Promise.race([
            pending.then(() => 'resolved', error => String(error)),
            delay(100).then(() => 'timeout'),
        ])
        releasePublish(true)
        await delay(0)

        ok(settled.includes('peer client closed') && seqReads == 0,
            'close rejects queued resync barriers without waiting for a hung publish')
        ok(sends == 2, 'completion of an in-flight RPC starts no post-close publication')
    }
    {
        type State = {value: number}
        let sends = 0
        let seqReads = 0
        let releaseSeq!: (value: number) => void
        const seqGate = new Promise<number>(function waitForSeqRelease(resolve) { releaseSeq = resolve })
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            publish: async () => true,
            async publishBatch() { sends++; return true },
            peers: {
                owner: {
                    line: {on: () => () => {}},
                    since: async () => null,
                    keyframe: async () => null,
                    async seq() { seqReads++; return seqGate },
                },
            },
        }
        const client = createPeerClient<State>({
            remote,
            account: 'owner',
            initial: {value: 0},
            drain: flush => flush(),
        })
        await waitFor('active barrier warmup', () => sends == 1)
        const pending = client.resync()
        await waitFor('active seq read', () => seqReads == 1)
        client.close()
        const settled = await Promise.race([
            pending.then(() => 'resolved', error => String(error)),
            delay(100).then(() => 'timeout'),
        ])
        releaseSeq(-1)
        await delay(0)

        ok(settled.includes('peer client closed'), 'close rejects an already running resync barrier')
        ok(sends == 1, 'a late coordinate result cannot start repair after close')
    }

    console.log('\n[peer-publish-measure] slow resume relay keeps a bounded latest-state tail')
    {
        type State = {value: number}
        const journal = createPatchRelayJournal({history: 128})
        let releaseFirst!: () => void
        const firstGate = new Promise<void>(function wait(resolve) { releaseFirst = resolve })
        let calls = 0
        const remote: PeerRemote = {
            signal: {send: async () => false, signals: {on: () => () => {}}},
            async publish(item) {
                calls++
                if (calls == 1) await firstGate
                return journal.push(item)
            },
            async publishBatch(items) {
                calls++
                if (calls == 1) await firstGate
                return journal.pushBatch(items)
            },
            peers: {
                owner: {
                    ...journal.remote,
                    seq: journal.seq,
                },
            },
        }
        const client = createPeerClient<State>({
            remote,
            account: 'owner',
            initial: {value: 0},
            drain: flush => flush(),
        })
        await waitFor('blocked warmup publish', () => calls == 1)
        for (let value = 1; value <= 5000; value++) client.store.state.value = value
        await delay(0)
        ok(calls == 1, 'a blocked transport starts no parallel publish calls')
        releaseFirst()
        await waitFor('bounded resume queue converges', () => journal.seq() == 5000)
        ok(calls <= 20, 'five thousand pending versions compact to a bounded root-plus-tail queue (' + calls + ' calls)')
        ok((journal.snapshot() as State).value == 5000, 'compacted pending work preserves the latest Store state')
        client.close()
        journal.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportPeerPublishMeasureFailure(error) {
    console.error(error)
    process.exit(1)
})
