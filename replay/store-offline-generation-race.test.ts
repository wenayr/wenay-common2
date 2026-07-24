// Deferred RPC schema must not resurrect a closed or superseded offline-store subscription.

import {createMemoryOfflineStorage, createOfflineStore} from '../src/Common/Observe/store-offline'
import {StoreReplayRemote} from '../src/Common/Observe/store-replay'
import {RPC_MEMBER_LOOKUP, RPC_SCHEMA_READY} from '../src/Common/events/transport-lifecycle'

type State = {source: string}

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
                timer = setTimeout(function offlineGenerationTimeout() { reject(new Error('offline generation timeout')) }, timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function createDeferredRemote(source: string, holdKeyframe = false) {
    let schemaKnown = false
    let resolveSchema = function resolveSchemaLater() {}
    const schema = new Promise<void>(function waitForSchema(resolve) { resolveSchema = resolve })
    let resolveKeyframe = function resolveKeyframeLater() {}
    const keyframeGate = new Promise<void>(function waitForKeyframe(resolve) { resolveKeyframe = resolve })
    let active = 0
    let subscriptions = 0
    const remote: StoreReplayRemote = {
        line: {
            on() {
                subscriptions++
                active++
                let live = true
                return function offDeferredLine() {
                    if (!live) return
                    live = false
                    active--
                }
            },
        },
        since: () => null,
        async keyframe() {
            if (holdKeyframe) await keyframeGate
            return {
                seq: 0,
                ts: 1,
                event: [{path: [], exists: true, value: {source}}],
            }
        },
    }
    const lookup = function lookupMember(member: string) {
        if (!schemaKnown) return undefined
        return Object.prototype.hasOwnProperty.call(remote, member)
    }
    Object.defineProperty(lookup, RPC_MEMBER_LOOKUP, {value: true})
    Object.defineProperty(remote, RPC_MEMBER_LOOKUP, {value: lookup})
    const schemaReady = function waitForDeferredSchema() { return schema }
    Object.defineProperty(schemaReady, RPC_SCHEMA_READY, {value: true})
    Object.defineProperty(remote, RPC_SCHEMA_READY, {value: schemaReady})
    return {
        remote,
        releaseSchema() { schemaKnown = true; resolveSchema() },
        releaseKeyframe: resolveKeyframe,
        counts: () => ({active, subscriptions}),
    }
}

async function main() {
    console.log('\n[store-offline-generation-race] close before MAP cancels deferred start')
    {
        const deferred = createDeferredRemote('closed')
        const offline = await createOfflineStore<State>({
            key: 'close-race',
            storage: createMemoryOfflineStorage(),
            initial: {source: 'initial'},
            remote: deferred.remote,
            onError() {},
        })
        const pendingReady = offline.ready
        offline.close()
        await withTimeout(pendingReady)
        deferred.releaseSchema()
        await delay()

        ok(deferred.counts().subscriptions == 0, 'close-before-MAP creates no replay subscription')
        ok(deferred.counts().active == 0, 'closed Store keeps no delayed live line')
    }

    console.log('\n[store-offline-generation-race] newer reconnect owns the only live subscription')
    {
        const first = createDeferredRemote('first', true)
        const second = createDeferredRemote('second')
        const offline = await createOfflineStore<State>({
            key: 'reconnect-race',
            storage: createMemoryOfflineStorage(),
            initial: {source: 'initial'},
            onError() {},
        })
        const firstRun = offline.reconnect(first.remote)
        first.releaseSchema()
        for (let i = 0; i < 20 && first.counts().active == 0; i++) await delay()
        ok(first.counts().active == 1, 'first reconnect reached a live subscription before catch-up completed')

        const secondRun = offline.reconnect(second.remote)
        ok(first.counts().active == 0, 'superseding reconnect immediately closes the stale subscription')
        second.releaseSchema()
        await withTimeout(secondRun)
        await withTimeout(firstRun)
        first.releaseKeyframe()
        await delay()

        ok(first.counts().active == 0 && second.counts().active == 1, 'only the latest reconnect remains live')
        ok(offline.state.source == 'second', 'stale catch-up cannot overwrite the latest remote state')

        offline.close()
        ok(second.counts().active == 0, 'close tears down the latest generation')
    }

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
