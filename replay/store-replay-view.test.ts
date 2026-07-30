// ============================================================
// Store Replay View V1 contract
// ============================================================

import {isDeepStrictEqual} from 'node:util'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStore, type Store} from '../src/Common/Observe/store'
import {
    createStoreReplayView,
    syncStoreReplayView,
    type StoreReplayViewRemote,
} from '../src/Common/Observe/store-replay'
import {
    decodeStoreReplayBatchV2,
    storeReplayBatchV2WireMetrics,
} from '../src/Common/Observe/store-replay-codec'

let failures = 0

function ok(condition: unknown, message: string) {
    if (condition) console.log('  OK  ', message)
    else {
        failures++
        console.log('  FAIL', message)
    }
}

function deepOk(actual: unknown, expected: unknown, message: string) {
    ok(isDeepStrictEqual(actual, expected), message)
}

function throwsMatch(run: () => unknown, pattern: RegExp, message: string) {
    let error: unknown
    try {
        run()
    } catch (caught) {
        error = caught
    }
    ok(pattern.test(String((error as any)?.message)), message)
}

async function immediate() {
    await new Promise<void>(function nextTurn(resolve) { setImmediate(resolve) })
}

async function settleStores(...stores: Store<any>[]) {
    for (const store of stores) await flushReactive(store.state)
    await immediate()
    for (const store of stores) await flushReactive(store.state)
}

async function runCase(name: string, test: () => Promise<void> | void) {
    console.log('\n[store-replay-view] ' + name)
    try {
        await test()
    } catch (error) {
        failures++
        console.log('  FAIL unexpected error:', error)
    }
}

type Row = {
    n: number
    text: string
}

function row(n: number, textBytes = 80): Row {
    return {n, text: String(n).padStart(textBytes, 'x')}
}

function makeRows(count: number, prefix = 'K') {
    const rows: Record<string, Row> = {}
    const keys: string[] = []
    for (let index = 0; index < count; index++) {
        const key = prefix + index.toString().padStart(4, '0')
        keys.push(key)
        rows[key] = row(index)
    }
    return {rows, keys}
}

