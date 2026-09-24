import assert from 'node:assert/strict'
import {createAiRunHost, type AiRunRunner, type AiRunCheckpoint, type AiRunPersistencePort} from '../../src/Common/ai/ai-index'
import {createAiRunClient} from '../../src/Common/ai/ai-run-client'
import {setTimeout as delay} from 'node:timers/promises'
import {runOracle} from '../run-oracle'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function pending(ok) { resolve = ok })
    return {promise, resolve}
}

function storage() {
    let latest: AiRunCheckpoint | undefined
    const writes: AiRunCheckpoint[] = []
    const persistence: AiRunPersistencePort = {commit(value) {
        latest = structuredClone(value)
        writes.push(latest)
    }}
    return {persistence, writes, initial: () => latest && structuredClone(latest)}
}

async function until(check: () => boolean) {
    const end = Date.now() + 2000
    while (!check()) { assert(Date.now() < end, 'AI state did not settle'); await delay(1) }
}

async function main() {
    const unhandled: unknown[] = []
    function unexpected(error: unknown) { unhandled.push(error) }
    process.on('unhandledRejection', unexpected)
    try {
        let readOnlyCalls = 0
        const readOnly = createAiRunHost({policy: {canCreate: () => true, canWrite: () => false}, runner: {run() { readOnlyCalls++ }}})
        const readOnlyFragment = readOnly.connection('alice').fragment
        const readOnlyRun = readOnlyFragment.createRun({requestId: 'read-only-owner', kind: 'fixture', input: {}})
        assert.equal(readOnlyFragment.createRun({requestId: 'read-only-owner', kind: 'fixture', input: {changed: true}}).id, readOnlyRun.id,
            'legacy in-memory receipts retain their first-request-wins contract')
        assert.equal(readOnlyCalls, 1, 'approval/cancel permission must not change existing create permission')
        readOnly.close()
        const disk = storage()
        const effect = deferred<{result: string}>()
        let calls = 0
        const runner: AiRunRunner = {run({run}) {
            calls++
            assert.equal(disk.initial()!.store.runs[run.id].state, 'running', 'durable intent precedes provider effect')
            return effect.promise
        }}
        let host = createAiRunHost({runner, persistence: disk.persistence})
        const request = {requestId: 'same-intent', kind: 'fixture', input: {text: 'private input'}, resourceIds: ['owned-audio']}
        let session = host.connection('alice')
        const run = session.fragment.createRun(request)
        assert.equal(calls, 1)
        assert.equal(disk.writes[0].store.runs[run.id].state, 'queued')
        const beforeRunner = createAiRunHost({runner, initial: disk.writes[0]})
        assert.equal(beforeRunner.recovery.pending()[0].run.recovery?.from, 'queued')
        assert.equal(beforeRunner.connection('alice').fragment.createRun(request).id, run.id)
        assert.equal(calls, 1, 'even restored queued work requires explicit recovery')
        beforeRunner.close()
        const saved = session.fragment.createRun
        session.close()
        assert.throws(() => saved(request), /connection closed/)
        host.close()
        const checkpoint = disk.initial()!
        host = createAiRunHost({runner, persistence: disk.persistence, initial: checkpoint})
        session = host.connection('alice')
        assert.equal(session.fragment.createRun(request).id, run.id)
        assert.equal(calls, 1, 'restart does not repeat provider IO')
        assert.equal(host.store.state.runs[run.id].recovery?.from, 'running')
        assert.throws(() => session.fragment.createRun({...request, input: {text: 'changed'}}), /different input/)
        assert.throws(() => session.fragment.createRun({...request, resourceIds: ['other']}), /different input/)
        const stranger = createAiRunClient({remote: host.connection('bob').fragment})
        await stranger.ready
        assert.deepEqual(stranger.store.state.runs, {})
        await assert.rejects(stranger.cancelRun(run.id), /forbidden/)
        stranger.close()
        const owner = createAiRunClient({remote: session.fragment})
        await owner.ready
        assert(!JSON.stringify(owner.store.snapshot()).includes('private input'), 'private inputs are not a wire projection')
        owner.close()
        await assert.rejects(host.recovery.resume(run.id), /runner.recover is required/)
        effect.resolve({result: 'late old provider response'})
        await delay(0)
        assert.equal(host.store.state.runs[run.id].result, undefined)
        host.recovery.settle(run.id, {state: 'completed', output: {result: 'provider reconciled'}})
        session.close(); host.close()
        host = createAiRunHost({runner, persistence: disk.persistence, initial: disk.initial()})
        session = host.connection('alice')
        assert.equal(session.fragment.createRun(request).result, 'provider reconciled')
        assert.equal(calls, 1)
        const bob = host.connection('bob').fragment.createRun(request)
        assert.notEqual(bob.id, run.id, 'owner is part of the receipt key')
        await delay(0)
        session.close(); host.close()

        // Restore waiting approval/input metadata and private supplied values without replaying run().
        const waitingDisk = storage()
        let originalCalls = 0, recovered = 0, allowed = true
        const policy = {canRead: (account: string, value: {owner: string}) => allowed && account == value.owner,
            canWrite: (account: string, value: {owner: string}) => allowed && account == value.owner,
            canCreate: () => allowed}
        const waitingRunner: AiRunRunner = {
            async run({requestApproval, waitForInput, run}) {
                originalCalls++
                if (run.kind == 'approval') return {result: await requestApproval({kind: 'review', label: 'Confirm'})}
                return {result: await waitForInput({label: 'Answer'})}
            },
            async recover({checkpoint, requestApproval, waitForInput}) {
                recovered++
                if (checkpoint.approvals.length) {
                    const saved = checkpoint.approvals[0]
                    return {result: await requestApproval({id: saved.id, kind: saved.kind, label: saved.label})}
                }
                const saved = checkpoint.inputs[0]
                return {result: await waitForInput({id: saved.id, label: saved.label})}
            },
        }
        let waitingHost = createAiRunHost({runner: waitingRunner, persistence: waitingDisk.persistence, policy})
        let waitingSession = waitingHost.connection('alice')
        const approvalRun = waitingSession.fragment.createRun({requestId: 'approval', kind: 'approval', input: {}})
        const inputRun = waitingSession.fragment.createRun({requestId: 'input', kind: 'input', input: {}})
        assert.equal(originalCalls, 2)
        waitingSession.close(); waitingHost.close()
        waitingHost = createAiRunHost({runner: waitingRunner, persistence: waitingDisk.persistence, initial: waitingDisk.initial(), policy})
        waitingSession = waitingHost.connection('alice')
        const approval = Object.values(waitingHost.store.state.approvals)[0]
        const input = Object.values(waitingHost.store.state.inputs)[0]
        assert.equal(approval.state, 'pending')
        assert.equal(input.state, 'waiting')
        allowed = false
        await assert.rejects(waitingHost.recovery.resume(approvalRun.id), /forbidden/)
        assert.throws(() => waitingSession.fragment.resolveApproval(approval.id, 'approved'), /forbidden/)
        assert.equal(recovered, 0)
        allowed = true
        waitingSession.fragment.resolveApproval(approval.id, 'approved')
        assert.equal(waitingDisk.initial()!.store.approvals[approval.id].state, 'approved')
        const resumingInput = waitingHost.recovery.resume(inputRun.id)
        waitingSession.fragment.provideInput(input.id, {private: 'answer'})
        assert.deepEqual(waitingDisk.initial()!.inputValues[input.id], {private: 'answer'})
        assert.throws(() => waitingSession.fragment.provideInput(input.id, 'different'), /mismatch/)
        await resumingInput
        await waitingHost.recovery.resume(approvalRun.id)
        assert.equal(originalCalls, 2)
        assert.equal(recovered, 2)
        assert.equal(waitingHost.store.state.runs[approvalRun.id].result, 'approved')
        assert.deepEqual(waitingHost.store.state.runs[inputRun.id].result, {private: 'answer'})
        waitingSession.close(); waitingHost.close()

        // Failed or uncertain commits stop this host; reopening must reload the adapter's actual state.
        for (const failAt of [1, 2, 3]) {
            let writes = 0, effects = 0
            const failingDisk = storage()
            const originalError = new Error('disk write failed ' + failAt)
            const errors: unknown[] = []
            const failing = createAiRunHost({runner: {run() { effects++; return {result: 'done'} }}, persistence: {commit(value) {
                writes++
                if (writes == failAt) throw originalError
                failingDisk.persistence.commit(value)
            }}})
            failing.persistence.errors.on(error => errors.push(error))
            const fragment = failing.connection('alice').fragment
            if (failAt == 1) assert.throws(() => fragment.createRun(request), error => error == originalError)
            else fragment.createRun(request)
            await until(() => errors.length == 1)
            assert.equal(effects, failAt == 3 ? 1 : 0)
            assert.equal(failing.persistence.error(), originalError)
            assert.throws(() => fragment.createRun(request), /persistence failed/i)
            assert(!Object.values(failing.store.state.runs).some(run => run.state == 'completed'), 'uncommitted completion is rolled back')
            failing.close()
            const restored = createAiRunHost({initial: failingDisk.initial(), runner: {run() { effects++; return {} }}})
            assert.equal(effects, failAt == 3 ? 1 : 0)
            restored.close()
        }
        // A commit may have succeeded before reporting an error; a duplicate still recovers that receipt.
        const uncertainDisk = storage()
        let uncertainEffects = 0
        const uncertain = createAiRunHost({runner: {run() { uncertainEffects++ }}, persistence: {commit(value) {
            uncertainDisk.persistence.commit(value)
            throw new Error('ack lost')
        }}})
        assert.throws(() => uncertain.connection('alice').fragment.createRun(request), /ack lost/)
        uncertain.close()
        const reloaded = createAiRunHost({initial: uncertainDisk.initial(), runner: {run() { uncertainEffects++ }}})
        assert(reloaded.connection('alice').fragment.createRun(request).recovery)
        assert.equal(uncertainEffects, 0)
        reloaded.close()
        const cancellationDisk = storage()
        const lateRecovery = deferred<{result: string}>()
        const cancellableRunner: AiRunRunner = {run() { return new Promise(() => {}) }, recover() { return lateRecovery.promise }}
        let cancellable = createAiRunHost({runner: cancellableRunner, persistence: cancellationDisk.persistence})
        const cancelId = cancellable.connection('alice').fragment.createRun(request).id
        cancellable.close()
        cancellable = createAiRunHost({runner: cancellableRunner, persistence: cancellationDisk.persistence, initial: cancellationDisk.initial()})
        const resumed = cancellable.recovery.resume(cancelId)
        cancellable.connection('alice').fragment.cancelRun(cancelId, 'stop recovered work')
        lateRecovery.resolve({result: 'too late'})
        assert.equal((await resumed).state, 'cancelled')
        assert.equal(cancellationDisk.initial()!.store.runs[cancelId].result, undefined)
        cancellable.close()
        const cancelledRestore = createAiRunHost({runner: cancellableRunner, initial: cancellationDisk.initial()})
        assert.equal(cancelledRestore.connection('alice').fragment.createRun(request).state, 'cancelled')
        assert.deepEqual(cancelledRestore.recovery.pending(), [])
        cancelledRestore.close()

        for (const failAt of [3, 4]) {
            let writes = 0, continued = false
            const disk = storage()
            const failedWaiter = createAiRunHost({persistence: {commit(value) {
                if (++writes == failAt) throw new Error('waiter commit failed')
                disk.persistence.commit(value)
            }}, runner: {async run({requestApproval}) {
                await requestApproval({kind: 'review', label: 'Confirm'})
                continued = true
            }}})
            const fragment = failedWaiter.connection('alice').fragment
            fragment.createRun(request)
            if (failAt == 4) {
                const approval = Object.values(failedWaiter.store.state.approvals)[0]
                assert.throws(() => fragment.resolveApproval(approval.id, 'approved'), /waiter commit failed/)
            }
            await delay(0)
            assert.equal(continued, false, 'failed approval write cannot resume the provider')
            assert(failedWaiter.persistence.error())
            failedWaiter.close()
        }
        const invalid = structuredClone(checkpoint)
        delete invalid.requests[run.id]
        assert.throws(() => createAiRunHost({runner, initial: invalid}), /inconsistent/)
        await delay(0)
        assert.deepEqual(unhandled, [])
    } finally { process.off('unhandledRejection', unexpected) }
    console.log('PASS A1: write-before-effect, owner receipts, queued/running/waiting/completed restore, explicit recovery, rights, late IO and failed/uncertain writes')
}
runOracle(main)
