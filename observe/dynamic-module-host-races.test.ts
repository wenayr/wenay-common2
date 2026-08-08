import {strict as assert} from 'node:assert'
import {sha256Hex} from '../src/Common/artifact/artifact-hash'
import {listen} from '../src/Common/events/Listen'
import {createModuleArtifactVerifier} from '../src/Common/dynamic/module-verifier'
import {
    createDynamicModuleHost,
    DynamicModuleHostError,
} from '../src/server/dynamic/module-host'
import {
    tModuleIsolationEvent,
    ModuleIsolationPort,
    ModuleIsolationSession,
} from '../src/server/dynamic/module-isolation'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

async function artifact(version: string) {
    const bytes = new TextEncoder().encode('function createModule() { return {} } //' + version)
    const digest = await sha256Hex(bytes)
    const base = {
        manifestProtocol: 1,
        moduleId: 'race.impl',
        version,
        contentHash: 'sha256:' + digest,
        entrypoint: './index.js',
        compatibility: {
            api: {contractId: 'race.port', version: '1.0.0'},
            runtime: {name: 'node', range: '>=18'},
        },
        dependencies: [],
        capabilities: [],
        permissions: {},
        integrity: {algorithm: 'sha256', digest, size: bytes.byteLength},
        health: {
            checkHook: 'health.check',
            timeoutMs: 100,
            failureThreshold: 1,
        },
        budget: {
            callTimeoutMs: 100,
            warmupTimeoutMs: 100,
            memoryMb: 32,
            concurrency: 2,
        },
        signature: {
            algorithm: 'race-test',
            keyId: 'race-publisher',
            value: 'race-test-signature',
            signedFields: [] as string[],
        },
    }
    return {
        manifest: JSON.stringify({
            ...base,
            signature: {
                ...base.signature,
                signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
            },
        }),
        bytes,
    }
}

function verifier() {
    return createModuleArtifactVerifier({
        verifySignature: () => true,
        policy: {
            publisherKeyIds: ['race-publisher'],
            capabilities: [],
        },
    })
}

