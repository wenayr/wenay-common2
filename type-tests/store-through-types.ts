import {createStore, exposeStore} from '../src/Common/Observe/store'
import {exposeStoreReplay, type StoreReplayRemote} from '../src/Common/Observe/store-replay'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import {createAuthority} from '../src/Common/scale/scale-authority'
import {createClusterClient} from '../src/Common/scale/scale-client'
import type {StoreReplicaSession} from '../src/Common/Observe/store-replica-set'
import type {CommandCtx} from '../src/Common/command/command-host'

declare const socket: SocketTmpl

function storeThroughRpcAndScale() {
    const store = createStore({counter: {value: 0, label: 'counter'}})
    const value: number = store.node.counter.value.get()
    store.node.counter.value.set(value + 1)
    // @ts-expect-error a typed Store node keeps its value type
    store.node.counter.value.set('wrong')
    // @ts-expect-error a fixed Store shape has no unknown key
    store.node.missing.get()

    const selected = store.update({counter: {value: true}} as const).get()
    const selectedValue: number = selected.counter.value
    // @ts-expect-error masks narrow the selected state
    selected.counter.label

    const exposed = exposeStore(store)
    const localSnapshotValue: number = exposed.get().counter.value
    const localSelection = exposed.get({counter: {value: true}})
    // @ts-expect-error the Store's local mask overload keeps the selected shape
    localSelection.counter.label

    const replay = exposeStoreReplay(store)
    const facade = {read: () => store.snapshot(), replay: replay.api.replay}
    const rpc = createRpcClient<typeof facade>({socket, socketKey: 'typed-store'})
    const remote: StoreReplayRemote = rpc.func.replay

    async function readTypedState() {
        const state = await rpc.func.read()
        const exact: number = state.counter.value
        // @ts-expect-error ordinary RPC results preserve source Store fields
        const wrong: string = state.counter.value
        void exact
        void wrong
    }

    const authority = createAuthority({
        line: {storeId: 'typed', originId: 'typed', initial: store.snapshot()},
        roster: {url: () => 'memory://typed'},
        identity: {issue: account => account, verify: () => ({account: 'typed'})},
        corridor: {commands: {
            add(ctx: CommandCtx, input: {delta: number}) {
                return {value: input.delta, account: ctx.account}
            },
        }},
    })
    type tBrowser = ReturnType<typeof authority.serve.browser>
    type tPrincipal = ReturnType<ReturnType<typeof authority.serve.connection>['auth']['resolveAuth']>['object']
    const hub = createRpcClientHub(() => socket, rpc => ({browser: rpc<tBrowser>(), write: rpc<tPrincipal>()}))
    const clients = hub.facade
    const dynamicDemo = createRpcClientHub(() => socket, rpc => ({app: rpc<Record<string, any> & {miniScale: tBrowser}>()}))
    const nodeLink = createRpcClient<ReturnType<typeof authority.serve.nodeLink>>({socket, socketKey: 'node'})
    const wrappedNode = createRpcClient<{miniScale: Pick<tPrincipal, 'whoami' | 'commands'>}>({socket, socketKey: 'scale'})
    const session = {remote: clients.browser.func.replica, close() {}} satisfies StoreReplicaSession
    const cluster = createClusterClient({
        line: {storeId: 'typed', originId: 'typed', nodeId: 'consumer', initial: store.snapshot()},
        roster: clients.browser.func.roster,
        connect: () => session,
    })
    const count: number = cluster.store.state.counter.value
    // @ts-expect-error a cluster materialized from typed initial state keeps its field type
    const wrongCount: string = cluster.store.state.counter.value
    // @ts-expect-error a cluster's typed Store rejects unrelated fields
    cluster.store.node.missing.get()

    async function commandTypesReachConsumer() {
        const identity = dynamicDemo.facade.app.func.miniScale.identity
        const minted = await identity.login()
        const token: string = minted.token
        // @ts-expect-error a dynamic root must not erase the explicitly typed miniScale facet
        await identity.missing()
        // @ts-expect-error a typed result stays typed beside dynamic siblings
        const wrongToken: number = minted.token
        const result = await clients.write.func.commands.add('request', {delta: 1})
        const forwarded = await nodeLink.func.commandsByToken.add('token', 'request', {delta: 1})
        const forwardedValue: number = forwarded.value
        const mirrored = await wrappedNode.func.miniScale.commands.add('request', {delta: 1})
        const mirroredValue: number = mirrored.value
        // @ts-expect-error the mirror host wraps its write surface under miniScale
        await wrappedNode.func.commands.add('request', {delta: 1})
        // @ts-expect-error mirrors expose commands/whoami, not the leader's revocation command
        await wrappedNode.func.miniScale.revoke()
        const exact: number = result.value
        const account: string = result.account
        // @ts-expect-error command input is derived through authority and RPC
        await clients.write.func.commands.add('request', {delta: 'wrong'})
        // @ts-expect-error command names are derived from the source factory
        await clients.write.func.commands.missing('request', {})
        // @ts-expect-error command result must not degrade to any
        const wrong: string = result.value
        // @ts-expect-error node-link command input is derived from the same source
        await nodeLink.func.commandsByToken.add('token', 'request', {delta: 'wrong'})
        void exact
        void token
        void wrongToken
        void account
        void wrong
        void forwardedValue
        void mirroredValue
    }
    void selectedValue
    void localSnapshotValue
    void remote
    void readTypedState
    void count
    void wrongCount
    void commandTypesReachConsumer
}

void storeThroughRpcAndScale
