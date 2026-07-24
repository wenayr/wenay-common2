// Store Replay capability selection must stay conservative until delayed RPC MAP arrives.

import {createStore} from '../src/Common/Observe/store'
import {
    exposeStoreReplay,
    storeReplayMode,
    StoreReplayRemote,
    syncStoreReplay,
    syncStoreReplayRoute,
} from '../src/Common/Observe/store-replay'
import {flushReactive} from '../src/Common/Observe/reactive'
import {
    createTransportLifecycle,
    getRpcMemberState,
    RPC_MEMBER_LOOKUP,
    RPC_SCHEMA_READY,
    RPC_TRANSPORT_LIFECYCLE,
} from '../src/Common/events/transport-lifecycle'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createInProcSocketPair} from '../src/Common/rcp/rpc-inproc'
import {Pkt, SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {makeOff} from '../src/Common/rcp/rpc-off'

type State = {quotes: Record<string, {value: number}>}

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function pathText(packet: any) {
    const ref = packet?.[2]
    return Array.isArray(ref) ? ref.join('.') : '#' + String(ref)
}

function containsBinary(value: unknown): boolean {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
    if (value == null || typeof value != 'object') return false
    if (Array.isArray(value)) return value.some(containsBinary)
    return Object.keys(value).some(key => containsBinary((value as Record<string, unknown>)[key]))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000) {
    let timer: any
    try {
        return await Promise.race([
            promise,
            new Promise<never>(function rejectAfterTimeout(_, reject) {
                timer = setTimeout(function capabilityRaceTimeout() { reject(new Error('capability race timed out')) }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

async function waitForCondition(label: string, condition: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (condition()) return
        await new Promise<void>(function waitForCapabilityState(resolve) { setTimeout(resolve, 5) })
    }
    throw new Error('timeout: ' + label)
}

function createDeferredSchemaRemote(waitForSchema: () => Promise<void>) {
    const memberLookup = function unresolvedBatchMember(member: string) {
        return member == 'batch' ? undefined : false
    }
    Object.defineProperty(memberLookup, RPC_MEMBER_LOOKUP, {value: true})
    const schemaReady = function waitForDeferredSchema() { return waitForSchema() }
    Object.defineProperty(schemaReady, RPC_SCHEMA_READY, {value: true})
    const remote: any = {}
    Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: memberLookup})
    Object.defineProperty(remote, RPC_SCHEMA_READY, {value: schemaReady})
    return remote as StoreReplayRemote
}

async function main() {
    console.log('\n[store-replay-capability-race] legacy selection before delayed RPC MAP')

    const source = createStore<State>({quotes: {BTC: {value: 7}}}, {drain: 'micro'})
    const legacy = exposeStoreReplay(source)
    const [rawClientSocket, rawServerSocket] = createInProcSocketPair()
    const calls: any[][] = []
    const delayedMaps: Array<{key: string, packet: any}> = []

    const clientSocket: SocketTmpl = {
        on: rawClientSocket.on,
        emit(key, packet) {
            if (Array.isArray(packet) && packet[0] == Pkt.CALL) calls.push(packet)
            rawClientSocket.emit(key, packet)
        },
    }
    const serverSocket: SocketTmpl = {
        on: rawServerSocket.on,
        emit(key, packet) {
            if (Array.isArray(packet) && packet[0] == Pkt.MAP) {
                delayedMaps.push({key, packet})
                return
            }
            rawServerSocket.emit(key, packet)
        },
    }

    createRpcServerAuto({socket: serverSocket, socketKey: 'race', object: {state: legacy.api.replay}})
    const rpc = createRpcClient<any>({socket: clientSocket, socketKey: 'race'})
    const remote = rpc.func.state as StoreReplayRemote

    ok(delayedMaps.length == 1, 'legacy server MAP is held before client construction')
    ok(getRpcMemberState(remote, 'batch') == undefined, 'RPC batch capability is branded but still unknown before MAP')
    ok(storeReplayMode(remote, true) == 'legacy', 'unknown RPC capability selects legacy conservatively')

    const mirror = createStore<State>({quotes: {}}, {drain: 'micro'})
    const errors: unknown[] = []
    const sync = syncStoreReplay(mirror, remote, {
        batch: true,
        onError: function rememberRecoveryError(error) { errors.push(error) },
    })
    const callsBeforeMap = calls.map(pathText)

    for (const delayed of delayedMaps.splice(0)) rawServerSocket.emit(delayed.key, delayed.packet)
    await withTimeout(sync.ready)
    await flushReactive(mirror.state)

    const allCallPaths = calls.map(pathText)
    ok(callsBeforeMap.length == 0, 'Store replay defers capability-dependent calls until MAP is released')
    ok(!allCallPaths.some(path => path.split('.').includes('batch')
        || ['v2', 'v3', 'v4', 'v5'].some(codec => path.split('.').includes(codec))),
    'legacy-only server receives no batch generation CALL')
    ok(sync.mode == 'legacy', 'selected state mode remains legacy after MAP')
    ok(errors.length == 0, 'legacy catch-up completes without recovery errors')
    ok(JSON.stringify(mirror.snapshot()) == JSON.stringify(source.snapshot()), 'ready converges to the legacy server state')

    sync()
    rpc.close()
    legacy.close()

    console.log('\n[store-replay-capability-race] compact codec follows transport generations')
    {
        const rollingSource = createStore({x: 1}, {drain: 'micro'})
        const rollingExposed = exposeStoreReplay(rollingSource, {batch: true})
        const rollingLifecycle = createTransportLifecycle(true)
        const codecCalls = {v3: 0, v4: 0, v5: 0, v6: 0}
        const physicalEnds = new Set<() => void>()
        let v4Available = true
        let v5Available = true
        let v6Available = true

        function codecWire(codec: 'v3' | 'v4' | 'v5' | 'v6', wire: any, available: () => boolean) {
            function requireCodec() {
                if (!available()) throw new Error(codec + ' removed')
                codecCalls[codec]++
            }
            function subscribeLine(cb: (event: any) => void) {
                requireCodec()
                const upstream = wire.line.on(cb)
                let resolveEnded = function resolvePhysicalLineLater() {}
                const ended = new Promise<void>(function waitForPhysicalLineEnd(resolve) {
                    resolveEnded = resolve
                })
                function endPhysicalLine() {
                    physicalEnds.delete(endPhysicalLine)
                    resolveEnded()
                }
                physicalEnds.add(endPhysicalLine)
                const offConnect = rollingLifecycle.api.onConnect(function endRemovedCodecLine() {
                    if (!available()) endPhysicalLine()
                })
                return makeOff(ended, function stopPhysicalLine() {
                    physicalEnds.delete(endPhysicalLine)
                    offConnect()
                    if (typeof upstream == 'function') upstream()
                    else if (typeof upstream?.off == 'function') upstream.off()
                    else if (typeof upstream?.unsubscribe == 'function') upstream.unsubscribe()
                })
            }
            const wrapped: any = {
                line: {on: subscribeLine},
                since(seq: number) {
                    requireCodec()
                    return wire.since(seq)
                },
                keyframe() {
                    requireCodec()
                    return wire.keyframe()
                },
            }
            if (wire.frame) {
                wrapped.frame = function codecFrame(seq: number, hint?: unknown) {
                    requireCodec()
                    return wire.frame(seq, hint)
                }
            }
            wrapped.frameLine = {on: subscribeLine}
            return wrapped
        }

        const {v7: _removedV7, ...baseBatch} = rollingExposed.api.replay.batch!
        const rollingBatch: any = {
            ...baseBatch,
            v3: codecWire('v3', baseBatch.v3, function v3IsAvailable() { return true }),
            v4: codecWire('v4', baseBatch.v4, function v4IsAvailable() { return v4Available }),
            v5: codecWire('v5', baseBatch.v5, function v5IsAvailable() { return v5Available }),
            v6: codecWire('v6', baseBatch.v6, function v6IsAvailable() { return v6Available }),
        }
        const codecLookup = function lookupRollingCodec(member: string) {
            if (member == 'v6') return v6Available
            if (member == 'v5') return v5Available
            if (member == 'v4') return v4Available
            if (member == 'v3') return true
            return member in rollingBatch
        }
        Object.defineProperty(codecLookup, RPC_MEMBER_LOOKUP, {value: true})
        Object.defineProperty(rollingBatch, RPC_MEMBER_LOOKUP, {value: codecLookup})
        Object.defineProperty(rollingBatch, RPC_TRANSPORT_LIFECYCLE, {value: rollingLifecycle.api})
        const rollingRemote = {...rollingExposed.api.replay, batch: rollingBatch} as StoreReplayRemote
        const rollingMirror = createStore({x: 0}, {drain: 'micro'})
        const rollingFrameMirror = createStore({x: 0}, {drain: 'micro'})
        const rollingErrors: unknown[] = []
        const rollingFrameErrors: unknown[] = []
        const rollingSync = syncStoreReplay(rollingMirror, rollingRemote, {
            batch: true,
            onError: function rememberRollingError(error) { rollingErrors.push(error) },
        })
        const rollingFrameSync = syncStoreReplay(rollingFrameMirror, rollingRemote, {
            batch: true,
            policy: 'frame',
            onError: function rememberRollingFrameError(error) { rollingFrameErrors.push(error) },
        })
        await withTimeout(Promise.all([rollingSync.ready, rollingFrameSync.ready]))
        ok(rollingMirror.state.x == 1 && rollingFrameMirror.state.x == 1
            && codecCalls.v6 > 0 && codecCalls.v5 == 0 && codecCalls.v4 == 0 && codecCalls.v3 == 0
            && rollingErrors.length == 0 && rollingFrameErrors.length == 0,
        'initial compact catch-up selects v6 for queue and frame lines')

        const v6CallsBeforeV5 = codecCalls.v6
        v6Available = false
        rollingLifecycle.control.disconnect('rolling v6 to v5')
        rollingLifecycle.control.connect()
        rollingSource.state.x = 2
        await flushReactive(rollingSource.state)
        await waitForCondition('rolling v5 delivery', function rollingV5Delivered() {
            return (rollingMirror.state.x == 2 && rollingFrameMirror.state.x == 2)
                || rollingErrors.length > 0 || rollingFrameErrors.length > 0
        })
        ok(rollingErrors.length == 0 && rollingFrameErrors.length == 0
            && rollingMirror.state.x == 2 && rollingFrameMirror.state.x == 2 && codecCalls.v5 > 0
            && codecCalls.v6 == v6CallsBeforeV5,
        'queue/frame subscriptions rebind from unavailable v6 to v5')

        const v5CallsBeforeV4 = codecCalls.v5
        v5Available = false
        rollingLifecycle.control.disconnect('rolling v5 to v4')
        rollingLifecycle.control.connect()
        rollingSource.state.x = 3
        await flushReactive(rollingSource.state)
        await waitForCondition('rolling v4 delivery', function rollingV4Delivered() {
            return (rollingMirror.state.x == 3 && rollingFrameMirror.state.x == 3)
                || rollingErrors.length > 0 || rollingFrameErrors.length > 0
        })
        ok(rollingErrors.length == 0 && rollingFrameErrors.length == 0
            && rollingMirror.state.x == 3 && rollingFrameMirror.state.x == 3 && codecCalls.v4 > 0
            && codecCalls.v5 == v5CallsBeforeV4,
        'queue/frame subscriptions rebind from unavailable v5 to v4')

        const v4CallsBeforeV3 = codecCalls.v4
        v4Available = false
        rollingLifecycle.control.disconnect('rolling v4 to v3')
        rollingLifecycle.control.connect()
        rollingSource.state.x = 4
        await flushReactive(rollingSource.state)
        await waitForCondition('rolling v3 delivery', function rollingV3Delivered() {
            return (rollingMirror.state.x == 4 && rollingFrameMirror.state.x == 4)
                || rollingErrors.length > 0 || rollingFrameErrors.length > 0
        })
        ok(rollingErrors.length == 0 && rollingFrameErrors.length == 0
            && rollingMirror.state.x == 4 && rollingFrameMirror.state.x == 4
            && codecCalls.v3 > 0 && codecCalls.v4 == v4CallsBeforeV3,
        'the next generation falls through unavailable v5/v4 to v3')

        const v6CallsBeforeUpgrade = codecCalls.v6
        v6Available = true
        rollingLifecycle.control.disconnect('rolling v3 to v6')
        rollingLifecycle.control.connect()
        rollingSource.state.x = 5
        await flushReactive(rollingSource.state)
        await waitForCondition('rolling v6 upgrade delivery', function rollingV6Delivered() {
            return (rollingMirror.state.x == 5 && rollingFrameMirror.state.x == 5)
                || rollingErrors.length > 0 || rollingFrameErrors.length > 0
        })
        ok(rollingErrors.length == 0 && rollingFrameErrors.length == 0
            && rollingMirror.state.x == 5 && rollingFrameMirror.state.x == 5
            && codecCalls.v6 > v6CallsBeforeUpgrade,
        'a later generation upgrades queue/frame lines directly from v3 back to v6')

        for (const endLine of Array.from(physicalEnds)) endLine()
        await waitForCondition('current physical line termination', function currentLinesEnded() {
            return rollingErrors.length > 0 && rollingFrameErrors.length > 0
        })
        ok(rollingErrors.length == 1 && rollingFrameErrors.length == 1
            && String((rollingErrors[0] as any)?.message).includes('logical RPC line ended')
            && String((rollingFrameErrors[0] as any)?.message).includes('logical RPC line ended'),
        'a genuine current-generation queue/frame line end remains terminal')

        rollingSync()
        rollingFrameSync()
        rollingExposed.close()
    }

    console.log('\n[store-replay-capability-race] batch route waits for delayed RPC MAP')
    {
        const routeSource = createStore<State>({quotes: {ETH: {value: 11}}}, {drain: 'micro'})
        const batched = exposeStoreReplay(routeSource, {batch: true})
        const [routeRawClient, routeRawServer] = createInProcSocketPair()
        const routeCalls: any[][] = []
        const routeMaps: Array<{key: string, packet: any}> = []
        let routeBinaryPackets = 0
        const routeClientSocket: SocketTmpl = {
            on: routeRawClient.on,
            emit(key, packet) {
                if (Array.isArray(packet) && packet[0] == Pkt.CALL) routeCalls.push(packet)
                routeRawClient.emit(key, packet)
            },
        }
        const routeServerSocket: SocketTmpl = {
            on: routeRawServer.on,
            emit(key, packet) {
                if (containsBinary(packet)) routeBinaryPackets++
                if (Array.isArray(packet) && packet[0] == Pkt.MAP) {
                    routeMaps.push({key, packet})
                    return
                }
                routeRawServer.emit(key, packet)
            },
        }
        createRpcServerAuto({socket: routeServerSocket, socketKey: 'route-race', object: {state: batched.api.replay}})
        const routeRpc = createRpcClient<any>({socket: routeClientSocket, socketKey: 'route-race'})
        const routeRemote = routeRpc.func.state as StoreReplayRemote
        const routeMirror = createStore<State>({quotes: {}}, {drain: 'micro'})
        const routeErrors: unknown[] = []
        const route = syncStoreReplayRoute(routeMirror, routeRemote, {
            batch: true,
            onError: function rememberRouteError(error) { routeErrors.push(error) },
        })

        ok(routeCalls.length == 0, 'batch route sends no legacy subscription before MAP')
        for (const delayed of routeMaps.splice(0)) routeRawServer.emit(delayed.key, delayed.packet)
        await withTimeout(route.ready)
        await flushReactive(routeMirror.state)

        ok(route.mode == 'batch', 'batch route selects compact coordinates after MAP')
        ok(routeBinaryPackets > 0,
            'in-process RPC preserves the selected v7 binary envelope')
        ok(routeErrors.length == 0, 'delayed route schema does not produce a recovery error')
        ok(JSON.stringify(routeMirror.snapshot()) == JSON.stringify(routeSource.snapshot()),
            'deferred route catch-up converges after MAP')

        route()
        routeRpc.close()
        batched.close()
    }

    console.log('\n[store-replay-capability-race] v5 keeps client RPC limits inside the byte envelope')
    {
        const limitedSource = createStore<Record<string, string>>({}, {drain: 'micro'})
        const limitedExposed = exposeStoreReplay(limitedSource, {batch: true})
        const {
            v6: _removedV6, v7: _removedV7, ...limitedV5Batch
        } = limitedExposed.api.replay.batch!
        const limitedV5Replay = {...limitedExposed.api.replay, batch: limitedV5Batch}
        const [limitedClientSocket, limitedServerSocket] = createInProcSocketPair()
        createRpcServerAuto({
            socket: limitedServerSocket,
            socketKey: 'limited-v5',
            object: {state: limitedV5Replay},
        })
        const limitedRpc = createRpcClient<any>({
            socket: limitedClientSocket,
            socketKey: 'limited-v5',
            limits: {maxStringLen: 4},
        })
        const limitedMirror = createStore<Record<string, string>>({}, {drain: 'micro'})
        const limitedErrors: unknown[] = []
        const limitedSync = syncStoreReplay(
            limitedMirror,
            limitedRpc.func.state as StoreReplayRemote,
            {
                batch: true,
                onError: function rememberLimitedV5Error(error) { limitedErrors.push(error) },
            },
        )
        await withTimeout(limitedSync.ready)

        limitedSource.state.A = '€€€€'
        await flushReactive(limitedSource.state)
        await waitForCondition('limited v5 boundary value', function boundaryValueArrived() {
            return limitedMirror.state.A == '€€€€'
        })
        const acceptedSeq = limitedSync.seq()

        limitedSource.state.B = '12345'
        await flushReactive(limitedSource.state)
        await waitForCondition('limited v5 rejection', function limitedV5Failed() {
            return limitedErrors.length == 1
        })
        ok(limitedSync.seq() == acceptedSeq && limitedMirror.state.B == undefined,
            'v5 enforces maxStringLen in code units before Store mutation and seq commit')

        const [plainClientSocket, plainServerSocket] = createInProcSocketPair()
        createRpcServerAuto({
            socket: plainServerSocket,
            socketKey: 'plain-v5',
            object: {state: limitedV5Replay},
        })
        const plainRpc = createRpcClient<any>({socket: plainClientSocket, socketKey: 'plain-v5'})
        const plainMirror = createStore<Record<string, string>>({}, {drain: 'micro'})
        const plainSync = syncStoreReplay(
            plainMirror,
            plainRpc.func.state as StoreReplayRemote,
            {batch: true},
        )
        await withTimeout(plainSync.ready)
        ok(plainMirror.state.B == '12345',
            'the same v5 value remains valid when the client did not configure a tighter RPC limit')

        limitedSync()
        plainSync()
        limitedRpc.close()
        plainRpc.close()
        limitedExposed.close()
    }

    console.log('\n[store-replay-capability-race] close cancels a pending switch schema')
    {
        const firstSource = createStore<State>({quotes: {SOL: {value: 21}}}, {drain: 'micro'})
        const firstExposed = exposeStoreReplay(firstSource, {batch: true})
        const nextSource = createStore<State>({quotes: {SOL: {value: 34}}}, {drain: 'micro'})
        const nextExposed = exposeStoreReplay(nextSource, {batch: true})
        const switchMirror = createStore<State>({quotes: {}}, {drain: 'micro'})
        const route = syncStoreReplayRoute(switchMirror, firstExposed.api.replay, {batch: true})
        await withTimeout(route.ready)

        let schemaReleased = false
        let releaseSchema = function releaseSchemaLater() {}
        const schemaGate = new Promise<void>(function holdSwitchSchema(resolve) {
            releaseSchema = function resolveSwitchSchema() {
                schemaReleased = true
                resolve()
            }
        })
        const memberLookup = function delayedSwitchMember(member: string) {
            return schemaReleased ? member == 'batch' : undefined
        }
        Object.defineProperty(memberLookup, RPC_MEMBER_LOOKUP, {value: true})
        const schemaReady = function delayedSwitchSchema() { return schemaGate }
        Object.defineProperty(schemaReady, RPC_SCHEMA_READY, {value: true})
        let batchReads = 0
        const heldRemote: any = {}
        Object.defineProperty(heldRemote, RPC_MEMBER_LOOKUP, {value: memberLookup})
        Object.defineProperty(heldRemote, RPC_SCHEMA_READY, {value: schemaReady})
        Object.defineProperty(heldRemote, 'batch', {
            get() {
                batchReads++
                return nextExposed.api.replay.batch
            },
        })

        const pendingSwitch = route.switch(heldRemote as StoreReplayRemote)
        await Promise.resolve()
        route()
        const outcome = await withTimeout(pendingSwitch.then(
            function switchResolved() { return 'resolved' as const },
            function switchRejected() { return 'rejected' as const },
        ), 200)
        ok(outcome == 'rejected', 'close promptly rejects a switch blocked on a never-ready schema')

        releaseSchema()
        await Promise.resolve()
        await Promise.resolve()
        ok(batchReads == 0, 'a late schema resolution cannot create a post-close batch subscription')

        firstExposed.close()
        nextExposed.close()
    }

    console.log('\n[store-replay-capability-race] deferred schema rejection respects manual close')
    {
        const syncErrors: unknown[] = []
        let rejectSyncSchema = function rejectSyncSchemaLater(_error: unknown) {}
        const syncSchema = new Promise<void>(function holdSyncSchema(_resolve, reject) {
            rejectSyncSchema = reject
        })
        const sync = syncStoreReplay(
            createStore<State>({quotes: {}}, {drain: 'micro'}),
            createDeferredSchemaRemote(function waitForSyncSchema() { return syncSchema }),
            {
                batch: true,
                onError: function rememberLateSyncSchemaError(error) { syncErrors.push(error) },
            },
        )
        await Promise.resolve()
        sync()
        rejectSyncSchema(new Error('late sync schema failure'))
        await withTimeout(sync.ready)

        const routeErrors: unknown[] = []
        let rejectRouteSchema = function rejectRouteSchemaLater(_error: unknown) {}
        const routeSchema = new Promise<void>(function holdRouteSchema(_resolve, reject) {
            rejectRouteSchema = reject
        })
        const route = syncStoreReplayRoute(
            createStore<State>({quotes: {}}, {drain: 'micro'}),
            createDeferredSchemaRemote(function waitForRouteSchema() { return routeSchema }),
            {
                batch: true,
                onError: function rememberLateRouteSchemaError(error) { routeErrors.push(error) },
            },
        )
        await Promise.resolve()
        route()
        rejectRouteSchema(new Error('late route schema failure'))
        await withTimeout(route.ready)
        await Promise.resolve()

        ok(syncErrors.length == 0, 'sync close suppresses a later schema onError')
        ok(routeErrors.length == 0, 'route close suppresses a later schema onError')
    }

    console.log('\n[store-replay-capability-race] closed deferred schemas do not rethrow')
    {
        const processFailures: Array<{kind: string, error: unknown}> = []
        function captureUncaughtSchemaFailure(error: unknown) {
            processFailures.push({kind: 'uncaughtException', error})
        }
        function captureUnhandledSchemaFailure(error: unknown) {
            processFailures.push({kind: 'unhandledRejection', error})
        }
        process.on('uncaughtException', captureUncaughtSchemaFailure)
        process.on('unhandledRejection', captureUnhandledSchemaFailure)
        try {
            let rejectSyncSchema = function rejectSyncSchemaLater(_error: unknown) {}
            const syncSchema = new Promise<void>(function holdSyncSchema(_resolve, reject) {
                rejectSyncSchema = reject
            })
            const sync = syncStoreReplay(
                createStore<State>({quotes: {}}, {drain: 'micro'}),
                createDeferredSchemaRemote(function waitForSyncSchema() { return syncSchema }),
                {batch: true},
            )
            await Promise.resolve()
            sync()
            rejectSyncSchema(new Error('late uncaught sync schema failure'))
            await withTimeout(sync.ready)

            let rejectRouteSchema = function rejectRouteSchemaLater(_error: unknown) {}
            const routeSchema = new Promise<void>(function holdRouteSchema(_resolve, reject) {
                rejectRouteSchema = reject
            })
            const route = syncStoreReplayRoute(
                createStore<State>({quotes: {}}, {drain: 'micro'}),
                createDeferredSchemaRemote(function waitForRouteSchema() { return routeSchema }),
                {batch: true},
            )
            await Promise.resolve()
            route()
            rejectRouteSchema(new Error('late uncaught route schema failure'))
            await withTimeout(route.ready)
            await new Promise<void>(function letDeferredSchemaThrowsRun(resolve) { setTimeout(resolve, 10) })
        } finally {
            process.removeListener('uncaughtException', captureUncaughtSchemaFailure)
            process.removeListener('unhandledRejection', captureUnhandledSchemaFailure)
        }
        ok(processFailures.length == 0, 'manual close leaves no deferred schema exception or rejection')
    }

    console.log('\n[store-replay-capability-race] live deferred schema rejection stays visible')
    {
        const syncErrors: unknown[] = []
        let rejectSyncSchema = function rejectSyncSchemaLater(_error: unknown) {}
        const syncSchema = new Promise<void>(function holdSyncSchema(_resolve, reject) {
            rejectSyncSchema = reject
        })
        const sync = syncStoreReplay(
            createStore<State>({quotes: {}}, {drain: 'micro'}),
            createDeferredSchemaRemote(function waitForSyncSchema() { return syncSchema }),
            {
                batch: true,
                onError: function rememberSyncSchemaError(error) { syncErrors.push(error) },
            },
        )
        await Promise.resolve()
        const syncFailure = new Error('live sync schema failure')
        rejectSyncSchema(syncFailure)
        await withTimeout(sync.ready)

        const routeErrors: unknown[] = []
        let rejectRouteSchema = function rejectRouteSchemaLater(_error: unknown) {}
        const routeSchema = new Promise<void>(function holdRouteSchema(_resolve, reject) {
            rejectRouteSchema = reject
        })
        const route = syncStoreReplayRoute(
            createStore<State>({quotes: {}}, {drain: 'micro'}),
            createDeferredSchemaRemote(function waitForRouteSchema() { return routeSchema }),
            {
                batch: true,
                onError: function rememberRouteSchemaError(error) { routeErrors.push(error) },
            },
        )
        await Promise.resolve()
        const routeFailure = new Error('live route schema failure')
        rejectRouteSchema(routeFailure)
        await withTimeout(route.ready)

        ok(syncErrors.length == 1 && syncErrors[0] == syncFailure,
            'sync reports exactly one schema rejection while still open')
        ok(routeErrors.length == 1 && routeErrors[0] == routeFailure,
            'route reports exactly one schema rejection while still open')

        sync()
        route()
    }

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