async function waitFor(label: string, check: () => boolean) {
    const deadline = Date.now() + 500
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

function nextUncaught(label: string) {
    return new Promise<unknown>(function waitForUncaught(resolve, reject) {
        const timeout = setTimeout(function uncaughtTimedOut() {
            process.removeListener('uncaughtException', captureUncaught)
            reject(new Error('timeout waiting for uncaught exception: ' + label))
        }, 1000)
        function captureUncaught(error: unknown) {
            clearTimeout(timeout)
            resolve(error)
        }
        process.once('uncaughtException', captureUncaught)
    })
}

async function closeDuringVerification() {
    const verified = verifier()
    const verificationStarted = deferred<void>()
    const verificationRelease = deferred<void>()
    let opens = 0
    const host = createDynamicModuleHost({
        verifier: {
            control: {
                async verify(input) {
                    verificationStarted.resolve()
                    await verificationRelease.promise
                    return await verified.control.verify(input)
                },
            },
        },
        isolation: {
            resource: {
                open() {
                    opens++
                    throw new Error('isolation must not open after close')
                },
            },
        },
    })
    const candidate = await artifact('1.0.0')
    const stage = host.control.stage({
        candidateId: 'close-during-verify',
        slotId: 'race.primary',
        ...candidate,
    })
    await verificationStarted.promise
    const close = host.close()
    verificationRelease.resolve()
    await assert.rejects(stage, function closed(error) {
        return error instanceof DynamicModuleHostError && error.code == 'E_HOST_CLOSED'
    })
    await close
    assert.equal(opens, 0, 'closing during verification prevents later isolation creation')
    assert.equal(host.view.candidate('close-during-verify')?.state, 'closed')
}

async function leaseDrainAndDiscard() {
    const hold = deferred<unknown>()
    const terminations = new Map<string, number>()

    function session(version: string): ModuleIsolationSession {
        const [emitEvent, events] = listen<[tModuleIsolationEvent]>()
        let state = 'idle'
        let terminated = false

        async function terminate() {
            if (terminated) return
            terminated = true
            state = 'closed'
            terminations.set(version, (terminations.get(version) ?? 0) + 1)
            emitEvent({type: 'state', state: 'closed', at: Date.now()})
            events.close()
        }

        return {
            control: {
                async start() {
                    state = 'ready'
                    emitEvent({type: 'state', state: 'ready', at: Date.now()})
                },
                terminate,
            },
            resource: {
                call<T>(method: string): Promise<T> {
                    if (method == 'health.check') return Promise.resolve({ok: true} as T)
                    if (method == 'sync-throw') throw new Error('synchronous isolation failure')
                    if (method == 'hold' && version == '1.0.0') return hold.promise as Promise<T>
                    return Promise.resolve({ok: true, version} as T)
                },
            },
            events: {
                on: events.on,
            },
            view: {
                snapshot: () => ({state, methods: [], failure: null}),
            },
            health: {
                snapshot: () => ({
                    health: state == 'ready' ? 'healthy' : 'closed',
                    inFlight: 0,
                }),
            },
        }
    }

    const isolation = {
        resource: {
            open(input) {
                return session(input.artifact.manifest.version)
            },
        },
    } satisfies ModuleIsolationPort
    const host = createDynamicModuleHost({
        verifier: verifier(),
        isolation,
        drainTimeoutMs: 5_000,
    })
    await host.control.require({
        slotId: 'race.primary',
        contractId: 'race.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'race-test',
        authorityEpoch: 1,
        required: true,
    })
    const v1 = await artifact('1.0.0')
    const stagedV1 = await host.control.stage({
        candidateId: 'race-v1',
        slotId: 'race.primary',
        priority: 1,
        ...v1,
    })
    await host.control.activate(stagedV1.candidateId)
    const handle = host.resource.handle('race.primary')

    await assert.rejects(
        handle.call('sync-throw', null, {correlationId: 'sync-throw'}),
        /synchronous isolation failure/,
    )
    const oldCall = handle.call('hold', null, {correlationId: 'old-hold'})

    const v2 = await artifact('2.0.0')
    const stagedV2 = await host.control.stage({
        candidateId: 'race-v2',
        slotId: 'race.primary',
        priority: 2,
        ...v2,
    })
    await host.control.activate(stagedV2.candidateId)
    await host.control.discard(stagedV1.candidateId)
    assert.equal(
        terminations.get('1.0.0') ?? 0,
        0,
        'discard cannot terminate a claimed retired session with an active lease',
    )

    hold.resolve({ok: true, version: '1.0.0'})
    assert.deepEqual(await oldCall, {ok: true, version: '1.0.0'})
    await waitFor('v1 lease drain', () => terminations.get('1.0.0') == 1)
    assert.equal(
        terminations.get('1.0.0'),
        1,
        'synchronous throw released its lease and the final real lease drains exactly once',
    )
    await host.close()
    assert.equal(terminations.get('2.0.0'), 1)
}

async function failureDuringOfferHandoff() {
    let terminations = 0
    const isolation = {
        resource: {
            open(): ModuleIsolationSession {
                const [emitEvent, events] = listen<[tModuleIsolationEvent]>()
                let state = 'idle'
                let failure: {code: string, message: string} | null = null
                let terminated = false
                return {
                    control: {
                        async start() { state = 'ready' },
                        async terminate() {
                            if (terminated) return
                            terminated = true
                            terminations++
                            state = 'closed'
                            emitEvent({type: 'state', state: 'closed', at: Date.now()})
                            events.close()
                        },
                    },
                    resource: {
                        call<T>(_method: string, input: unknown): Promise<T> {
                            if ((input as {phase?: unknown})?.phase == 'activation') {
                                state = 'failed'
                                failure = {code: 'E_HANDOFF_FAILURE', message: 'failed before runtime subscription'}
                                emitEvent({
                                    type: 'state',
                                    state: 'failed',
                                    reason: failure.message,
                                    at: Date.now(),
                                })
                            }
                            return Promise.resolve({ok: true} as T)
                        },
                    },
                    events: {on: events.on},
                    view: {
                        snapshot: () => ({state, methods: [], failure}),
                    },
                    health: {
                        snapshot: () => ({
                            health: state == 'ready' ? 'healthy' : 'unhealthy',
                            inFlight: 0,
                        }),
                    },
                }
            },
        },
    } satisfies ModuleIsolationPort
    const host = createDynamicModuleHost({
        verifier: verifier(),
        isolation,
        drainTimeoutMs: 0,
    })
    await host.control.require({
        slotId: 'race.primary',
        contractId: 'race.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'race-test',
        authorityEpoch: 1,
        required: true,
    })
    const candidate = await artifact('1.0.0')
    const staged = await host.control.stage({
        candidateId: 'handoff-failure',
        slotId: 'race.primary',
        ...candidate,
    })
    try {
        await host.control.activate(staged.candidateId)
    } catch {}
    await waitFor('handoff failure removal', () => host.view.binding('race.primary') == null)
    assert.notEqual(
        host.view.candidate(staged.candidateId)?.state,
        'active',
        'a failure before ContractRuntime subscribes cannot leave a dead active binding',
    )
    await host.close()
    assert.equal(terminations, 1)
}

async function outwardObserverFailureIsolation() {
    function session(): ModuleIsolationSession {
        const [, events] = listen<[tModuleIsolationEvent]>()
        let state: 'idle' | 'ready' | 'closed' = 'idle'
        return {
            control: {
                async start() { state = 'ready' },
                async terminate() {
                    state = 'closed'
                    events.close()
                },
            },
            resource: {
                call<T>() { return Promise.resolve({ok: true} as T) },
            },
            events: {on: events.on},
            view: {
                snapshot: () => ({state, methods: [], failure: null}),
            },
            health: {
                snapshot: () => ({
                    health: state == 'ready' ? 'healthy' as const : 'closed' as const,
                    inFlight: 0,
                }),
            },
        }
    }

    const host = createDynamicModuleHost({
        verifier: verifier(),
        isolation: {resource: {open: session}},
        drainTimeoutMs: 0,
    })
    await host.control.require({
        slotId: 'race.observer',
        contractId: 'race.port',
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'race-test',
        authorityEpoch: 1,
        required: true,
    })

    let throwCandidateFact = true
    const facts: string[] = []
    host.events.on(function failFirstCandidateObserver(event) {
        if (event.type != 'candidate' || !throwCandidateFact) return
        throwCandidateFact = false
        throw new Error('candidate observer failed')
    })
    host.events.on(function collectHostFacts(event) {
        facts.push(event.type)
    })

    const candidateObserverError = nextUncaught('candidate observer')
    const input = await artifact('3.0.0')
    const staged = await host.control.stage({
        candidateId: 'observer-v3',
        slotId: 'race.observer',
        ...input,
    })
    const candidateError = await candidateObserverError
    assert.equal((candidateError as Error).message, 'candidate observer failed')
    assert.equal(staged.state, 'ready', 'candidate observer cannot stop verification and staging')
    assert.equal(host.view.candidate(staged.candidateId)?.state, 'ready')
    assert.ok(facts.filter(type => type == 'candidate').length >= 2, 'sibling sees candidate lifecycle facts')

    let throwBindingFact = true
    host.events.on(function failFirstBindingObserver(event) {
        if (event.type != 'binding' || !throwBindingFact) return
        throwBindingFact = false
        throw new Error('host binding observer failed')
    })
    const bindingObserverError = nextUncaught('host binding observer')
    const binding = await host.control.activate(staged.candidateId)
    const bindingError = await bindingObserverError
    assert.equal((bindingError as Error).message, 'host binding observer failed')
    assert.equal(binding.offerId, staged.offerId, 'binding observer cannot reject committed activation')
    assert.equal(host.view.binding('race.observer')?.offerId, staged.offerId)
    assert.equal(host.view.candidate(staged.candidateId)?.state, 'active')
    assert.ok(facts.includes('binding'), 'sibling sees the committed binding fact')
    await host.close()
}

async function main() {
    await closeDuringVerification()
    await leaseDrainAndDiscard()
    await failureDuringOfferHandoff()
    await outwardObserverFailureIsolation()
    console.log('dynamic module host races: all passed')
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exit(1)
})
