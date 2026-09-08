import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {listen} from '../src/Common/events/Listen'
import {
    ContractDemand,
    ContractOffer,
    ContractPolicy,
    createContractRuntime,
} from '../src/Common/contract/contract-index'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

const demand: ContractDemand = {
    slotId: 'editor', contractId: 'editor', versionRange: '1.0.0',
    generation: 1, authorityId: 'host', authorityEpoch: 1,
}

function offer(open: ContractOffer['open']): ContractOffer {
    return {
        id: 'editor',
        descriptor: {
            protocol: 1, contractId: 'editor', contractVersion: '1.0.0',
            implementationId: 'editor', implementationVersion: '1.0.0',
        },
        open,
    }
}

for (const boundary of ['acceptDemand', 'acceptOffer', 'acceptSession', 'open'] as const) {
    test('close remains terminal during ' + boundary, async function closeDuringPreparation() {
        const entered = deferred<void>()
        const resume = deferred<void>()
        const [, failures] = listen<[unknown]>()
        let opened = 0
        let closed = 0
        async function pause() {
            entered.resolve()
            await resume.promise
            return {accepted: true}
        }
        const policy: ContractPolicy = boundary == 'open' ? {} : {[boundary]: pause}
        const runtime = createContractRuntime({policy})
        await runtime.control.addOffer(offer(async function open() {
            opened++
            if (boundary == 'open') await pause()
            return {api: {}, onFail: failures, close() { closed++ }}
        }))
        const pending = runtime.control.require(demand)
        const outcome = pending.then(() => null, error => error)
        await entered.promise
        runtime.close()
        assert.equal(failures.count(), 0, 'shutdown detaches candidate failure listeners immediately')
        if (boundary == 'acceptSession') assert.equal(closed, 1, 'shutdown owns the waiting candidate')
        resume.resolve()
        assert.match(String(await outcome), /contract runtime closed/)
        assert.equal(runtime.api.binding('editor'), null)
        assert.equal(closed, opened, 'every opened candidate must close exactly once')
        assert.equal(runtime.api.status.state.closed, true)
        for (const slot of Object.values(runtime.api.status.state.slots)) assert.equal(slot.state, 'closed')
        assert.equal(runtime.api.history().length, 0, 'no activation after shutdown')
        await assert.rejects(runtime.control.release('editor'), /contract runtime closed/)
        failures.close()
    })
}

test('retirement bounds a pending drain and closes once after late completion', async function boundedDrain() {
    const drained = deferred<void>()
    const started = deferred<void>()
    const closed = deferred<void>()
    let closes = 0
    const runtime = createContractRuntime({drainTimeoutMs: 20})
    try {
        await runtime.control.addOffer(offer(function open() {
            return {
                api: {},
                drain() { started.resolve(); return drained.promise },
                close() { closes++; closed.resolve() },
            }
        }))
        await runtime.control.require(demand)
        await runtime.control.release('editor')
        await started.promise
        await Promise.race([closed.promise, delay(200).then(function deadline() {
            assert.fail('hung drain prevented resource close')
        })])
        drained.resolve()
        await delay(0)
        assert.equal(closes, 1)
    } finally {
        drained.resolve()
        runtime.close()
    }
})

test('shutdown closes retired leased sessions without waiting for their deadline', async function closeRetiredLease() {
    let closes = 0
    let drains = 0
    const runtime = createContractRuntime({drainTimeoutMs: 60_000})
    await runtime.control.addOffer(offer(function open() {
        return {api: {}, drain() { drains++ }, close() { closes++ }}
    }))
    await runtime.control.require(demand)
    const lease = runtime.api.acquire('editor')
    await runtime.control.release('editor')
    assert.equal(closes, 0)
    runtime.close()
    await delay(0)
    assert.equal(closes, 1)
    assert.equal(drains, 1)
    lease.release()
    await delay(0)
    assert.equal(closes, 1)
})

