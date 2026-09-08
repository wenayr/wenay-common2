import {createStore, exposeStore} from '../src/Common/Observe/store'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
import {createRpcClient} from '../src/Common/rcp/rpc-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import type {SocketTmpl} from '../src/Common/rcp/rpc-protocol'
import type {ClientAPIAll, DeepDataOnly} from '../src/Common/rcp/rpc-client'
import type {DeepSocketListenSmart, DeepSocketListenFirst, DeepSocketListenAll} from '../src/Common/rcp/listen-deep'
import type {StoreGetter} from '../src/Common/Observe/store'
import type {tConversationData} from '../src/Common/conversation/conversation-data'

declare const socket: SocketTmpl
declare const optional: ClientAPIAll<DeepSocketListenSmart<{promote(): number} | {promote?: undefined}>>
type ReadFacet = {read?: StoreGetter<{value: number, label: string}> | null}
declare const nullable: ClientAPIAll<ReadFacet>
declare const first: ClientAPIAll<DeepSocketListenFirst<{read: NonNullable<ReadFacet['read']>}>>
declare const all: ClientAPIAll<DeepSocketListenAll<{read: NonNullable<ReadFacet['read']>}>>
declare const recursiveData: DeepDataOnly<tConversationData>
declare const symbolMethod: unique symbol
declare const arrayWithMethod: DeepDataOnly<number[] & {method(): void}>
declare const objectWithSymbolMethod: DeepDataOnly<{value: number, [symbolMethod](): void}>
declare const recursiveMethods: DeepDataOnly<{value: number, next?: {method(): void, data: tConversationData}}>

async function projectionBoundaries() {
    if (nullable.read) {
        const value: number = (await nullable.read()).value
        const picked = await nullable.read({label: true})
        // @ts-expect-error optional getter still narrows masked results
        picked.value
        void value
    }
    const a: number = (await first.read()).value
    const b = await all.read({label: true})
    // @ts-expect-error First/All composition keeps the getter mask
    b.value
    const data: tConversationData = recursiveData
    // @ts-expect-error array transport carries elements, not attached methods
    arrayWithMethod.method()
    // @ts-expect-error symbol methods are not part of transported data
    objectWithSymbolMethod[symbolMethod]()
    // @ts-expect-error JSON shortcut must not preserve methods in mixed object trees
    recursiveMethods.next?.method()
    void [a, data]
}

async function optionalMethod() {
    const promote = optional.promote
    if (promote) {
        const result: number = await promote()
        void result
    }
}

function checkStoreGet() {
    const store = createStore({user: {name: 'Ada', score: 0}, bytes: new Uint8Array(2)})
    const api = exposeStore(store)
    const replay = exposeStoreReplay(store)
    const client = createRpcClient<typeof api>({socket, socketKey: 'store'})
    const hub = createRpcClientHub(() => socket, r => ({store: r<typeof replay.api>('store')}))
    const named = createRpcClient<{read: typeof api.get, ordinary: (mask: string) => number}>({socket, socketKey: 'named'})

    async function calls() {
        const full = await client.func.get()
        const score: number = full.user.score
        const selected = await client.func.get({user: {name: true}})
        const name: string = selected.user.name
        // @ts-expect-error the selected result excludes score
        selected.user.score
        // @ts-expect-error state values cannot silently become any
        const wrong: string = full.user.score
        // @ts-expect-error unknown mask key
        await client.func.get({missing: true})
        const strict = await client.strict.get({user: {score: true}})
        const strictScore: number = strict.user.score
        // @ts-expect-error strict lane preserves the mask too
        strict.user.name
        const pipe = await client.pipe.get({user: {score: true}})
        const pipeScore: number = pipe.user.score
        // @ts-expect-error pipe lane preserves the mask
        pipe.user.name
        const throughHub = await hub.facade.store.func.get()
        const hubName: string = throughHub.user.name
        const renamed = await named.func.read({user: {name: true}})
        // @ts-expect-error recognition follows the original function type, not its property name
        renamed.user.score
        const ordinary: number = await named.func.ordinary('mask')
        const binary: Uint8Array = (await client.func.get({bytes: true})).bytes
        void [score, name, wrong, strictScore, pipeScore, hubName, ordinary, binary]
    }

    const collision = createStore({get: 1, replace: 'value'})
    const value: number = collision.node.at('get').get()
    // @ts-expect-error at retains the known colliding field type
    collision.node.at('get').set('wrong')
    // The existing unknown-key escape hatch stays available.
    collision.node.at('dynamic').get()
    void value
    void calls
}

void checkStoreGet
void optionalMethod
void projectionBoundaries
