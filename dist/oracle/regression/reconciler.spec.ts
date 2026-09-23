import assert from 'node:assert/strict'
import {setTimeout as pause} from 'node:timers/promises'
import {createReconciler, createResourceScope, listen} from '../../src'

function gate() {
    let resolve!: () => void
    const promise = new Promise<void>(function create(resolvePromise) { resolve = resolvePromise })
    return {promise, resolve}
}

async function main() {
    const [emit, changes] = listen<[]>()
    let state = 0
    const snapshots: number[] = []
    const started = gate()
    const io = gate()
    let active = 0
    const worker = createReconciler({
        read: () => state,
        subscribe: changes.on,
        async run(snapshot) {
            assert.equal(++active, 1)
            snapshots.push(snapshot)
            if (snapshots.length == 1) { started.resolve(); await io.promise }
            if (snapshot == 20) { state = 21; emit() }
            active--
        },
    })
    for (let i = 0; i < 10; i++) { state++; emit() }
    await started.promise
    assert.deepEqual(snapshots, [10])
    for (let i = 0; i < 10; i++) { state++; emit() }
    io.resolve()
    await worker.control.idle()
    assert.deepEqual(snapshots, [10, 20, 21])
    state = 22
    emit()
    await worker.control.idle()
    assert.deepEqual(snapshots, [10, 20, 21, 22])
    assert.equal(worker.close(), worker.close())
    await worker.close()
    assert.equal(changes.count(), 0)
    emit()
    worker.control.request()
    await worker.control.idle()
    assert.equal(snapshots.length, 4)

    const error = new Error('temporary')
    let attempts = 0
    let shouldFail = true
    const failures: unknown[] = []
    const retrying = createReconciler({read: () => 1, async run() {
        attempts++
        if (shouldFail) { retrying.control.request(); throw error }
    }})
    retrying.events.errors(function failed(cause) { failures.push(cause); retrying.control.retry('global', 35) })
    retrying.control.request()
    await retrying.control.idle()
    assert.equal(attempts, 1, 'failure drops notifications from that failed pass')
    assert.equal(retrying.view.error(), error)
    shouldFail = false
    retrying.control.request()
    await retrying.control.idle()
    await pause(70)
    assert.equal(attempts, 2, 'successful fresh pass removes obsolete retry')
    assert.deepEqual(failures, [error])
    retrying.control.retry('cancelled', 10)
    retrying.control.cancelRetry('cancelled')
    retrying.control.retry('close', 10)
    await retrying.close()
    await pause(25)
    assert.equal(attempts, 2)

    const retried = gate()
    let keyedPasses = 0
    const keyed = createReconciler({read: () => 0, run(_snapshot, {retry}) {
        keyedPasses++
        if (keyedPasses == 1) {
            retry('operation-a', 15)
            retry('operation-a', 1)
            retry('route-b', 100)
            keyed.control.request()
        } else retried.resolve()
    }})
    keyed.control.request()
    await keyed.control.idle()
    assert.equal(keyedPasses, 1)
    await retried.promise
    await keyed.control.idle()
    await pause(130)
    assert.equal(keyedPasses, 2, 'keys are timers, not independent execution queues')
    assert.throws(() => keyed.control.retry('bad', 0), RangeError)
    await keyed.close()

    const waiting = gate()
    const finish = gate()
    const cancellation = createReconciler({closeTimeoutMs: 5, read: () => 0, async run(_snapshot, {signal}) {
        waiting.resolve()
        await finish.promise
        assert.equal(signal.aborted, true)
    }})
    cancellation.control.request()
    await waiting.promise
    await assert.rejects(cancellation.close(), {name: 'ResourceCloseTimeoutError'})
    finish.resolve()
    await cancellation.settled()

    let followup = 0
    const errorWake = createReconciler({read: () => 0, run() { if (++followup == 1) throw error }})
    errorWake.events.errors(function requestAfterError() { errorWake.control.request() })
    errorWake.control.request()
    await errorWake.control.idle()
    assert.equal(followup, 2, 'notification from the error callback is not lost at completion')
    await errorWake.close()

    const owner = createResourceScope()
    const connected = gate()
    const disconnected = gate()
    const order: string[] = []
    owner.resource.own(function unlock() { order.push('lock') })
    const disconnect = owner.resource.own(function disconnect() { order.push('network'); disconnected.resolve() })
    const dependent = createReconciler({signal: owner.signal, read: () => 0, async run() {
        connected.resolve()
        await disconnected.promise
        order.push('pass')
    }})
    owner.resource.parallel([dependent.close, disconnect])
    dependent.control.request()
    await connected.promise
    await owner.close()
    assert.deepEqual(order, ['network', 'pass', 'lock'], 'parallel IO stop unblocks the pass before releasing its lock')
    console.log('PASS reconciler: burst coalescing, fresh snapshots, no overlap, retry policy, stop and completion races')
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
