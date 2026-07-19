import {listen} from '../src/Common/events/Listen'
import {createStore} from '../src/Common/Observe/store'
import {
    ContractDemand,
    ContractOffer,
    createContractOffers,
    createContractRuntime,
    resolveContractBinding,
} from '../src/Common/contract/contract-index'

type EditorApi = {
    implementation: string
    get: () => number
    add: (value: number) => number
}

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

const delay = (ms: number) => new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })

async function waitFor(label: string, condition: () => boolean | Promise<boolean>, attempts = 200) {
    for (let i = 0; i < attempts; i++) {
        if (await condition()) return
        await delay(10)
    }
    throw new Error('timeout: ' + label)
}

function demand(generation = 1, versionRange = '1.0.0'): ContractDemand {
    return {
        slotId: 'editor',
        contractId: 'documents.editor',
        versionRange,
        generation,
        authorityId: 'backend-a',
        authorityEpoch: 3,
        required: true,
    }
}

function descriptor(implementationId: string, contractVersion = '1.0.0') {
    return {
        protocol: 1 as const,
        contractId: 'documents.editor',
        contractVersion,
        implementationId,
        implementationVersion: implementationId + '-build-1',
        integrity: 'sha256:' + implementationId,
        capabilities: ['edit'],
    }
}

async function main() {
    console.log('\n[contract-runtime] deterministic resolution')
    const inert = function inertOpen() {
        return {api: {} as EditorApi, close() {}}
    }
    const low: ContractOffer<EditorApi> = {id: 'low', descriptor: descriptor('low'), priority: 1, open: inert}
    const high: ContractOffer<EditorApi> = {id: 'high', descriptor: descriptor('high'), priority: 4, open: inert}
    const incompatible: ContractOffer<EditorApi> = {
        id: 'future', descriptor: descriptor('future', '2.0.0'), priority: 100, open: inert,
    }
    const resolution = await resolveContractBinding({demand: demand(), offers: [low, incompatible, high]})
    ok(resolution.selected?.id == 'high', 'highest-priority compatible implementation wins')
    ok(resolution.candidates.find(item => item.offerId == 'future')?.reason?.includes('incompatible version'),
        'incompatible implementation is explained before open')
    const policyResolution = await resolveContractBinding({
        demand: demand(),
        offers: [low, high],
        policy: {
            acceptOffer(_demand, offer) {
                return offer.id == 'high' ? {accepted: false, reason: 'publisher is not trusted'} : {accepted: true}
            },
        },
    })
    ok(policyResolution.selected?.id == 'low' && policyResolution.candidates[1].reason == 'publisher is not trusted',
        'authority policy runs before a higher-priority offer can open')

    console.log('\n[contract-runtime] authority order')
    const authorityRuntime = createContractRuntime()
    const authorityA = await authorityRuntime.control.require({...demand(10), required: false, authorityEpoch: 1})
    const authorityZ = await authorityRuntime.control.require({
        ...demand(1), required: false, authorityId: 'backend-z', authorityEpoch: 1,
    })
    const losingAuthority = await authorityRuntime.control.require({...demand(99), required: false, authorityEpoch: 1})
    const newEpoch = await authorityRuntime.control.require({...demand(0), required: false, authorityEpoch: 2})
    ok(authorityA.accepted && authorityZ.accepted && !losingAuthority.accepted && newEpoch.accepted,
        'epoch then authority id then generation gives deterministic demand authority')
    authorityRuntime.close()

    console.log('\n[contract-runtime] atomic update, leases and shared Store continuity')
    const shared = createStore({value: 1})
    const opened: Record<string, number> = {}
    const closed: Record<string, number> = {}
    const sessions: Record<string, Array<{fail: (reason?: unknown) => void}>> = {}

    function implementation(id: string, priority: number, opts: {failOpen?: boolean} = {}): ContractOffer<EditorApi> {
        return {
            id,
            priority,
            descriptor: descriptor(id),
            async open() {
                opened[id] = (opened[id] ?? 0) + 1
                if (opts.failOpen) throw new Error(id + ' could not prepare')
                const [emitFail, onFail] = listen<[unknown?]>()
                sessions[id] = sessions[id] ?? []
                sessions[id].push({fail: emitFail})
                return {
                    api: {
                        implementation: id,
                        get: () => shared.state.value,
                        add(value: number) {
                            shared.state.value += value
                            return shared.state.value
                        },
                    },
                    onFail,
                    close() { closed[id] = (closed[id] ?? 0) + 1 },
                }
            },
        }
    }

    const offerA = implementation('editor-a', 1)
    const offerB = implementation('editor-b', 5)
    const offers = createContractOffers([offerA])
    const runtime = createContractRuntime({offers: offers.api, retryMs: 200, drainTimeoutMs: 1000})
    const first = await runtime.control.require(demand())
    ok(first.accepted && runtime.api.binding('editor')?.offerId == 'editor-a', 'first demand activates a compatible offer')

    const leaseA = runtime.api.acquire<EditorApi>('editor')
    ok(leaseA.api.add(2) == 3, 'the active implementation writes through the stable external Store')
    offers.control.upsert(offerB)
    await waitFor('higher priority B active', () => runtime.api.binding('editor')?.offerId == 'editor-b')
    ok(shared.state.value == 3 && runtime.api.acquire<EditorApi>('editor').api.get() == 3,
        'replacement sees the same Store state without rehydration')
    ok(!closed['editor-a'], 'retired implementation remains alive while an acquired lease is in flight')
    leaseA.release()
    await waitFor('leased A closes', () => closed['editor-a'] == 1)
    ok(closed['editor-a'] == 1, 'retired implementation closes after its lease drains')

    const replay = await runtime.control.require(demand())
    ok(replay.accepted && replay.replay && opened['editor-b'] == 1, 'replayed demand does not duplicate activation')
    const stale = await runtime.control.require(demand(0))
    ok(!stale.accepted && stale.reason == 'stale demand', 'older demand generation is rejected')
    const conflict = await runtime.control.require({...demand(), required: false})
    ok(!conflict.accepted && conflict.reason == 'conflicting demand coordinate', 'same coordinate cannot carry different intent')

    console.log('\n[contract-runtime] failed candidate, revoke, rollback and session failover')
    const broken = implementation('broken-candidate', 20, {failOpen: true})
    offers.control.upsert(broken)
    await waitFor('broken candidate attempted', () => opened['broken-candidate'] == 1)
    ok(runtime.api.binding('editor')?.offerId == 'editor-b', 'failed compatible candidate leaves the current binding active')
    ok(runtime.api.explain('editor').candidates.some(item => item.offerId == 'broken-candidate' && !item.accepted),
        'failed candidate remains visible in explain output')

    await runtime.control.revokeOffer('editor-b', 'operator quarantine')
    await waitFor('fallback A active', () => runtime.api.binding('editor')?.offerId == 'editor-a')
    ok(runtime.api.explain('editor').candidates.some(item => item.offerId == 'editor-b' && item.reason?.includes('revoked')),
        'revoked preferred offer is explained and fallback activates')
    await runtime.control.restoreOffer('editor-b')
    await waitFor('B restored', () => runtime.api.binding('editor')?.offerId == 'editor-b')

    const beforeRollback = runtime.api.binding('editor')!.bindingGeneration
    const rolledBack = await runtime.control.rollback('editor')
    ok(rolledBack.offerId == 'editor-a' && rolledBack.bindingGeneration > beforeRollback,
        'rollback reopens the previous offer as a new binding generation')

    sessions['editor-a'].at(-1)!.fail(new Error('editor-a transport lost'))
    await waitFor('session failure falls back to B', () => runtime.api.binding('editor')?.offerId == 'editor-b')
    ok(runtime.api.history().some(event => event.reason == 'session failed'), 'active session failure is preserved in binding history')

    console.log('\n[contract-runtime] new contract generation and optional degradation')
    const newDemand = await runtime.control.require(demand(2, '2.0.0'))
    ok(newDemand.accepted && runtime.api.binding('editor') == null, 'incompatible new demand never keeps an old binding active')
    ok(runtime.api.status.state.slots.editor.state == 'failed', 'required unresolved contract reports failed')
    const optional = await runtime.control.require({...demand(3, '3.0.0'), required: false})
    ok(optional.accepted && runtime.api.status.state.slots.editor.state == 'degraded', 'optional unresolved contract reports degraded')

    const events = runtime.api.history()
    ok(events.some(event => event.reason == 'demand update') && events.some(event => event.reason == 'rollback'),
        'history records update and rollback decisions')
    await runtime.control.release('editor')
    ok(runtime.api.status.state.slots.editor.state == 'idle', 'release returns the slot to idle')

    runtime.close()
    ok(runtime.api.status.state.closed, 'runtime closes with an observable terminal status')
    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