async function main() {
    await runCase('1500 source keys -> 500-key bounded atomic snapshot', async function selectedSnapshot() {
        const initial = makeRows(1500)
        const keys = initial.keys.filter((_key, index) => index % 3 == 0)
        const expected = Object.fromEntries(keys.map(key => [key, initial.rows[key]]))
        const source = createStore<Record<string, Row>>(initial.rows, {drain: 'micro'})
        let fullSnapshotReads = 0
        source.snapshot = function rejectFullStoreSnapshot() {
            fullSnapshotReads++
            throw new Error('the selected view must not clone the full source Store')
        }

        const chunkBytes = 768
        const windowBytes = 1536
        const view = createStoreReplayView(source, {
            keys,
            lineId: 'test:1500-to-500',
            history: 64,
            snapshot: {
                chunkBytes,
                windowBytes,
                maxItems: 64,
            },
        })
        const sentinel = {OLD: row(-1)}
        const mirror = createStore<Record<string, Row>>(sentinel, {drain: 'micro'})
        const pages: {
            bytes: number
            chunks: number
            maxChunkBytes: number
            maxChunkItems: number
            done: boolean
        }[] = []
        let atomicallyHidden = true
        const resource = view.resource
        const measuredRemote: StoreReplayViewRemote = {
            describe: resource.describe,
            replay: resource.replay,
            snapshot: {
                open: resource.snapshot.open,
                async read(request, emit) {
                    let bytes = 0
                    let chunks = 0
                    let maxChunkBytes = 0
                    let maxChunkItems = 0
                    const result = await resource.snapshot.read(request, function measureChunk(chunk) {
                        const patches = decodeStoreReplayBatchV2(chunk.wire).event[0]
                        const chunkWireBytes = storeReplayBatchV2WireMetrics(patches).byteLength
                        bytes += chunkWireBytes
                        chunks++
                        maxChunkBytes = Math.max(maxChunkBytes, chunkWireBytes)
                        maxChunkItems = Math.max(maxChunkItems, patches.length)
                        atomicallyHidden = atomicallyHidden
                            && isDeepStrictEqual(mirror.snapshot(), sentinel)
                        emit(chunk)
                    })
                    pages.push({
                        bytes,
                        chunks,
                        maxChunkBytes,
                        maxChunkItems,
                        done: result.done,
                    })
                    return result
                },
                close: resource.snapshot.close,
            },
        }
        const errors: unknown[] = []
        const progressVisible: boolean[] = []
        const sync = syncStoreReplayView(mirror, measuredRemote, {
            snapshotWindowBytes: windowBytes,
            onError(error) { errors.push(error) },
            onSnapshotProgress() {
                progressVisible.push(isDeepStrictEqual(mirror.snapshot(), sentinel))
            },
        })

        try {
            await sync.ready
            await settleStores(mirror)
            const snapshot = mirror.snapshot()
            ok(errors.length == 0, 'initial selected snapshot completes without replay errors')
            ok(fullSnapshotReads == 0, 'initial view never calls full Store.snapshot()')
            ok(Object.keys(snapshot).length == 500, 'only the 500 authorized keys become visible')
            deepOk(snapshot, expected, 'selected values exactly match their 1500-key source')
            ok(pages.length > 1 && pages.slice(0, -1).every(page => !page.done)
                && pages[pages.length - 1].done,
            'snapshot crosses multiple explicit read-response barriers')
            ok(pages.every(page => page.chunks > 0), 'every page contains at least one physical chunk')
            ok(pages.every(page => page.maxChunkItems <= 64),
                'every physical chunk respects the hard item ceiling')
            ok(pages.every(page => page.maxChunkBytes <= chunkBytes),
                'every divisible physical chunk respects the configured packed-byte target')
            ok(pages.every(page => page.bytes <= windowBytes),
                'every page stays within the requested packed-byte window')
            ok(atomicallyHidden && progressVisible.every(Boolean),
                'no partial snapshot is visible during chunks or page progress')
            ok(sync.seq() == view.events.replay.head(),
                'atomic snapshot commits at the advertised replay coordinate')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('one indivisible selected value occupies one oversize window', async function oversizeKey() {
        const source = createStore<Record<string, Row>>({
            BIG: row(1, 8 * 1024),
        }, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: ['BIG'],
            lineId: 'test:oversize-key',
            snapshot: {chunkBytes: 256, windowBytes: 512, maxItems: 8},
        })
        const mirror = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const resource = view.resource
        const pageChunks: number[] = []
        const chunkBytes: number[] = []
        const remote: StoreReplayViewRemote = {
            describe: resource.describe,
            replay: resource.replay,
            snapshot: {
                open: resource.snapshot.open,
                async read(request, emit) {
                    let chunks = 0
                    const result = await resource.snapshot.read(request, function measureOversizeChunk(chunk) {
                        const patches = decodeStoreReplayBatchV2(chunk.wire).event[0]
                        chunkBytes.push(storeReplayBatchV2WireMetrics(patches).byteLength)
                        chunks++
                        emit(chunk)
                    })
                    pageChunks.push(chunks)
                    return result
                },
                close: resource.snapshot.close,
            },
        }
        const sync = syncStoreReplayView(mirror, remote)

        try {
            await sync.ready
            await settleStores(mirror)
            deepOk(mirror.snapshot(), source.snapshot(),
                'the indivisible selected value still arrives atomically')
            ok(pageChunks.length == 2 && pageChunks.every(count => count == 1),
                'root and one oversize value use separate one-callback windows')
            ok(chunkBytes.filter(bytes => bytes > 512).length == 1,
                'only the indivisible value is allowed to exceed the byte target')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('unselected changes do not consume sequence; selected live patches do', async function liveProjection() {
        const source = createStore<Record<string, Row>>({
            A: row(1),
            B: row(2),
            C: row(3),
            U: row(4),
        }, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: ['A', 'B', 'C'],
            lineId: 'test:live-projection',
            history: 16,
            maxItems: 2,
            snapshot: {chunkBytes: 256, windowBytes: 512, maxItems: 2},
        })
        const mirror = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const errors: unknown[] = []
        const sync = syncStoreReplayView(mirror, view.resource, {
            onError(error) { errors.push(error) },
        })

        try {
            await sync.ready
            const initialSeq = sync.seq()
            source.state.U.n = 40
            await settleStores(source, mirror)
            ok(view.events.replay.head() == initialSeq && sync.seq() == initialSeq,
                'an unselected mutation neither journals nor advances the client sequence')
            ok(!Object.prototype.hasOwnProperty.call(mirror.state, 'U'),
                'an unselected key never leaks into the mirror')

            source.state.A.n = 10
            await settleStores(source, mirror)
            ok(sync.seq() > initialSeq && mirror.state.A.n == 10,
                'a selected nested update advances sequence and reaches the mirror')

            const afterUpdate = sync.seq()
            delete source.state.B
            await settleStores(source, mirror)
            ok(sync.seq() > afterUpdate && !Object.prototype.hasOwnProperty.call(mirror.state, 'B'),
                'a selected top-level delete advances sequence and removes the key')

            source.replace({
                A: row(100),
                B: row(200),
                U: row(400),
                D: row(500),
            })
            await settleStores(source, mirror)
            deepOk(mirror.snapshot(), {A: row(100), B: row(200)},
                'a root replacement projects selected set/delete facts only')
            ok(errors.length == 0, 'selected update/delete/root replacement stays error-free')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('views share one selected sampler and skip unselected clones', async function sharedSampler() {
        const source = createStore<Record<string, Row>>({
            A: row(1),
            U: row(2),
        }, {drain: 'micro'})
        const first = createStoreReplayView(source, {
            keys: ['A'],
            lineId: 'test:shared-sampler:first',
        })
        const second = createStoreReplayView(source, {
            keys: ['A'],
            lineId: 'test:shared-sampler:second',
        })
        let selectedReads = 0
        let unselectedReads = 0

        function countedRow(n: number, onRead: () => void) {
            const value = {n} as Row
            Object.defineProperty(value, 'text', {
                configurable: true,
                enumerable: true,
                get() {
                    onRead()
                    return 'counted-' + n
                },
            })
            return value
        }

        try {
            source.state.A = countedRow(10, function countSelectedClone() { selectedReads++ })
            selectedReads = 0
            await settleStores(source)
            ok(selectedReads == 1,
                'one changed selected value is detached once for two interested views')
            ok(first.events.replay.head() == 1 && second.events.replay.head() == 1,
                'both view journals receive the shared selected fact')

            source.state.U = countedRow(20, function countUnselectedClone() { unselectedReads++ })
            unselectedReads = 0
            await settleStores(source)
            ok(unselectedReads == 0,
                'an unselected top-level replacement is discarded before value cloning')
            ok(first.events.replay.head() == 1 && second.events.replay.head() == 1,
                'an unselected replacement advances neither view journal')
        } finally {
            first.close()
            second.close()
        }
    })

    await runCase('one rejected view journal cannot starve sibling views', async function isolatedViewFailure() {
        let scheduled: (() => void) | undefined
        const source = createStore<Record<string, Row>>({
            A: row(1),
        }, {
            drain(flush) {
                scheduled = flush
            },
        })
        const journalError = new Error('selected journal rejected')
        let rejectJournal = true
        const failing = createStoreReplayView(source, {
            keys: ['A'],
            lineId: 'test:isolated-view-failure:failing',
            onJournal() {
                if (rejectJournal) throw journalError
            },
        })
        const healthy = createStoreReplayView(source, {
            keys: ['A'],
            lineId: 'test:isolated-view-failure:healthy',
        })

        try {
            source.state.A = row(2)
            let surfaced: unknown
            function catchJournalFailure(error: unknown) {
                surfaced = error
            }
            process.once('uncaughtException', catchJournalFailure)
            scheduled!()
            await new Promise<void>(function waitForReactiveError(resolve) {
                setTimeout(resolve, 5)
            })
            process.removeListener('uncaughtException', catchJournalFailure)
            ok(surfaced == journalError,
                'the rejected journal still surfaces its original failure')
            ok(failing.events.replay.head() == 0 && healthy.events.replay.head() == 1,
                'the healthy sibling receives the shared fact despite the earlier rejection')
        } finally {
            rejectJournal = false
            failing.close()
            healthy.close()
        }
    })

    await runCase('mutation during snapshot converges through fuzzy handoff', async function fuzzyHandoff() {
        const initial = makeRows(80, 'F')
        const source = createStore<Record<string, Row>>(initial.rows, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: initial.keys,
            lineId: 'test:fuzzy-handoff',
            history: 32,
            snapshot: {chunkBytes: 256, windowBytes: 384, maxItems: 2},
        })
        const mirror = createStore<Record<string, Row>>({OLD: row(-1)}, {drain: 'micro'})
        const resource = view.resource
        let injected = false
        let openedBase = -1
        const remote: StoreReplayViewRemote = {
            describe: resource.describe,
            replay: resource.replay,
            snapshot: {
                open() {
                    const opened = resource.snapshot.open()
                    openedBase = opened.baseSeq
                    return opened
                },
                async read(request, emit) {
                    const result = await resource.snapshot.read(request, emit)
                    if (!injected && !result.done) {
                        injected = true
                        source.state.F0000 = row(10_000)
                        delete source.state.F0079
                        await settleStores(source)
                    }
                    return result
                },
                close: resource.snapshot.close,
            },
        }
        const errors: unknown[] = []
        const sync = syncStoreReplayView(mirror, remote, {
            onError(error) { errors.push(error) },
        })

        try {
            await sync.ready
            await settleStores(mirror)
            const expected = {...initial.rows, F0000: row(10_000)}
            delete expected.F0079
            ok(injected, 'a selected mutation is injected between snapshot pages')
            ok(openedBase < sync.seq(), 'handoff applies journal events newer than the snapshot base')
            deepOk(mirror.snapshot(), expected,
                'mixed-time key sampling plus the retained tail converges to current selected state')
            ok(errors.length == 0, 'fuzzy handoff completes without a recovery error')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('duplicate and special keys are safe; invalid keys fail early', async function keyContract() {
        const initial: Record<string, Row> = {
            '': row(0),
            safe: row(1),
        }
        Object.defineProperty(initial, '__proto__', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: {n: 2, text: 'own prototype-named value'},
        })
        const source = createStore<Record<string, Row>>(initial, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: ['safe', '__proto__', 'safe', ''],
            lineId: 'test:special-keys',
            snapshot: {chunkBytes: 256, windowBytes: 512, maxItems: 2},
        })
        const mirror = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const sync = syncStoreReplayView(mirror, view.resource)

        try {
            await sync.ready
            const descriptor = await view.resource.describe()
            deepOk(view.view.keys(), ['', '__proto__', 'safe'],
                'duplicate keys normalize to one deterministic sorted selection')
            ok(descriptor.storeReplayView.keyCount == 3,
                'descriptor reports normalized key cardinality')
            ok(Object.prototype.hasOwnProperty.call(mirror.state, '__proto__')
                && mirror.state.__proto__.n == 2,
            '__proto__ is transferred as an own data key')
            ok(Object.getPrototypeOf(mirror.state) == Object.prototype
                && ({} as any).n == undefined,
            '__proto__ transfer does not mutate the mirror or global prototype chain')
            ok(mirror.state[''].n == 0 && mirror.state.safe.n == 1,
                'empty and ordinary string keys retain their values')
        } finally {
            sync()
            view.close()
        }

        throwsMatch(
            () => createStoreReplayView(source, {
                keys: ['safe', 7] as any,
                lineId: 'test:invalid-key',
            }),
            /keys must contain only strings/,
            'a non-string selected key is rejected before a resource is created',
        )
    })

    await runCase('cancellation leaves the visible mirror untouched', async function atomicCancellation() {
        const initial = makeRows(120, 'C')
        const source = createStore<Record<string, Row>>(initial.rows, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: initial.keys,
            lineId: 'test:cancellation',
            snapshot: {chunkBytes: 192, windowBytes: 256, maxItems: 1},
        })
        const sentinel = {OLD: row(-1)}
        const mirror = createStore<Record<string, Row>>(sentinel, {drain: 'micro'})
        const errors: unknown[] = []
        let cancel: (() => void) | undefined
        let cancelled = false
        const sync = syncStoreReplayView(mirror, view.resource, {
            onError(error) { errors.push(error) },
            onSnapshotProgress(progress) {
                if (cancelled || progress.done) return
                cancelled = true
                cancel?.()
            },
        })
        cancel = sync

        try {
            await sync.ready
            await immediate()
            deepOk(mirror.snapshot(), sentinel,
                'cancelling between pages exposes neither a partial root nor selected keys')
            ok(cancelled, 'the transfer was cancelled after a bounded non-final page')
            ok(errors.length == 0, 'intentional cancellation is not reported as a replay failure')
            ok(view.view.stats().activeSessions == 0,
                'cancelled client closes its server snapshot cursor')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('history eviction retries a fresh snapshot', async function historyRetry() {
        const initial = makeRows(48, 'R')
        const source = createStore<Record<string, Row>>(initial.rows, {drain: 'micro'})
        const view = createStoreReplayView(source, {
            keys: initial.keys,
            lineId: 'test:history-retry',
            history: 1,
            snapshot: {chunkBytes: 192, windowBytes: 256, maxItems: 1},
        })
        const mirror = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const resource = view.resource
        let opens = 0
        let firstTransfer = ''
        let evicted = false
        const remote: StoreReplayViewRemote = {
            describe: resource.describe,
            replay: resource.replay,
            snapshot: {
                open() {
                    const opened = resource.snapshot.open()
                    opens++
                    if (opens == 1) firstTransfer = opened.transferId
                    return opened
                },
                async read(request, emit) {
                    const result = await resource.snapshot.read(request, emit)
                    if (!evicted && request.transferId == firstTransfer && !result.done) {
                        evicted = true
                        source.state.R0000 = row(1000)
                        await settleStores(source)
                        source.state.R0000 = row(1001)
                        await settleStores(source)
                    }
                    return result
                },
                close: resource.snapshot.close,
            },
        }
        const errors: unknown[] = []
        const sync = syncStoreReplayView(mirror, remote, {
            snapshotRetries: 3,
            onError(error) { errors.push(error) },
        })

        try {
            await sync.ready
            await settleStores(mirror)
            const expected = {...initial.rows, R0000: row(1001)}
            ok(evicted, 'two selected events evict a history=1 snapshot base')
            ok(opens == 2, 'client discards the fuzzy attempt and opens one fresh snapshot')
            ok(view.view.stats().retrySnapshots == 1
                && view.view.stats().completedSnapshots == 1,
            'server records one retry and one completed transfer')
            deepOk(mirror.snapshot(), expected,
                'retried snapshot commits the latest selected state atomically')
            ok(sync.seq() == view.events.replay.head(),
                'retried handoff resumes at the current replay head')
            ok(errors.length == 0, 'successful history retry is transparent to onError')
        } finally {
            sync()
            view.close()
        }
    })

    await runCase('cursor binds line and selection before tail resume', async function cursorIdentity() {
        const source = createStore<Record<string, Row>>({
            A: row(1),
            B: row(2),
        }, {drain: 'micro'})
        const firstView = createStoreReplayView(source, {
            keys: ['A', 'B'],
            lineId: 'test:cursor:first',
            history: 16,
            snapshot: {chunkBytes: 256, windowBytes: 512},
        })
        const mirror = createStore<Record<string, Row>>({}, {drain: 'micro'})
        const firstSync = syncStoreReplayView(mirror, firstView.resource)
        await firstSync.ready
        const firstCursor = firstSync.cursor()
        firstSync()
        ok(firstCursor?.lineId == 'test:cursor:first'
            && firstCursor.selectionId == firstView.view.selectionId,
        'cursor persists both view line and authorization selection identity')

        const openedBeforeTail = firstView.view.stats().openedSnapshots
        source.state.A = row(10)
        await settleStores(source)
        const tailSync = syncStoreReplayView(mirror, firstView.resource, {
            cursor: firstCursor!,
        })
        await tailSync.ready
        ok(firstView.view.stats().openedSnapshots == openedBeforeTail
            && mirror.state.A.n == 10,
        'same-line cursor resumes through the cheap replay tail without a new snapshot')
        const tailCursor = tailSync.cursor()!
        tailSync()

        const secondView = createStoreReplayView(source, {
            keys: ['A'],
            lineId: 'test:cursor:second',
            history: 16,
            snapshot: {chunkBytes: 256, windowBytes: 512},
        })
        const changedLineSync = syncStoreReplayView(mirror, secondView.resource, {
            cursor: tailCursor,
        })
        try {
            await changedLineSync.ready
            deepOk(mirror.snapshot(), {A: row(10)},
                'different lineId installs a fresh selected snapshot and removes stale keys')
            ok(secondView.view.stats().openedSnapshots == 1
                && changedLineSync.cursor()?.lineId == 'test:cursor:second',
            'line change records the replacement cursor only after snapshot commit')

            const changedLineCursor = changedLineSync.cursor()!
            changedLineSync()
            const reauthorizedView = createStoreReplayView(source, {
                keys: ['B'],
                lineId: 'test:cursor:second',
                history: 16,
                snapshot: {chunkBytes: 256, windowBytes: 512},
            })
            const reauthorizedSync = syncStoreReplayView(mirror, reauthorizedView.resource, {
                cursor: changedLineCursor,
            })
            try {
                await reauthorizedSync.ready
                deepOk(mirror.snapshot(), {B: row(2)},
                    'same lineId with another selection cannot retain a revoked key')
                ok(reauthorizedView.view.stats().openedSnapshots == 1
                    && reauthorizedSync.cursor()?.selectionId == reauthorizedView.view.selectionId,
                'selection change forces a snapshot and records the new selection identity')
            } finally {
                reauthorizedSync()
                reauthorizedView.close()
            }
        } finally {
            changedLineSync()
            secondView.close()
            firstView.close()
        }
    })

    console.log('\n' + (failures == 0
        ? '[store-replay-view] all checks passed'
        : `[store-replay-view] ${failures} check(s) failed`))
    if (failures) process.exitCode = 1
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
