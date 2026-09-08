import {createStore} from '../src/Common/Observe/store'
import {exposeStoreReplay, syncStoreReplay, syncStoreReplayBatch, syncStoreReplayEach, syncStoreReplayRoute, type StoreReplayRemote} from '../src/Common/Observe/store-replay'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createMemoryOfflineStorage, createOfflineStore} from '../src/Common/Observe/store-offline'
import {createStoreReplicaOffers, createStoreReplicaSet, type StoreReplicaSession} from '../src/Common/Observe/store-replica-set'
import {createClusterClient} from '../src/Common/scale/scale-client'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createStoreNode, type StoreNodeDeps, type StoreNodeUpstream} from '../src/Common/Observe/store-node'
import type {CommandCtx} from '../src/Common/command/command-host'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'

declare const socket: SocketTmpl
declare const legacy: StoreReplayRemote
declare const roster: StoreReplayRemote

function statePropagation() {
    const source = createStore({counter: {value: 1, label: 'count'}})
    const target = createStore({counter: {value: 0}})
    const wrong = createStore({counter: {value: 'wrong'}})
    const exposed = exposeStoreReplay(source)
    const typed: StoreReplayRemote<{counter: {value: number}}> = exposed.api.replay
    syncStoreReplay(target, typed)
    syncStoreReplayBatch(target, exposed.api.replay)
    // @ts-expect-error producer state cannot populate incompatible scalar fields
    syncStoreReplay(wrong, exposed.api.replay)
    // @ts-expect-error batch sync retains the same source-state contract
    syncStoreReplayBatch(wrong, exposed.api.replay)
    // Legacy transports deliberately remain structurally compatible.
    syncStoreReplay(wrong, legacy)

    const routed = syncStoreReplayRoute(target, exposed.api.replay)
    routed.switch(exposed.api.replay)
    // @ts-expect-error replacing a route must preserve the destination state shape
    routed.switch(exposeStoreReplay(wrong).api.replay)

    const follower = createStoreFollower({remote: exposed.api.replay})
    const count: number = follower.store.state.counter.value
    // @ts-expect-error follower infers the actual producer fields
    const badCount: string = follower.store.state.counter.value
    const each = syncStoreReplayEach(exposed.api.replay, function observe(_key, value) {
        const current: number | undefined = value?.value
        void current
    })
    const label: string = each.store.state.counter.label
    // @ts-expect-error explicit mismatched follower state is rejected
    createStoreFollower<{counter: {value: string}}>({remote: exposed.api.replay})
    // @ts-expect-error initial state must not widen away a concrete source mismatch
    createStoreFollower({initial: {counter: {value: 'wrong'}}, remote: exposed.api.replay})
    // @ts-expect-error initial offline state defines the expected producer fields
    createOfflineStore({key: 'bad', storage: createMemoryOfflineStorage(), initial: {counter: {value: ''}}, remote: exposed.api.replay})

    const replica = createStoreReplicaSet({storeId: 's', originId: 's', nodeId: 'n', initial: source.snapshot()})
    const session: StoreReplicaSession<{counter: {value: number}}> = {remote: replica.api.fragment, close() {}}
    const offers = createStoreReplicaOffers<{counter: {value: number}}>()
    offers.control.upsert({id: 'ok', connect: () => session})
    // @ts-expect-error typed offer registry rejects incompatible producer state
    createStoreReplicaOffers<{counter: {value: string}}>([{id: 'bad', connect: () => session}])
    createClusterClient({line: {storeId: 's', originId: 's', nodeId: 'client', initial: target.snapshot()}, roster, connect: () => session})
    // @ts-expect-error cluster initial state and connected replica must agree
    createClusterClient({line: {storeId: 's', originId: 's', nodeId: 'client', initial: wrong.snapshot()}, roster, connect: () => session})

    const rpc = createRpcClient<{replay: typeof exposed.api.replay}>({socket, socketKey: 'typed-replay'})
    const remote: StoreReplayRemote<{counter: {value: number}}> = rpc.func.replay
    const strictRemote: StoreReplayRemote<{counter: {value: number}}> = rpc.strict.replay
    syncStoreReplay(target, remote)
    // @ts-expect-error RPC projection must retain the producer state marker
    syncStoreReplay(wrong, rpc.func.replay)
    // @ts-expect-error strict projection must retain the producer state marker
    syncStoreReplay(wrong, rpc.strict.replay)
    void strictRemote
    void count
    void badCount
    void label
}

void statePropagation

type CounterState = {counter: {value: number}}
type CounterCommands = {add: (ctx: CommandCtx, input: {delta: number}) => {value: number}}
declare const nodeDeps: StoreNodeDeps<CounterState, CounterCommands>
declare const nodeUpstream: StoreNodeUpstream<CounterState, CounterCommands>

function typedNodeCommands() {
    createStoreNode({...nodeDeps, commands: ['add']})
    // @ts-expect-error command names infer from the typed upstream without explicit factory generics
    createStoreNode({...nodeDeps, commands: ['missing']})
    createStoreNode<CounterState, CounterCommands>({...nodeDeps, commands: ['add']})
    // @ts-expect-error configured forwarded names must exist in the command family
    createStoreNode<CounterState, CounterCommands>({...nodeDeps, commands: ['missing']})
    const result: Promise<{value: number}> | undefined = nodeUpstream.commandsByToken?.add('token', 'request', {delta: 1})
    // @ts-expect-error token forwarded inputs retain the authority command input
    nodeUpstream.commandsByToken?.add('token', 'request', {delta: 'wrong'})
    // @ts-expect-error token command results retain their scalar types
    const wrongResult: Promise<{value: string}> | undefined = nodeUpstream.commandsByToken?.add('token', 'request', {delta: 1})
    void result
    void wrongResult
}

void typedNodeCommands
