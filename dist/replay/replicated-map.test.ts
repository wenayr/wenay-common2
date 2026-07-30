// =====================================================================
// Replicated Map: in-process contract oracle
// =====================================================================

import {
    createReplicatedMap, createStore, exposeStoreReplay, flushReactive,
    followReplicatedMap, FollowedReplicatedMap, ReplicatedMapChange,
    ReplicatedMapCheckpoint, ReplicatedMapRemote, ReplicatedMapStatus, StorePatch, toRaw,
} from '../src/Common/Observe'
import {createTransportLifecycle, RPC_TRANSPORT_LIFECYCLE} from '../src/Common/events/transport-lifecycle'
import * as storeProjection from '../src/Common/Observe/store-projection'
import {decodeStoreReplayBatchV2, encodeStoreReplayBatchV2} from '../src/Common/Observe/store-replay-codec'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function json(value: any) {
    return JSON.stringify(value)
}

function owns(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function delay(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

type Row = {id: string, n: number}
type Value = Row | undefined

function keyOf(value: Value) {
    return value == undefined ? 'UNDEF' : value.id
}

function row(id: string, n: number) {
    return {id, n}
}

async function settle(follower: FollowedReplicatedMap<any>) {
    await flushReactive(follower.debug.store.state)
    await delay(0)
}

function threw(action: () => void) {
    try { action(); return false }
    catch { return true }
}

function createSwitchableMapRemote<V>(initial: ReplicatedMapRemote<V>) {
    const lifecycle = createTransportLifecycle(true)
    const listeners = new Set<(event: any) => void>()
    let current = initial
    let offCurrent = function offCurrentLater() {}

    function bindCurrent() {
        offCurrent()
        offCurrent = current.line.on(function forwardSwitchableMapEvent(event) {
            for (const listener of [...listeners]) listener(event)
        })
    }
    bindCurrent()

    const remote = {
        line: {
            on(cb: (event: any) => void) {
                listeners.add(cb)
                return function offSwitchableMapLine() { listeners.delete(cb) }
            },
        },
        since(seq: number) { return current.since(seq) },
        keyframe() { return current.keyframe() },
        frame(seq: number, hint?: unknown) { return current.frame!(seq, hint) },
        describe() { return current.describe() },
    } as ReplicatedMapRemote<V>
    Object.defineProperty(remote, RPC_TRANSPORT_LIFECYCLE, {value: lifecycle.api})

    function switchTo(next: ReplicatedMapRemote<V>) {
        lifecycle.control.disconnect('test switch')
        current = next
        bindCurrent()
        lifecycle.control.connect()
    }

    function close() {
        offCurrent()
        listeners.clear()
        lifecycle.control.close('test close')
    }

    return {remote, switchTo, close}
}

function createDescriptorRaceRemote<V>(first: ReplicatedMapRemote<V>, next: ReplicatedMapRemote<V>) {
    let current = first
    let switched = false
    return {
        line: {
            on(cb: (event: any) => void) { return current.line.on(cb) },
        },
        since(seq: number) { return current.since(seq) },
        keyframe() { return current.keyframe() },
        frame(seq: number, hint?: unknown) { return current.frame!(seq, hint) },
        async describe() {
            const descriptor = await current.describe()
            if (!switched) {
                switched = true
                current = next
            }
            return descriptor
        },
    } as ReplicatedMapRemote<V>
}

function createManualMapRemote<V>(delivery: 'latest' | 'lossless' = 'latest') {
    const listeners = new Set<(event: any) => void>()
    let seq = -1
    const lineId = `manual-${delivery}`
    const remote = {
        line: {
            on(cb: (event: any) => void) {
                listeners.add(cb)
                return function offManualMapLine() { listeners.delete(cb) }
            },
        },
        since() { return [] },
        keyframe() { return null },
        frame() { return [] },
        describe() {
            return {replicatedMap: {version: 1 as const, delivery, lineId}}
        },
    } as unknown as ReplicatedMapRemote<V>

    function emit(patches: readonly StorePatch[]) {
        const event = encodeStoreReplayBatchV2({seq: ++seq, ts: Date.now(), event: [patches]})
        for (const listener of [...listeners]) listener(event)
    }

    return {remote, emit}
}

async function main() {
    console.log('\n[replicated-map] wide null-prototype keyframe')
    {
        const initial = Array.from({length: 1_500}, function createWideRow(_, index) {
            return row('K' + index, index)
        })
        const producer = createReplicatedMap<Row>({
            keyOf: value => value.id,
            initial,
            delivery: 'latest',
        })
        const follower = followReplicatedMap(producer.api)

        await follower.ready
        await settle(follower)

        const producerSnapshot = producer.control.snapshot()
        const followerSnapshot = follower.snapshot()
        ok(Object.keys(followerSnapshot).length == initial.length
            && follower.get('K1499')?.n == 1_499
            && Object.getPrototypeOf(producerSnapshot) == null
            && Object.getPrototypeOf(followerSnapshot) == null,
        'batch keyframe preserves and materializes more than 1,000 Replicated Map keys')

        follower.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] latest delivery, keys and lifecycle')
    {
        const producer = createReplicatedMap<Value>({
            keyOf,
            initial: [row('A', 0), row('B', 0)],
            delivery: 'latest',
        })
        const batches: ReplicatedMapChange<Value>[] = []
        const batchSnapshots: Record<string, Value>[] = []
        const batchUndefinedPresence: boolean[] = []
        const statuses: ReplicatedMapStatus[] = []
        const keyA: {value: Value, exists: boolean}[] = []
        const keyB: {value: Value, exists: boolean}[] = []
        const keyUndefined: {value: Value, exists: boolean}[] = []
        let follower!: FollowedReplicatedMap<Value>

        follower = followReplicatedMap(producer.api, {
            onBatch(change) {
                batches.push(change)
                batchSnapshots.push(follower.snapshot())
                batchUndefinedPresence.push(follower.has('UNDEF'))
            },
            onStatus(status) {
                statuses.push(status)
            },
        })
        const offA = follower.onKey('A', function collectA(value, ctx) {
            keyA.push({value, exists: ctx.exists})
        })
        const offB = follower.onKey('B', function collectB(value, ctx) {
            keyB.push({value, exists: ctx.exists})
        })
        const offUndefined = follower.onKey('UNDEF', function collectUndefined(value, ctx) {
            keyUndefined.push({value, exists: ctx.exists})
        })

        await follower.ready
        await settle(follower)

        ok(json(follower.snapshot()) == json({A: row('A', 0), B: row('B', 0)}),
            'initial keyframe becomes the latest snapshot')
        ok(follower.status().state == 'live' && follower.status().ready,
            'ready resolves with a live/ready status')
        ok(follower.status().delivery == 'latest' && follower.status().replayMode == 'v2',
            'descriptor negotiates latest delivery over compact batch replay')
        ok(statuses[0]?.state == 'connecting' && statuses.some(status => status.state == 'live' && status.ready),
            'status stream reports connecting and live states')
        ok(keyA.length == 1 && (keyA[0].value as Row).n == 0 && keyA[0].exists,
            'onKey observes an initial existing key')

        batches.length = 0
        batchSnapshots.length = 0
        batchUndefinedPresence.length = 0
        keyA.length = 0
        keyUndefined.length = 0

        producer.control.setMany([
            row('A', 1),
            row('A', 2),
            undefined,
            row('a.b', 7),
        ])
        await settle(follower)

        const setMany = batches[0]
        ok(batches.length == 1, 'latest setMany publishes one batch callback')
        ok(json(setMany?.operations.map(operation => [operation.type, operation.key]))
            == json([['set', 'A'], ['set', 'UNDEF'], ['set', 'a.b']]),
        'latest setMany collapses a duplicate key to its final operation')
        ok((setMany?.operations[0] as any)?.value.n == 2 && setMany?.set.length == 3,
            'latest setMany exposes the final value in operations and set projection')
        ok(setMany?.set[1]?.[0] == 'UNDEF' && setMany.set[1][1] == undefined
            && owns(setMany.operations[1] as object, 'value'),
        'an own undefined value remains a set operation rather than a delete')
        ok(follower.has('UNDEF') && follower.get('UNDEF') == undefined
            && owns(follower.snapshot(), 'UNDEF'),
        'has and snapshot distinguish an own undefined value from absence')
        ok(follower.has('a.b') && !follower.has('a') && (follower.get('a.b') as Row).n == 7,
            'a dotted key remains one literal top-level key')
        ok((batchSnapshots[0].A as Row).n == 2 && owns(batchSnapshots[0], 'UNDEF')
            && batchSnapshots[0]['a.b'] != undefined && batchUndefinedPresence[0],
        'onBatch runs after every patch in its envelope is applied')
        ok(keyA.length == 1 && (keyA[0].value as Row).n == 2 && keyA[0].exists,
            'onKey coalesces the duplicate latest write to the final value')
        ok(keyUndefined.length == 1 && keyUndefined[0].value == undefined && keyUndefined[0].exists,
            'onKey context distinguishes stored undefined from deletion')

        ;(setMany.operations[0] as any).value.n = 777
        ok((producer.control.get('A') as Row).n == 2 && (follower.get('A') as Row).n == 2,
            'consumer mutation of a delivered change cannot mutate producer or materialized follower state')

        batches.length = 0
        keyB.length = 0
        producer.control.deleteMany(['B', 'missing'])
        await settle(follower)

        ok(batches.length == 1 && json(batches[0].delete) == json(['B'])
            && json(batches[0].operations) == json([{type: 'delete', key: 'B'}]),
        'deleteMany reports an existing delete and ignores a missing key')
        ok(!follower.has('B') && keyB.length == 1 && keyB[0].value == undefined && !keyB[0].exists,
            'delete removes the key and onKey reports exists false')

        batches.length = 0
        batchSnapshots.length = 0
        producer.control.replaceAll([
            row('A', 9),
            row('A', 10),
            row('NEXT', 11),
        ])
        await settle(follower)

        ok(batches.length == 1, 'replaceAll publishes one batch callback')
        ok(json(batches[0].operations.map(operation => [operation.type, operation.key]))
            == json([['delete', 'UNDEF'], ['delete', 'a.b'], ['set', 'A'], ['set', 'NEXT']]),
        'replaceAll keeps cross-kind delete/set order and final duplicate value')
        ok(json(follower.snapshot()) == json({A: row('A', 10), NEXT: row('NEXT', 11)})
            && json(batchSnapshots[0]) == json(follower.snapshot()),
        'replaceAll materializes the exact final snapshot before onBatch')
        ok(json(producer.control.snapshot()) == json(follower.snapshot()),
            'producer and follower snapshots agree after replaceAll')

        for (const reserved of ['__proto__', 'constructor', 'prototype']) {
            ok(threw(function setReservedKey() { producer.control.set(row(reserved, 1)) }),
                `reserved key ${reserved} is rejected`)
        }
        ok(threw(function atomicallyRejectReservedDelete() {
            producer.control.deleteMany(['A', '__proto__'])
        }) && producer.control.has('A'), 'reserved delete validation happens before mutation')

        const snapshotBeforeClose = json(follower.snapshot())
        const batchesBeforeClose = batches.length
        const keyEventsBeforeClose = keyA.length + keyB.length + keyUndefined.length
        follower.close()
        follower.close()
        producer.control.setMany([row('A', 100), row('AFTER', 1)])
        await delay(10)

        ok(follower.status().state == 'closed', 'follower close is idempotent and reports closed')
        ok(json(follower.snapshot()) == snapshotBeforeClose && batches.length == batchesBeforeClose
            && keyA.length + keyB.length + keyUndefined.length == keyEventsBeforeClose,
        'closed follower receives no later snapshots, batches or key events')

        offA()
        offB()
        offUndefined()
        producer.control.close()
        producer.control.close()
        ok(threw(function mutateClosedProducer() { producer.control.set(row('A', 200)) }),
            'producer close is idempotent and rejects later mutation')
    }

    console.log('\n[replicated-map] latest hot paths keep ownership and stay cold without consumers')
    {
        type ProbeRow = Row & {payload: number[]}
        function probeRow(id: string, n: number, read: () => void): ProbeRow {
            const value = {id, n} as ProbeRow
            const payload = [n]
            Object.defineProperty(value, 'payload', {
                configurable: true,
                enumerable: true,
                get() {
                    read()
                    return payload
                },
            })
            return value
        }

        const latestReads = Array.from({length: 64}, function noReadsYet() { return 0 })
        const latestValues = latestReads.map(function makeLatestProbe(_reads, index) {
            return probeRow('LATEST', index, function countLatestCloneRead() { latestReads[index]++ })
        })
        const latest = createReplicatedMap<ProbeRow>({
            keyOf(value) { return value.id },
            delivery: 'latest',
        })
        latest.control.setMany(latestValues)
        latestValues[latestValues.length - 1].payload[0] = -1

        ok(latestReads.slice(0, -1).every(reads => reads == 0)
            && latestReads[latestReads.length - 1] > 0,
            'latest collapses raw duplicate-key winners before cloning any discarded value')
        ok(latest.control.get('LATEST')?.payload[0] == 63,
            'latest clones its changed winner before returning ownership to the caller')
        latest.control.close()

        const losslessReads = Array.from({length: 4}, function noLosslessReadsYet() { return 0 })
        const losslessValues = losslessReads.map(function makeLosslessProbe(_reads, index) {
            return probeRow('LOSSLESS', index, function countLosslessCloneRead() { losslessReads[index]++ })
        })
        const lossless = createReplicatedMap<ProbeRow>({
            keyOf(value) { return value.id },
            delivery: 'lossless',
        })
        lossless.control.setMany(losslessValues)
        ok(losslessReads.every(reads => reads > 0),
            'lossless still clones every input eagerly and preserves per-event ownership')
        lossless.control.close()

        const manual = createManualMapRemote<Row>()
        const follower = followReplicatedMap(manual.remote)
        await follower.ready

        const originalClone = storeProjection.cloneStoreProjectionValue
        let projectedClones = 0
        ;(storeProjection as any).cloneStoreProjectionValue = function countReplicatedMapProjectionClone<T>(value: T) {
            projectedClones++
            return originalClone(value)
        }
        try {
            manual.emit([{path: ['A'], exists: true, value: row('A', 1)}])
            await settle(follower)
            ok(projectedClones == 0,
                'a follower with no batch/key consumers skips public change and key value cloning')

            const batches: ReplicatedMapChange<Row>[] = []
            const offBatch = follower.batches.on(function collectLateBatch(change) { batches.push(change) })
            ok(batches.length == 0, 'a late batch subscriber receives no historical projection')
            manual.emit([{path: ['B'], exists: true, value: row('B', 2)}])
            await settle(follower)
            ok(projectedClones == 1 && batches.length == 1 && batches[0].set[0][0] == 'B',
                'an active batch subscriber enables one detached projection for the next envelope')
            offBatch()

            projectedClones = 0
            const keyValues: Row[] = []
            const offKey = follower.onKey('C', function collectLateKey(value, ctx) {
                if (ctx.exists) keyValues.push(value!)
            })
            ok(keyValues.length == 0, 'a late key subscriber receives no historical key notification by default')
            manual.emit([{path: ['C'], exists: true, value: row('C', 3)}])
            await settle(follower)
            ok(projectedClones == 1 && keyValues.length == 1 && keyValues[0].n == 3,
                'an active key subscriber enables one detached value projection for its next change')
            offKey()
        } finally {
            ;(storeProjection as any).cloneStoreProjectionValue = originalClone
            follower.close()
        }
    }

    console.log('\n[replicated-map] latest full snapshots publish only semantic deltas')
    {
        type SnapshotRow = Row & {quote: {bid: number, ask: number}}
        const size = 500
        const revisions = Array.from({length: size}, function initialRevision() { return 0 })

        function freshSnapshot() {
            return revisions.map(function createFreshSnapshotRow(revision, index): SnapshotRow {
                return {
                    id: 'S' + index,
                    n: revision,
                    quote: {bid: index + revision, ask: index + revision + 1},
                }
            })
        }

        const producer = createReplicatedMap<SnapshotRow>({
            keyOf(value) { return value.id },
            initial: freshSnapshot(),
            delivery: 'latest',
        })
        let published = 0
        const offLine = producer.api.line.on(function countPublishedSnapshotDelta() { published++ })
        const originalClone = storeProjection.cloneStoreProjectionValue
        let projectedClones = 0
        ;(storeProjection as any).cloneStoreProjectionValue = function countSnapshotProjectionClone<T>(value: T) {
            projectedClones++
            return originalClone(value)
        }
        try {
            producer.control.replaceAll(freshSnapshot())
            ok(projectedClones == 0 && published == 0,
                'a fresh 500-key deep-equal snapshot performs no projection clones or replay writes')

            for (const changedCount of [20, 40, 50]) {
                for (let index = 0; index < changedCount; index++) {
                    const keyIndex = (index * 37 + changedCount * 11) % size
                    revisions[keyIndex]++
                }
                projectedClones = 0
                published = 0
                const next = freshSnapshot()
                producer.control.replaceAll(next)

                ok(projectedClones == changedCount * 2 && published == 1,
                    `a fresh 500-key snapshot with ${changedCount} changes clones only Store/wire values `
                    + `and publishes exactly ${changedCount} patches`)
                next[0].quote.bid = -1
            }
        } finally {
            ;(storeProjection as any).cloneStoreProjectionValue = originalClone
            offLine()
            producer.control.close()
        }
        ok(producer.control.get('S0')?.quote.bid != -1,
            'full-snapshot inputs stay detached after selective reconciliation')
    }

    console.log('\n[replicated-map] latest key tracking scans only root reseeds')
    {
        const manual = createManualMapRemote<Row>()
        const follower = followReplicatedMap(manual.remote)
        await follower.ready
        const rawState = toRaw(follower.debug.store.state)
        const nativeOwnKeys = Reflect.ownKeys
        let stateScans = 0
        ;(Reflect as any).ownKeys = function countReplicatedMapStateScans(value: object) {
            if (value == rawState) stateScans++
            return nativeOwnKeys(value)
        }
        try {
            manual.emit([
                {path: ['A'], exists: true, value: row('A', 1)},
                {path: ['B'], exists: true, value: row('B', 2)},
                {path: ['A'], exists: false, value: undefined},
                {path: ['C'], exists: true, value: row('C', 3)},
            ])
            ok(stateScans == 0,
                'top-level add/delete tracking updates known keys without rescanning the materialized root')

            const changes: ReplicatedMapChange<Row>[] = []
            const offBatch = follower.batches.on(function collectReseedChange(change) { changes.push(change) })
            stateScans = 0
            manual.emit([{path: [], exists: true, value: {D: row('D', 4)}}])
            ok(stateScans == 2,
                'a root reseed scans the root once for Store replacement and once for map key validation/projection')
            ok(json(changes[0].operations.map(operation => [operation.type, operation.key]))
                == json([['delete', 'B'], ['delete', 'C'], ['set', 'D']]),
            'a root reseed deletes incrementally tracked old keys and adds the exact new key set')

            changes.length = 0
            stateScans = 0
            manual.emit([
                {path: ['E'], exists: true, value: row('E', 5)},
                {path: ['D'], exists: false, value: undefined},
            ])
            const operations = changes.flatMap(change => change.operations)
            ok(stateScans == 0 && json(operations.map(operation => [operation.type, operation.key]))
                == json([['set', 'E'], ['delete', 'D']]),
            'post-reseed non-root additions and deletions remain incremental and correctly ordered')
            offBatch()
        } finally {
            ;(Reflect as any).ownKeys = nativeOwnKeys
            follower.close()
        }
    }

    console.log('\n[replicated-map] latest compares rich and binary values without false equality')
    {
        type RichRow = {id: string, bytes: ArrayBuffer, pattern: RegExp}
        function richRow(byte: number, pattern: RegExp): RichRow {
            return {id: 'RICH', bytes: new Uint8Array([byte]).buffer, pattern}
        }
        const producer = createReplicatedMap<RichRow>({
            keyOf(value) { return value.id },
            initial: [richRow(1, /one/g)],
            delivery: 'latest',
        })
        const follower = followReplicatedMap(producer.api)
        await follower.ready
        producer.control.set(richRow(2, /two/i))
        await settle(follower)
        const producerValue = producer.control.get('RICH')!
        const followerValue = follower.get('RICH')!
        ok(new Uint8Array(producerValue.bytes)[0] == 2 && new Uint8Array(followerValue.bytes)[0] == 2
            && producerValue.pattern.source == 'two' && followerValue.pattern.flags == 'i',
        'latest never drops changed ArrayBuffer or RegExp values as falsely equal')
        follower.close()
        producer.control.close()

        const typedProducer = createReplicatedMap<number | string>({
            keyOf() { return 'VALUE' },
            initial: [1],
            delivery: 'latest',
        })
        const typedFollower = followReplicatedMap(typedProducer.api)
        await typedFollower.ready
        typedProducer.control.set('1')
        await settle(typedFollower)
        ok(typeof typedProducer.control.get('VALUE') == 'string'
            && typeof typedFollower.get('VALUE') == 'string',
        'latest uses same-value comparison and does not drop a number-to-string value change')
        typedFollower.close()
        typedProducer.control.close()

        type CycleRow = {id: string, self?: CycleRow}
        const oneCycle: CycleRow = {id: 'CYCLE'}
        oneCycle.self = oneCycle
        const cycleProducer = createReplicatedMap<CycleRow>({
            keyOf(value) { return value.id },
            initial: [oneCycle],
            delivery: 'latest',
        })
        const cycleFollower = followReplicatedMap(cycleProducer.api)
        await cycleFollower.ready
        const twoCycle: CycleRow = {id: 'CYCLE'}
        const cycleTail: CycleRow = {id: 'nested'}
        twoCycle.self = cycleTail
        cycleTail.self = twoCycle
        cycleProducer.control.set(twoCycle)
        await settle(cycleFollower)
        const producerCycle = cycleProducer.control.get('CYCLE')!
        const followerCycle = cycleFollower.get('CYCLE')!
        ok(producerCycle.self != producerCycle && producerCycle.self?.self == producerCycle
            && followerCycle.self != followerCycle && followerCycle.self?.self == followerCycle,
        'latest does not collapse cyclic values with different graph topology')
        cycleFollower.close()
        cycleProducer.control.close()
    }

    console.log('\n[replicated-map] lossless duplicate ordering')
    {
        function primitiveKey(value: string) {
            return value.slice(0, 1)
        }

        const producer = createReplicatedMap<string>({keyOf: primitiveKey, delivery: 'lossless'})
        const batches: ReplicatedMapChange<string>[] = []
        const batchSnapshots: Record<string, string>[] = []
        let follower!: FollowedReplicatedMap<string>
        follower = followReplicatedMap(producer.api, {
            delivery: 'lossless',
            onBatch(change) {
                batches.push(change)
                batchSnapshots.push(follower.snapshot())
            },
        })
        await follower.ready
        await settle(follower)
        batches.length = 0
        batchSnapshots.length = 0

        producer.control.setMany(['A:first', 'A:same', 'A:same', 'B:only'])
        await settle(follower)

        ok(batches.length == 1, 'lossless setMany publishes one batch callback')
        ok(json(batches[0].operations) == json([
            {type: 'set', key: 'A', value: 'A:first'},
            {type: 'set', key: 'A', value: 'A:same'},
            {type: 'set', key: 'A', value: 'A:same'},
            {type: 'set', key: 'B', value: 'B:only'},
        ]), 'lossless operations preserve duplicate-key order and identical primitive writes')
        ok(json(batches[0].set) == json([
            ['A', 'A:first'], ['A', 'A:same'], ['A', 'A:same'], ['B', 'B:only'],
        ]), 'lossless set projection preserves every write in order')
        ok(json(batchSnapshots[0]) == json({A: 'A:same', B: 'B:only'})
            && json(follower.snapshot()) == json(batchSnapshots[0]),
        'lossless onBatch still sees the fully applied final snapshot')

        follower.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] delayed batch keeps snapshot and seq atomic')
    {
        const producer = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            delivery: 'lossless',
            replay: {batch: {maxDelayMs: 10_000}},
        })
        producer.control.set(row('A', 1))
        const batches: ReplicatedMapChange<Row>[] = []
        const follower = followReplicatedMap(producer.api, {
            delivery: 'lossless',
            onBatch(change) { batches.push(change) },
        })
        await follower.ready
        await settle(follower)
        const checkpoint = follower.checkpoint()
        producer.control.flush()
        await settle(follower)
        ok(follower.get('A')?.n == 1 && checkpoint.snapshot.A?.n == 1
            && checkpoint.cursor.seq == follower.seq() && batches.length == 1,
        'catch-up flushes delayed patches before keyframe, so one set is delivered exactly once at its committed seq')
        follower.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] latest retry and injected Store observation')
    {
        let failPrecommit = true
        const producer = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            delivery: 'latest',
            replay: {
                onJournalBatch() {
                    if (!failPrecommit) return
                    failPrecommit = false
                    throw new Error('temporary journal failure')
                },
            },
        })
        const follower = followReplicatedMap(producer.api)
        await follower.ready
        let failed = false
        try { producer.control.set(row('A', 1)) }
        catch { failed = true }
        producer.control.set(row('A', 1))
        await settle(follower)

        ok(failed && follower.get('A')?.n == 1,
            'an equal retry flushes a retained latest precommit instead of leaving authority split')

        follower.close()
        producer.control.close()

        const injectedStore = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const injected = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            store: injectedStore,
            delivery: 'latest',
        })
        const injectedFollower = followReplicatedMap(injected.api)
        await injectedFollower.ready
        injectedStore.state.OUTSIDE = row('OUTSIDE', 2)
        await flushReactive(injectedStore.state)
        await settle(injectedFollower)

        ok(injectedFollower.get('OUTSIDE')?.n == 2,
            'an injected latest Store keeps its normal patch source, so retained-reference writes are journaled')

        injectedFollower.close()
        injected.control.close()

        const measuredStore = createStore<Record<string, Row>>({A: row('A', 1)}, {drain: 'micro'})
        const measuredSnapshot = measuredStore.snapshot
        let measuredSnapshots = 0
        measuredStore.snapshot = function countMeasuredSnapshot() {
            measuredSnapshots++
            return measuredSnapshot()
        }
        const measured = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            store: measuredStore,
            delivery: 'latest',
        })
        ok(measuredSnapshots == 1,
            'an injected map takes one detached baseline snapshot at construction')
        measuredStore.state.A = row('A', 2)
        await flushReactive(measuredStore.state)
        ok(measuredSnapshots == 1,
            'a drained top-level injected patch updates the baseline without cloning the complete Store')
        measured.control.close()
        ok(measuredSnapshots == 2,
            'injected close still takes one current snapshot for the final pending-drain comparison')

        const replacedStore = createStore<Record<string, Row>>({A: row('A', 1)}, {drain: 'micro'})
        const replacedSnapshot = replacedStore.snapshot
        let replacedSnapshots = 0
        replacedStore.snapshot = function countReplacedSnapshot() {
            replacedSnapshots++
            return replacedSnapshot()
        }
        const replaced = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            store: replacedStore,
            delivery: 'latest',
        })
        replacedStore.replace({B: row('B', 3)})
        await flushReactive(replacedStore.state)
        ok(replacedSnapshots == 1,
            'a drained multi-key injected batch updates its baseline without a complete Store snapshot')
        replaced.control.close()
        ok(replacedSnapshots == 2,
            'the incrementally updated multi-key baseline suppresses a duplicate final close publication')

        const closingStore = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const closing = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            store: closingStore,
            delivery: 'latest',
        })
        const closingFollower = followReplicatedMap(closing.api)
        await closingFollower.ready
        closing.control.set(row('FINAL', 4))
        closing.control.close()
        await settle(closingFollower)
        ok(closingFollower.get('FINAL')?.n == 4,
            'injected micro-drain Store publishes its final pending state before producer close')
        closingFollower.close()

        ok(threw(function rejectInjectedLosslessStore() {
            createReplicatedMap({
                keyOf(value: Row) { return value.id },
                store: createStore<Record<string, Row>>({}),
                delivery: 'lossless',
            } as any)
        }), 'runtime callers cannot combine an externally mutable Store with lossless delivery')

        ok(threw(function rejectInjectedNonPlainRoot() {
            createReplicatedMap({
                keyOf(value: Row) { return value.id },
                store: createStore(new Date(0) as any),
                delivery: 'latest',
            } as any)
        }), 'an injected Store must expose a plain keyed root')

        const isolated = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            delivery: 'latest',
        })
        const offWire = isolated.api.line.on(function mutateDeliveredWire(wire) {
            const event = decodeStoreReplayBatchV2(wire)
            event.event[0][0].path[0] = 'CORRUPT'
            event.event[0][0].value.n = 999
        })
        isolated.control.set(row('SAFE', 3))
        const honestTail = decodeStoreReplayBatchV2((await isolated.api.since(0))![0])
        ok(honestTail.event[0][0].path[0] == 'SAFE' && honestTail.event[0][0].value.n == 3
            && isolated.control.get('SAFE')?.n == 3,
        'wire consumers receive detached patches and cannot mutate the retained journal or authority')
        offWire()
        isolated.control.close()
    }

    console.log('\n[replicated-map] lossless history gap is strict')
    {
        const producer = createReplicatedMap<string>({
            keyOf(value) { return value.slice(0, 1) },
            delivery: 'lossless',
            replay: {history: 1},
        })
        producer.control.set('A:1')
        producer.control.set('B:1')
        producer.control.set('C:1')
        const lineId = (await producer.api.describe()).replicatedMap.lineId

        const errors: unknown[] = []
        const follower = followReplicatedMap(producer.api, {
            delivery: 'lossless',
            checkpoint: {
                snapshot: {},
                cursor: {lineId, delivery: 'lossless', replayMode: 'v2', seq: 0},
            },
            onError(error) { errors.push(error) },
        })
        await follower.ready

        ok(follower.status().state == 'error' && errors.length == 1
            && String(errors[0]).includes('gap policy forbids keyframe reset'),
        'lossless follower rejects an evicted tail instead of accepting a keyframe')
        ok(follower.status().replayMode == 'v2',
            'terminal status records the negotiated replay mode even before any sequence is delivered')

        follower.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] lossless cursor line mismatch is terminal')
    {
        const producer = createReplicatedMap<string>({
            keyOf(value) { return value.slice(0, 1) },
            delivery: 'lossless',
        })
        const lineId = (await producer.api.describe()).replicatedMap.lineId

        const lineErrors: unknown[] = []
        const foreign = followReplicatedMap(producer.api, {
            checkpoint: {
                snapshot: {},
                cursor: {lineId: lineId + '-other', delivery: 'lossless', replayMode: 'v2', seq: 0},
            },
            onError(error) { lineErrors.push(error) },
        })
        await foreign.ready
        ok(foreign.status().state == 'error' && lineErrors.length == 1
            && String(lineErrors[0]).includes('cannot resume another replay line'),
        'lossless resume rejects a checkpoint from another producer line')

        foreign.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] checkpoint binds snapshot, line and replay coordinates')
    {
        const atomicProducer = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            delivery: 'lossless',
        })
        let callbackCheckpoint: ReplicatedMapCheckpoint<Row> | undefined
        let atomicFollower!: FollowedReplicatedMap<Row>
        atomicFollower = followReplicatedMap(atomicProducer.api, {
            delivery: 'lossless',
            onBatch() { callbackCheckpoint = atomicFollower.checkpoint() },
        })
        await atomicFollower.ready
        callbackCheckpoint = undefined
        atomicProducer.control.set(row('ATOMIC', 1))
        await settle(atomicFollower)
        ok(callbackCheckpoint?.cursor.seq == atomicFollower.seq()
            && callbackCheckpoint?.snapshot.ATOMIC?.n == 1,
        'checkpoint inside onBatch binds the already materialized snapshot to the committed envelope seq')
        atomicFollower.close()

        const replayed: ReplicatedMapChange<Row>[] = []
        const atomicResume = followReplicatedMap(atomicProducer.api, {
            delivery: 'lossless',
            checkpoint: callbackCheckpoint!,
            onBatch(change) { replayed.push(change) },
        })
        await atomicResume.ready
        await settle(atomicResume)
        ok(replayed.length == 0 && atomicResume.get('ATOMIC')?.n == 1,
            'resuming a checkpoint captured in onBatch does not replay that envelope')
        atomicResume.close()
        atomicProducer.control.close()

        const producer = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            delivery: 'latest',
        })
        const first = followReplicatedMap(producer.api)
        await first.ready
        producer.control.set(row('A', 1))
        await settle(first)
        const checkpoint = first.checkpoint()
        first.close()

        producer.control.set(row('B', 2))
        const resumed = followReplicatedMap(producer.api, {checkpoint})
        await resumed.ready
        await settle(resumed)
        ok(json(resumed.snapshot()) == json({A: row('A', 1), B: row('B', 2)}),
            'same-line checkpoint resumes its tail on top of the inseparable snapshot')
        resumed.close()

        const replacement = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            initial: [row('X', 9)],
            delivery: 'latest',
        })
        const reset = followReplicatedMap(replacement.api, {checkpoint})
        await reset.ready
        await settle(reset)
        ok(json(reset.snapshot()) == json({X: row('X', 9)}),
            'latest checkpoint from another line resets through a keyframe instead of mixing authorities')

        reset.close()
        replacement.control.close()
        producer.control.close()
    }

    console.log('\n[replicated-map] initial negotiation follows transport generations and authority identity')
    {
        const raceA = createReplicatedMap<Row>({
            keyOf(value) { return value.id }, initial: [row('A', 1)], delivery: 'lossless', lineId: 'race-A',
        })
        const raceB = createReplicatedMap<Row>({
            keyOf(value) { return value.id }, initial: [row('B', 2)], delivery: 'lossless', lineId: 'race-B',
        })
        const raceErrors: unknown[] = []
        const raced = followReplicatedMap(createDescriptorRaceRemote(raceA.api, raceB.api), {
            delivery: 'lossless',
            onError(error) { raceErrors.push(error) },
        })
        await raced.ready
        ok(raced.status().state == 'error' && raceErrors.length == 1
            && String(raceErrors[0]).includes('before initial catch-up') && json(raced.snapshot()) == '{}',
        'lossless rechecks lineId after describe and rejects an authority swap before applying its keyframe')
        raced.close()
        raceA.control.close()
        raceB.control.close()

        const generationProducer = createReplicatedMap<Row>({
            keyOf(value) { return value.id }, initial: [row('GEN', 3)], delivery: 'latest',
        })
        const generationLifecycle = createTransportLifecycle(true)
        let descriptorCalls = 0
        let rejectOldDescriptor = function rejectOldDescriptorLater(_error: unknown) {}
        const generationRemote = {
            line: generationProducer.api.line,
            since(seq: number) { return generationProducer.api.since(seq) },
            keyframe() { return generationProducer.api.keyframe() },
            frame(seq: number, hint?: unknown) { return generationProducer.api.frame!(seq, hint) },
            describe() {
                descriptorCalls++
                if (descriptorCalls > 1) return generationProducer.api.describe()
                return new Promise<never>(function holdOldDescriptor(_resolve, reject) {
                    rejectOldDescriptor = reject
                })
            },
        } as ReplicatedMapRemote<Row>
        Object.defineProperty(generationRemote, RPC_TRANSPORT_LIFECYCLE, {value: generationLifecycle.api})
        const generationFollower = followReplicatedMap(generationRemote)
        generationLifecycle.control.disconnect('descriptor generation changed')
        generationLifecycle.control.connect()
        rejectOldDescriptor(new Error('old generation failed late'))
        await generationFollower.ready
        ok(descriptorCalls >= 2 && generationFollower.status().state == 'live'
            && generationFollower.get('GEN')?.n == 3,
        'a late descriptor failure from an old transport generation is retried instead of becoming terminal')
        generationFollower.close()
        generationProducer.control.close()
    }

    console.log('\n[replicated-map] remote validation precedes mutation and producer close tears lines down')
    {
        const malformedErrors: unknown[] = []
        const malformedRemote = {
            line: {on() { return function offMalformedLine() {} }},
            since() {
                return [{
                    seq: 0,
                    ts: 1,
                    event: [{path: [123], exists: true, value: row('BAD', 1)}] as [StorePatch],
                }]
            },
            keyframe() { return null },
            frame() { return null },
            describe() {
                return {replicatedMap: {version: 1 as const, delivery: 'latest' as const, lineId: 'malformed'}}
            },
        } as unknown as ReplicatedMapRemote<Row>
        const malformed = followReplicatedMap(malformedRemote, {
            onError(error) { malformedErrors.push(error) },
        })
        await malformed.ready
        ok(malformed.status().state == 'error' && malformedErrors.length == 1
            && malformed.seq() == -1 && json(malformed.snapshot()) == '{}',
        'a malformed map patch is rejected before Store mutation and cannot advance seq')
        malformed.close()

        const symbolRoot = Object.create(null)
        symbolRoot[Symbol('hidden')] = row('HIDDEN', 1)
        const nonEnumerableRoot = Object.create(null)
        Object.defineProperty(nonEnumerableRoot, 'HIDDEN', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: row('HIDDEN', 1),
        })
        for (const [label, root] of [
            ['symbol', symbolRoot],
            ['non-enumerable', nonEnumerableRoot],
            ['non-plain', new Date(0)],
        ] as const) {
            const hiddenRootRemote = {
                ...malformedRemote,
                since() {
                    return [{seq: 0, ts: 1, event: [{path: [], exists: true, value: root}] as [StorePatch]}]
                },
            } as ReplicatedMapRemote<Row>
            const hiddenRootFollower = followReplicatedMap(hiddenRootRemote)
            await hiddenRootFollower.ready
            ok(hiddenRootFollower.status().state == 'error' && hiddenRootFollower.seq() == -1
                && Reflect.ownKeys(hiddenRootFollower.snapshot()).length == 0,
            `a root ${label} key is rejected before materialization`)
            hiddenRootFollower.close()
        }

        let customValidations = 0
        let customValidationSawCleanStore = false
        const policyRemote = {
            ...malformedRemote,
            since() {
                return [{
                    seq: 0,
                    ts: 1,
                    event: [{path: ['BLOCKED'], exists: true, value: row('BLOCKED', 1)}] as [StorePatch],
                }]
            },
        } as ReplicatedMapRemote<Row>
        const policyFollower = followReplicatedMap(policyRemote, {
            validateBatch(_patches, store) {
                customValidations++
                customValidationSawCleanStore = json(store.state) == '{}'
                throw new Error('application validation rejected the envelope')
            },
        })
        await policyFollower.ready
        ok(customValidations == 1 && customValidationSawCleanStore
            && policyFollower.status().state == 'error' && policyFollower.seq() == -1
            && json(policyFollower.snapshot()) == '{}',
        'a custom map validator composes with internal checks and rejects before mutation/seq commit')
        policyFollower.close()

        const subscriptionErrors: unknown[] = []
        const throwingRemote = {
            ...malformedRemote,
            line: {on() { throw new Error('line subscription rejected') }},
            since() { return [] },
        } as ReplicatedMapRemote<Row>
        const throwing = followReplicatedMap(throwingRemote, {
            onError(error) { subscriptionErrors.push(error) },
        })
        await throwing.ready
        ok(throwing.status().state == 'error' && subscriptionErrors.length == 1,
            'synchronous subscription failure settles ready through status/onError instead of rejecting start')
        throwing.close()

        const producer = createReplicatedMap<Row>({keyOf(value) { return value.id }, delivery: 'latest'})
        const follower = followReplicatedMap(producer.api)
        await follower.ready
        const wireLine = producer.api.line as any
        ok(wireLine.count() == 1, 'local compact line observes the active follower before cleanup')
        producer.control.close()
        await delay(0)
        ok(wireLine.count() == 0 && follower.status().state == 'error',
            'producer close cascades through encoded replay lines and ends the follower subscription')
        follower.close()
    }

    console.log('\n[replicated-map] reconnect validates the producer line identity')
    {
        const latestA = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            initial: [row('A', 1)],
            delivery: 'latest',
        })
        const latestB = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            initial: [row('B', 2)],
            delivery: 'latest',
        })
        const latestRoute = createSwitchableMapRemote(latestA.api)
        const latestFollower = followReplicatedMap(latestRoute.remote)
        await latestFollower.ready
        latestRoute.switchTo(latestB.api)
        await delay(10)
        await settle(latestFollower)

        ok(json(latestFollower.snapshot()) == json({B: row('B', 2)})
            && latestFollower.status().state == 'live',
        'latest reconnect resets through the replacement line keyframe without mixing old keys')

        latestFollower.close()
        latestRoute.close()
        latestA.control.close()
        latestB.control.close()

        const losslessA = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            initial: [row('A', 1)],
            delivery: 'lossless',
        })
        const losslessB = createReplicatedMap<Row>({
            keyOf(value) { return value.id },
            initial: [row('B', 2)],
            delivery: 'lossless',
        })
        const losslessRoute = createSwitchableMapRemote(losslessA.api)
        const reconnectErrors: unknown[] = []
        const losslessFollower = followReplicatedMap(losslessRoute.remote, {
            onError(error) { reconnectErrors.push(error) },
        })
        await losslessFollower.ready
        losslessRoute.switchTo(losslessB.api)
        await delay(10)

        ok(losslessFollower.status().state == 'error' && reconnectErrors.length == 1
            && String(reconnectErrors[0]).includes('replay line changed on reconnect')
            && json(losslessFollower.snapshot()) == json({A: row('A', 1)}),
        'lossless reconnect rejects a replacement line before accepting its snapshot or tail')

        losslessFollower.close()
        losslessRoute.close()
        losslessA.control.close()
        losslessB.control.close()
    }

    console.log('\n[replicated-map] descriptorless Store Replay V2 remote')
    {
        const source = createStore<Record<string, Row>>({OLD: row('OLD', 1)})
        const exposed = exposeStoreReplay(source)
        const batches: ReplicatedMapChange<Row>[] = []
        const follower = followReplicatedMap(
            exposed.api.replay as ReplicatedMapRemote<Row>,
            {
                delivery: 'latest',
                checkpoint: {
                    snapshot: {WRONG: row('WRONG', 9)},
                    cursor: {lineId: 'another-line', delivery: 'latest', replayMode: 'v2', seq: 999},
                },
                onBatch(change) { batches.push(change) },
            },
        )
        await follower.ready
        await settle(follower)

        ok(follower.status().state == 'live' && follower.status().replayMode == 'v2'
            && follower.delivery() == 'latest',
        'descriptorless V2 remote uses explicitly requested latest delivery')
        ok(json(follower.snapshot()) == json({OLD: row('OLD', 1)}),
            'latest mode resets a foreign cursor and receives a safe V2 keyframe')

        batches.length = 0
        source.state.NEXT = row('NEXT', 2)
        await flushReactive(source.state)
        await settle(follower)

        ok(follower.has('NEXT') && follower.get('NEXT')?.n == 2 && batches.length == 1,
            'descriptorless V2 remote continues receiving live changes')

        follower.close()
        exposed.close()
    }

    console.log(fails ? `\n${fails} failed` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function replicatedMapOracleFailed(error) {
    console.error(error)
    process.exit(1)
})
