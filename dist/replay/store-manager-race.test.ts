import {
    createMemoryOfflineStorage,
    createStoreManager,
    managedStore,
    OfflineStorage,
    StoreReplayRemote,
} from '../src/Common/Observe'

let fails = 0

function ok(condition: any, message: string) {
    if (!condition) {
        fails++
        console.log('  FAIL', message)
    } else console.log('  OK  ', message)
}

function tick() {
    return new Promise<void>(function waitForTimer(resolve) { setTimeout(resolve, 0) })
}

async function waitFor(label: string, predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return
        await tick()
    }
    throw new Error(`timeout: ${label}`)
}

function createDeferred<T>() {
    let resolve = function resolveLater(_value: T) {}
    const promise = new Promise<T>(function waitForDeferred(nextResolve) { resolve = nextResolve })
    return {promise, resolve}
}

function rejectedResult<T>(promise: Promise<T>) {
    return promise.then(
        function startResolved() { return undefined },
        function startRejected(error) { return error as Error },
    )
}

type World = {
    rows: Record<string, {qty: number}>
}

function createDelayedReplay(snapshot: World) {
    const keyframe = createDeferred<any>()
    const listeners = new Set<(event: any) => void>()
    let lineStarts = 0
    let lineStops = 0
    let keyframeStarts = 0

    const remote: StoreReplayRemote = {
        line: {
            on(cb) {
                lineStarts++
                listeners.add(cb)
                let active = true
                return function stopTrackedReplayLine() {
                    if (!active) return
                    active = false
                    lineStops++
                    listeners.delete(cb)
                }
            },
        },
        since() {
            return null
        },
        async keyframe() {
            keyframeStarts++
            return keyframe.promise
        },
    }

    function resolveKeyframe() {
        keyframe.resolve({
            seq: 0,
            ts: Date.now(),
            event: [{path: [], exists: true, value: snapshot}],
        })
    }

    return {
        remote,
        resolveKeyframe,
        lineStarts: () => lineStarts,
        lineStops: () => lineStops,
        keyframeStarts: () => keyframeStarts,
    }
}

function createDelayedMirror(snapshot: World) {
    const pull = createDeferred<World>()
    const listeners = new Set<() => void>()
    let pulls = 0
    let lineStarts = 0
    let lineStops = 0

    const remote = {
        async get() {
            pulls++
            return pull.promise
        },
        changed: {
            on(cb: () => void) {
                lineStarts++
                listeners.add(cb)
                let active = true
                return function stopTrackedMirrorLine() {
                    if (!active) return
                    active = false
                    lineStops++
                    listeners.delete(cb)
                }
            },
        },
    }

    return {
        remote,
        resolvePull: () => pull.resolve(snapshot),
        pulls: () => pulls,
        lineStarts: () => lineStarts,
        lineStops: () => lineStops,
    }
}