test('expired leases invoke drain but cannot hold resource close', async function expiredLease() {
    const closed = deferred<void>()
    let drains = 0
    const runtime = createContractRuntime({drainTimeoutMs: 10})
    try {
        await runtime.control.addOffer(offer(function open() {
            return {
                api: {},
                drain() { drains++; return new Promise<void>(function neverFinish() {}) },
                close() { closed.resolve() },
            }
        }))
        await runtime.control.require(demand)
        const lease = runtime.api.acquire('editor')
        await runtime.control.release('editor')
        await Promise.race([closed.promise, delay(200).then(function deadline() {
            assert.fail('expired lease prevented resource close')
        })])
        assert.equal(drains, 1)
        lease.release()
        assert.equal(drains, 1)
    } finally {
        runtime.close()
    }
})

test('normal draining waits for leases and then for the resource', async function gracefulDrain() {
    const drained = deferred<void>()
    const started = deferred<void>()
    const closed = deferred<void>()
    let drains = 0
    const runtime = createContractRuntime({drainTimeoutMs: 1000})
    try {
        await runtime.control.addOffer(offer(function open() {
            return {
                api: {},
                drain() { drains++; started.resolve(); return drained.promise },
                close() { closed.resolve() },
            }
        }))
        await runtime.control.require(demand)
        const lease = runtime.api.acquire('editor')
        await runtime.control.release('editor')
        assert.equal(drains, 0)
        lease.release()
        await started.promise
        drained.resolve()
        await closed.promise
        assert.equal(drains, 1)
    } finally {
        drained.resolve()
        runtime.close()
    }
})

test('activation observers can close both generations while an old lease is held', async function closeFromBindingFact() {
    const closed: number[] = []
    const runtime = createContractRuntime({drainTimeoutMs: 60_000})
    await runtime.control.addOffer(offer(function openFirst() {
        return {api: {}, close() { closed.push(1) }}
    }))
    await runtime.control.require(demand)
    const lease = runtime.api.acquire('editor')
    runtime.api.changed.on(function closeOnReplacement() { runtime.close() })
    await assert.rejects(runtime.control.addOffer(offer(function openSecond() {
        return {api: {}, close() { closed.push(2) }}
    })), /contract runtime closed/)
    assert.deepEqual(closed.sort(), [1, 2])
    assert.equal(runtime.api.binding('editor'), null)
    assert.equal(runtime.api.status.state.slots.editor.state, 'closed')
    lease.release()
    await delay(0)
    assert.equal(closed.length, 2)
})

test('removal observers cannot overwrite terminal slot status', async function closeFromRemovalFact() {
    const runtime = createContractRuntime()
    await runtime.control.addOffer(offer(function open() { return {api: {}, close() {}} }))
    await runtime.control.require(demand)
    runtime.api.changed.on(function closeOnRemoval() { runtime.close() })
    await assert.rejects(runtime.control.removeOffer('editor'), /contract runtime closed/)
    assert.equal(runtime.api.status.state.closed, true)
    assert.equal(runtime.api.status.state.slots.editor.state, 'closed')
    assert.equal(runtime.api.binding('editor'), null)
})

test('candidate failure during readiness keeps the serving binding', async function failedCandidateDuringReadiness() {
    const entered = deferred<void>()
    const resume = deferred<void>()
    const [fail, failures] = listen<[unknown]>()
    let closes = 0
    const runtime = createContractRuntime({
        retryMs: 60_000,
        policy: {async acceptSession(_demand, candidate) {
            if (candidate.id == 'candidate') { entered.resolve(); await resume.promise }
            return {accepted: true}
        }},
    })
    try {
        await runtime.control.addOffer(offer(function openServing() { return {api: {version: 1}, close() {}} }))
        await runtime.control.require(demand)
        const previous = runtime.api.binding('editor')!
        const candidate = {
            ...offer(function openCandidate() {
                return {api: {version: 2}, onFail: failures, close() { closes++ }}
            }),
            id: 'candidate', priority: 1,
        }
        const replacing = runtime.control.addOffer(candidate)
        await entered.promise
        fail(new Error('candidate process exited during readiness'))
        resume.resolve()
        await replacing
        assert.equal(runtime.api.binding('editor')?.offerId, previous.offerId)
        assert.equal(runtime.api.binding('editor')?.bindingGeneration, previous.bindingGeneration)
        assert.equal(closes, 1)
        assert.equal(failures.count(), 0)
        assert.equal(runtime.api.history().length, 1, 'failed candidate is never announced as serving')
    } finally {
        resume.resolve()
        runtime.close()
        failures.close()
    }
})
