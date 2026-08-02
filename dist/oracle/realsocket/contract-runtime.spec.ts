// REAL-SOCKET oracle: contract implementations travel as ordinary RPC facades,
// while one Store/replay mirror remains alive across an atomic implementation swap.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createStore} from '../../src/Common/Observe/store'
import {exposeStoreReplay, syncStoreReplay} from '../../src/Common/Observe/store-replay'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {ContractOffer, createContractRuntime} from '../../src/Common/contract/contract-index'

const PORT = 3168

type State = {value: number, writer: string}
type RemoteEditor = {
    identity: () => Promise<string>
    delayedIdentity: (waitMs: number) => Promise<string>
    add: (value: number) => Promise<number>
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) return
        await delay(10)
    }
    throw new Error('timeout waiting for ' + label)
}

function descriptor(id: string) {
    return {
        protocol: 1 as const,
        contractId: 'counter.editor',
        contractVersion: '1.0.0',
        implementationId: id,
        implementationVersion: id + '-1',
    }
}

function rpcOffer(
    id: string,
    priority: number,
    connection: Awaited<ReturnType<typeof startRealClient>>,
    api: RemoteEditor,
): ContractOffer<RemoteEditor> {
    return {
        id,
        priority,
        descriptor: descriptor(id),
        open() {
            return {
                api,
                onFail: {on: connection.client.onDisconnect},
                close() {},
            }
        },
    }
}

async function main() {
    const {check, done} = makeChecker('contract-runtime')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('contract-runtime oracle timed out')
        process.exit(3)
    }, 120000)

    const authoritative = createStore<State>({value: 1, writer: 'seed'})
    const exposed = exposeStoreReplay(authoritative, {history: 100})

    function editor(id: string) {
        return {
            identity: () => id,
            async delayedIdentity(waitMs: number) {
                await delay(waitMs)
                return id
            },
            async add(value: number) {
                authoritative.state.value += value
                authoritative.state.writer = id
                await flushReactive(authoritative.state)
                return authoritative.state.value
            },
        }
    }

    const server = await startRealServer({
        port: PORT,
        makeObject: () => ({
            state: exposed.api.replay,
            editorA: editor('rpc-editor-a'),
            editorB: editor('rpc-editor-b'),
        }),
    })
    const connection = await startRealClient({port: PORT})
    const mirror = createStore<State>({value: 0, writer: ''})
    const sync = syncStoreReplay(mirror, connection.api.state)
    await sync.ready

    const runtime = createContractRuntime({retryMs: 100})
    await runtime.control.addOffer(rpcOffer('rpc-editor-a', 1, connection, connection.api.editorA))
    await runtime.control.require({
        slotId: 'counter',
        contractId: 'counter.editor',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'backend',
        authorityEpoch: 1,
    })
    await check('RPC contract offer becomes the first binding', () => runtime.api.binding('counter')?.offerId, 'rpc-editor-a')

    const first = runtime.api.acquire<RemoteEditor>('counter')
    await check('first binding invokes the real RPC facade', () => first.api.identity(), 'rpc-editor-a')
    await first.api.add(2)
    await waitFor('first RPC write reaches the mirror', () => mirror.state.value == 3)
    const seqBeforeSwap = sync.seq()
    const oldInFlight = first.api.delayedIdentity(80)

    await runtime.control.addOffer(rpcOffer('rpc-editor-b', 5, connection, connection.api.editorB))
    await waitFor('higher-priority RPC binding activates', () => runtime.api.binding('counter')?.offerId == 'rpc-editor-b')
    const second = runtime.api.acquire<RemoteEditor>('counter')
    await check('replacement binding invokes the second RPC facade', () => second.api.identity(), 'rpc-editor-b')
    await second.api.add(4)
    second.release()
    await waitFor('second RPC write reaches the same mirror', () => mirror.state.value == 7)
    await check('old in-flight RPC remains pinned to the retired binding', () => oldInFlight, 'rpc-editor-a')
    first.release()

    await check('Store mirror remains continuous across the contract swap', () => ({
        state: mirror.snapshot(),
        seqAdvanced: sync.seq() > seqBeforeSwap,
    }), {state: {value: 7, writer: 'rpc-editor-b'}, seqAdvanced: true})
    const socket = connection.hub.socket as any
    const connectCount = connection.hub.connectCount()
    const engine = socket.io?.engine
    if (!engine?.close) throw new Error('Engine.IO close() is unavailable')
    engine.close()
    await waitFor('real transport disconnect', () => !socket.connected)
    authoritative.state.value = 11
    authoritative.state.writer = 'offline-source'
    await flushReactive(authoritative.state)
    await waitFor('same Socket.IO object reconnects', () =>
        socket.connected && connection.hub.connectCount() == connectCount + 1)
    await waitFor('mirror catches up after transport reconnect', () => mirror.state.value == 11)
    await check('reconnect preserves the same logical Socket.IO object', () => connection.hub.socket == socket, true)
    await check('reconnect keeps one Store Replay wire subscription', () =>
        connection.client.api.subscriptions().length, 1)

    const afterReconnect = runtime.api.acquire<RemoteEditor>('counter')
    await check('active implementation still serves calls after reconnect', () =>
        afterReconnect.api.identity(), 'rpc-editor-b')
    afterReconnect.release()

    const rolledBack = await runtime.control.rollback('counter')
    await check('rollback reactivates the previous verified offer', () => ({
        offerId: rolledBack.offerId,
        generation: rolledBack.bindingGeneration,
    }), {offerId: 'rpc-editor-a', generation: 3})
    const afterRollback = runtime.api.acquire<RemoteEditor>('counter')
    await check('new calls route through the rolled-back implementation', () =>
        afterRollback.api.identity(), 'rpc-editor-a')
    await afterRollback.api.add(5)
    afterRollback.release()
    await waitFor('rollback write reaches the continuous mirror', () => mirror.state.value == 16)

    await check('binding history records replacement and rollback', () => runtime.api.history().map(event => [
        event.from?.offerId ?? null,
        event.to?.offerId ?? null,
    ]), [
        [null, 'rpc-editor-a'],
        ['rpc-editor-a', 'rpc-editor-b'],
        ['rpc-editor-b', 'rpc-editor-a'],
    ])
    await check('one Store mirror spans both swaps and reconnect', () => ({
        state: mirror.snapshot(),
        seqAdvanced: sync.seq() > seqBeforeSwap,
    }), {state: {value: 16, writer: 'rpc-editor-a'}, seqAdvanced: true})

    runtime.close()
    sync()
    exposed.close()
    connection.close()
    await server.close()
    clearTimeout(watchdog)
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