async function main() {
    console.log('\n[store-manager race] stop before deferred start enters resource code')
    {
        const replay = createDelayedReplay({rows: {a: {qty: 0}}})
        const manager = createStoreManager({
            rows: managedStore.replay<World>({
                remote: replay.remote,
                initial: {rows: {}},
            }) as any,
        })
        const result = rejectedResult(manager.start('rows'))
        manager.stop('rows')

        ok(await result instanceof Error, 'same-turn stop cancels the deferred start')
        ok(manager.handles['rows'].status().state == 'stopped', 'same-turn stop remains terminal')
        ok(replay.lineStarts() == 0 && replay.keyframeStarts() == 0, 'cancelled start allocates no replay resource')
    }

    console.log('\n[store-manager race] replay stop during delayed keyframe')
    {
        const replay = createDelayedReplay({rows: {a: {qty: 1}}})
        const manager = createStoreManager({
            rows: managedStore.replay<World>({
                remote: replay.remote,
                initial: {rows: {}},
            }) as any,
        })
        const states: string[] = []
        const offStatus = manager.statusListen.on(function trackReplayState(status) {
            states.push(status.state)
        })
        const result = rejectedResult(manager.start('rows'))

        await waitFor('replay keyframe started', () => replay.keyframeStarts() == 1)
        manager.stop('rows')

        ok(manager.handles['rows'].status().state == 'stopped', 'stop wins while replay keyframe is pending')
        ok(replay.lineStarts() == 1 && replay.lineStops() == 1, 'replay line is released immediately')
        ok(await result instanceof Error, 'cancelled replay start rejects instead of returning an unready store')

        replay.resolveKeyframe()
        await tick()
        await tick()
        manager.stop('rows')

        ok(manager.handles['rows'].status().state == 'stopped', 'late replay keyframe cannot resurrect ready')
        ok(!states.includes('ready'), 'cancelled replay attempt emits no late ready status')
        ok(replay.lineStops() == 1, 'replay line is released exactly once')
        offStatus()
    }

    console.log('\n[store-manager race] mirror stop during delayed initial pull')
    {
        const mirror = createDelayedMirror({rows: {a: {qty: 2}}})
        const manager = createStoreManager({
            rows: managedStore.mirror<World>({
                remote: mirror.remote,
                initial: {rows: {}},
                mask: true,
            }),
        })
        const result = rejectedResult(manager.start('rows'))

        await waitFor('mirror initial pull started', () => mirror.pulls() == 1 && mirror.lineStarts() == 1)
        manager.stop('rows')

        ok(manager.handles.rows.status().state == 'stopped', 'stop wins while mirror pull is pending')
        ok(mirror.lineStops() == 0, 'mirror keeps the line only until its sync handle becomes available')

        mirror.resolvePull()
        ok(await result instanceof Error, 'cancelled mirror start rejects')
        await tick()
        manager.stop('rows')

        ok(manager.handles.rows.status().state == 'stopped', 'late mirror pull cannot resurrect ready')
        ok(mirror.lineStops() == 1, 'late mirror sync handle is released exactly once')
    }

    console.log('\n[store-manager race] offline stop during delayed storage load')
    {
        const storageRead = createDeferred<undefined>()
        let reads = 0
        const storage: OfflineStorage = {
            read<T>() {
                reads++
                return storageRead.promise as Promise<T | undefined>
            },
            async write() {},
            async remove() {},
        }
        const replay = createDelayedReplay({rows: {a: {qty: 3}}})
        const manager = createStoreManager({
            rows: managedStore.offline<World>({
                remote: replay.remote,
                initial: {rows: {}},
                storage,
            }) as any,
        })
        const result = rejectedResult(manager.start('rows'))

        await waitFor('offline storage read started', () => reads == 1)
        manager.stop('rows')
        storageRead.resolve(undefined)

        ok(await result instanceof Error, 'cancelled offline creation rejects after storage returns')
        await waitFor('late offline replay line released', () => replay.lineStops() == 1)

        ok(manager.handles['rows'].status().state == 'stopped', 'late offline creation cannot resurrect ready')
        ok(manager.get('rows') == null, 'late offline store is not retained after stop')
        ok(replay.lineStarts() == 1 && replay.lineStops() == 1, 'late-created offline replay is released exactly once')

        replay.resolveKeyframe()
        await tick()
        manager.stop('rows')
        ok(replay.lineStops() == 1, 'offline late keyframe causes no second release')
    }

    console.log('\n[store-manager race] offline stop during replay catch-up')
    {
        const replay = createDelayedReplay({rows: {a: {qty: 4}}})
        const manager = createStoreManager({
            rows: managedStore.offline<World>({
                remote: replay.remote,
                initial: {rows: {}},
                storage: createMemoryOfflineStorage(),
            }) as any,
        })
        const result = rejectedResult(manager.start('rows'))

        await waitFor('offline store exposed during catch-up', () =>
            manager.get('rows') != null && replay.keyframeStarts() == 1)
        manager.stop('rows')

        ok(manager.get('rows') == null, 'stop drops the partially started offline store')
        ok(replay.lineStops() == 1, 'stop releases the offline replay during catch-up')
        ok(await result instanceof Error, 'offline catch-up cancellation rejects its start')

        replay.resolveKeyframe()
        await tick()
        manager.stop('rows')

        ok(manager.handles['rows'].status().state == 'stopped', 'offline catch-up cannot report ready after stop')
        ok(replay.lineStops() == 1, 'offline replay subscription is released exactly once')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(function storeManagerRaceFailed(error) {
    console.error(error)
    process.exit(1)
})
