import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {createFileJobHost, FileJobReport} from '../src/Common/resource/file-job-host'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function capture(next) { resolve = next })
    return {promise, resolve}
}

test('late job reports cannot mutate a closed host', async function lateReport() {
    let report!: (next: FileJobReport) => void
    const finished = deferred<void>()
    const host = createFileJobHost({
        storage: {beginUpload() {}},
        runner: {run(input) { report = input.report; return finished.promise }},
    })
    const connection = host.connection('owner')
    const {file} = await connection.fragment.startUpload({name: 'a', size: 1})
    await connection.fragment.confirmUpload(file.id)
    connection.fragment.startJob(file.id, {})
    host.close()
    const snapshot = host.store.snapshot()
    report({progress: 0.9, message: 'late'})
    assert.deepEqual(host.store.snapshot(), snapshot)
    finished.resolve()
})

test('upload confirmation cannot mutate a closed host', async function lateConfirmation() {
    const confirmed = deferred<void>()
    const host = createFileJobHost({
        storage: {beginUpload() {}, confirmUpload() { return confirmed.promise }},
        runner: {run() {}},
    })
    const connection = host.connection('owner')
    const {file} = await connection.fragment.startUpload({name: 'a', size: 1})
    const pending = connection.fragment.confirmUpload(file.id)
    const outcome = pending.then(() => null, error => error)
    host.close()
    const snapshot = host.store.snapshot()
    confirmed.resolve()
    assert.match(String(await outcome), /closed/)
    assert.deepEqual(host.store.snapshot(), snapshot)
})

test('retained command facade cannot invoke resources after host close', async function closedCommands() {
    let uploads = 0
    let downloads = 0
    const host = createFileJobHost({
        storage: {beginUpload() { uploads++ }, download() { downloads++ }},
        runner: {run() {}},
    })
    const connection = host.connection('owner')
    const {file} = await connection.fragment.startUpload({name: 'a', size: 1})
    await connection.fragment.confirmUpload(file.id)
    const job = connection.fragment.startJob(file.id, {})
    host.close()
    await assert.rejects(connection.fragment.startUpload({name: 'b', size: 1}), /closed/)
    await assert.rejects(connection.fragment.download(file.id), /closed/)
    assert.throws(function startAfterClose() { connection.fragment.startJob(file.id, {}) }, /closed/)
    assert.throws(function cancelAfterClose() { connection.fragment.cancelJob(job.id) }, /closed/)
    assert.equal(uploads, 1)
    assert.equal(downloads, 0)
})

test('concurrent confirmations share one storage admission and preserve the accepted resource', async function concurrentConfirmation() {
    const accepted = deferred<void>()
    let refuseDuplicate = function noDuplicate(_error: Error) {}
    let calls = 0
    const host = createFileJobHost({
        storage: {
            beginUpload() {},
            confirmUpload() {
                calls++
                if (calls == 1) return accepted.promise
                return new Promise<void>(function unexpectedDuplicate(_resolve, reject) { refuseDuplicate = reject })
            },
        },
        runner: {run() {}},
    })
    const owner = host.connection('owner')
    const stranger = host.connection('stranger')
    try {
        const {file} = await owner.fragment.startUpload({name: 'a.pdf', size: 1})
        const first = owner.fragment.confirmUpload(file.id)
        const duplicate = owner.fragment.confirmUpload(file.id).then(value => value, error => error)
        await assert.rejects(stranger.fragment.confirmUpload(file.id), /forbidden/)
        accepted.resolve()
        assert.equal((await first).state, 'uploaded')
        refuseDuplicate(new Error('transient duplicate provider error'))
        const outcome = await duplicate
        assert.equal(host.store.state.files[file.id].state, 'uploaded', 'a duplicate confirmation cannot reverse an accepted upload')
        assert.equal(calls, 1)
        assert.equal(outcome.state, 'uploaded')
    } finally {
        owner.close()
        stranger.close()
        host.close()
    }
})


test('concurrent failed confirmations share the original rejection and one terminal state', async function failedConfirmation() {
    const failure = new Error('bytes not accepted')
    let calls = 0
    const host = createFileJobHost({
        storage: {beginUpload() {}, confirmUpload() { calls++; return Promise.reject(failure) }},
        runner: {run() {}},
    })
    const connection = host.connection('owner')
    try {
        const {file} = await connection.fragment.startUpload({name: 'a.pdf', size: 1})
        const outcomes = await Promise.allSettled([
            connection.fragment.confirmUpload(file.id),
            connection.fragment.confirmUpload(file.id),
        ])
        for (const outcome of outcomes) {
            assert.equal(outcome.status, 'rejected')
            if (outcome.status == 'rejected') assert.equal(outcome.reason, failure)
        }
        assert.equal(calls, 1)
        assert.equal(host.store.state.files[file.id].state, 'failed')
        assert.equal(host.store.state.files[file.id].error, failure.message)
        await assert.rejects(connection.fragment.confirmUpload(file.id), /expected uploading/)
        assert.equal(calls, 1, 'a settled failure is not another in-flight verification')
    } finally {
        connection.close()
        host.close()
    }
})
