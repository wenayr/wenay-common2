// Optional RPC members must follow the declared schema, never deep-proxy truthiness.

import {createStore, createStoreMirror, exposeStore} from '../src/Common/Observe/store'
import {flushReactive} from '../src/Common/Observe/reactive'
import {createStoreReplicaOffers, createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {createRouteCoordinator, RouteConnector} from '../src/Common/events/route-coordinator'
import {replayListen} from '../src/Common/events/replay-listen'
import {RPC_MEMBER_LOOKUP} from '../src/Common/events/transport-lifecycle'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createInProcSocketPair} from '../src/Common/rcp/rpc-inproc'
import {Pkt, SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

const delay = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000) {
    let timer: any
    try {
        return await Promise.race([
            promise,
            new Promise<never>(function rejectAfterTimeout(_, reject) {
                timer = setTimeout(function optionalCapabilityTimeout() { reject(new Error('optional capability timeout')) }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function brandLookup(remote: object, available: (member: string) => boolean | undefined) {
    const lookup = function lookupMember(member: string) { return available(member) }
    Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
    Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: lookup})
}

async function main() {
    console.log('\n[rpc-optional-capability] raw Store waits for schema and falls back to changed')
    {
        const source = createStore({value: 1}, {drain: 'micro'})
        const {changedPaths: _changedPaths, patches: _patches, patchesBatch: _patchesBatch,
            changedData: _changedData, ...legacyApi} = exposeStore(source, {push: false})
        const [rawClient, rawServer] = createInProcSocketPair()
        const delayedMaps: Array<{key: string, packet: any}> = []
        const calls: any[][] = []
        const clientSocket: SocketTmpl = {
            on: rawClient.on,
            emit(key, packet) {
                if (Array.isArray(packet) && packet[0] == Pkt.CALL) calls.push(packet)
                rawClient.emit(key, packet)
            },
        }
        const serverSocket: SocketTmpl = {
            on: rawServer.on,
            emit(key, packet) {
                if (Array.isArray(packet) && packet[0] == Pkt.MAP) {
                    delayedMaps.push({key, packet})
                    return
                }
                rawServer.emit(key, packet)
            },
        }
        createRpcServerAuto({socket: serverSocket, socketKey: 'store-optional', object: {store: legacyApi}})
        const rpc = createRpcClient<any>({socket: clientSocket, socketKey: 'store-optional'})
        const mirror = createStoreMirror<{value: number}>(rpc.func.store, {value: 0}, {drain: 'micro'})
        const syncing = mirror.sync(true)

        ok(calls.length == 0, 'changedPaths is not probed before delayed MAP')
        for (const delayed of delayedMaps.splice(0)) rawServer.emit(delayed.key, delayed.packet)
        const off = await withTimeout(syncing)
        source.state.value = 2
        await flushReactive(source.state)
        await delay(10)
        await flushReactive(mirror.state)

        ok(mirror.state.value == 2, 'missing changedPaths falls back to the declared changed line')
        let patchesRejected = false
        let changedDataRejected = false
        try { await mirror.syncPatches(true, {batch: false}) } catch { patchesRejected = true }
        try { await mirror.syncChangedData(true) } catch { changedDataRejected = true }
        ok(patchesRejected, 'missing patches is rejected from schema instead of proxy shape')
        ok(changedDataRejected, 'missing changedData is rejected from schema instead of proxy shape')

        off()
        rpc.close()
    }

    console.log('\n[rpc-optional-capability] lazy route wrapper honors absent frame APIs')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 16})
        let frameCalls = 0
        let frameLineCalls = 0
        const remote: any = {
            line: replay.line,
            since: (seq: number) => replay.getSince(seq) ?? null,
            keyframe: () => replay.keyframe() ?? null,
            frame() { frameCalls++; throw new Error('absent frame called') },
            frameLine: {
                on() { frameLineCalls++; throw new Error('absent frameLine called') },
            },
        }
        brandLookup(remote, member => member == 'frame' || member == 'frameLine' ? false : true)
        let connectorState: 'idle' | 'open' | 'closed' = 'idle'
        const connector: RouteConnector<[number]> = {
            info: {label: 'legacy', kind: 'relay', ordered: true, reliable: true},
            open() { connectorState = 'open'; return remote },
            close() { connectorState = 'closed' },
            state: () => connectorState,
        }
        const coordinator = createRouteCoordinator<[number]>({connect: () => connector})
        const link = coordinator.pair('a', 'b')
        const initial: number[] = []
        const first = link.subscribe(value => initial.push(value), {policy: 'frame'})
        await withTimeout(first.ready)
        state = 1
        emit(state)
        await delay()
        const resumed: number[] = []
        const second = link.subscribe(value => resumed.push(value), {policy: 'frame', since: 0})
        await withTimeout(second.ready)

        ok(frameLineCalls == 0, 'absent frameLine falls back to line')
        ok(frameCalls == 0, 'absent frame falls back to since/keyframe')
        ok(initial.includes(0) && initial.includes(1) && resumed.includes(1), 'fallback route remains live and catches up')

        first()
        second()
        coordinator.close()
    }

    console.log('\n[rpc-optional-capability] replica skips absent ping and changed')
    {
        const leader = createStoreReplicaSet<{value: number}>({
            storeId: 'optional', originId: 'optional', nodeId: 'leader', lineId: 'leader-line',
            initial: {value: 7}, leadership: {initialRole: 'leader', epoch: 1},
        })
        const fragment = leader.api.fragment
        let pingReads = 0
        let changedReads = 0
        const remote: any = {
            descriptor: fragment.descriptor,
            replay: fragment.replay,
        }
        Object.defineProperty(remote, 'ping', {
            get() { pingReads++; return function forbiddenPing() { throw new Error('absent ping called') } },
        })
        Object.defineProperty(remote, 'changed', {
            get() {
                changedReads++
                return {on() { throw new Error('absent changed called') }}
            },
        })
        brandLookup(remote, member => member == 'ping' || member == 'changed' ? false : true)
        const offers = createStoreReplicaOffers([{
            id: 'leader',
            connect() { return {remote, close() {}} },
        }])
        const replica = createStoreReplicaSet<{value: number}>({
            storeId: 'optional', originId: 'optional', nodeId: 'replica', lineId: 'replica-line',
            initial: {value: 0}, offers: offers.api, leadership: {initialRole: 'follower', eligible: false},
        })
        await withTimeout(replica.api.ready)

        ok(pingReads == 0 && changedReads == 0, 'schema-absent optional replica members are never dereferenced')
        ok(replica.api.store.state.value == 7, 'replica converges without optional ping/changed')

        replica.close()
        leader.close()
    }

    console.log('\n[rpc-optional-capability] plain route keeps inherited frame APIs')
    {
        let state = 0
        const [emit, replay] = replayListen<[number]>({current: () => [state], history: 16})
        let frameCalls = 0
        let frameLineOns = 0
        const remotePrototype = {
            frame(seq: number, hint?: unknown) {
                frameCalls++
                return replay.frame(seq, hint)
            },
            frameLine: {
                on(cb: (event: any) => void) {
                    frameLineOns++
                    return replay.line.on(cb)
                },
            },
        }
        const remote = Object.assign(Object.create(remotePrototype), {
            line: replay.line,
            since: (seq: number) => replay.getSince(seq) ?? null,
            keyframe: () => replay.keyframe() ?? null,
        })
        const connector: RouteConnector<[number]> = {
            info: {label: 'prototype', kind: 'relay', ordered: true, reliable: true},
            open: () => remote,
            close() {},
            state: () => 'open',
        }
        const coordinator = createRouteCoordinator<[number]>({connect: () => connector})
        const link = coordinator.pair('prototype-a', 'prototype-b')
        const first = link.subscribe(function consumeInitial() {}, {policy: 'frame'})
        await withTimeout(first.ready)
        state = 1
        emit(state)
        await delay()
        const resumed: number[] = []
        const second = link.subscribe(value => resumed.push(value), {policy: 'frame', since: 0})
        await withTimeout(second.ready)

        ok(frameLineOns > 0, 'plain inherited frameLine remains available')
        ok(frameCalls > 0 && resumed.includes(1), 'plain inherited frame remains available')

        first()
        second()
        coordinator.close()
    }

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
