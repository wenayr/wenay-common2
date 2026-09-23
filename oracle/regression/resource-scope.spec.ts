import assert from 'node:assert/strict'
import {createResourceScope, ResourceCloseTimeoutError} from '../../src'

function gate<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function create(resolvePromise) { resolve = resolvePromise })
    return {promise, resolve}
}

async function main() {
    const scope = createResourceScope()
    const steps: string[] = []
    const independent = gate<void>()
    scope.resource.own(function first() { steps.push('first') })
    scope.resource.parallel([
        async function left() { steps.push('left'); await independent.promise; steps.push('left-done') },
        function right() { steps.push('right'); independent.resolve() },
    ])
    scope.resource.own(function last() { steps.push('last') })
    let reentrant: Promise<void> | undefined
    scope.signal.addEventListener('abort', function reenter() { reentrant = scope.close() })
    const closing = scope.close()
    assert.equal(closing, scope.close())
    assert.equal(closing, reentrant)
    await closing
    await scope.settled()
    assert.deepEqual(steps, ['last', 'left', 'right', 'left-done', 'first'])

    const startup = new Error('startup cause')
    const cleanup = new Error('cleanup cause')
    const partial = createResourceScope()
    const errors: unknown[] = []
    partial.events.errors(function observed(error) { errors.push(error) })
    await assert.rejects(partial.start(async function start() {
        partial.resource.own(function releaseLock() { steps.push('lock') })
        partial.resource.own(function fails() { throw cleanup })
        throw startup
    }), error => error == startup)
    assert.equal(steps.at(-1), 'lock')
    assert.deepEqual(errors, [cleanup])
    await assert.rejects(partial.close(), function aggregated(error) {
        return error instanceof AggregateError && error.errors[0] == cleanup
    })

    const cancelled = new AbortController()
    const late = createResourceScope({signal: cancelled.signal, closeTimeoutMs: 5})
    const opened = gate<{id: number}>()
    const admitted = gate<void>()
    const released: number[] = []
    const acquisition = late.resource.acquire({
        async open(signal) { assert.equal(signal.aborted, false); admitted.resolve(); return opened.promise },
        close(value) { released.push(value.id) },
    })
    const rejection = assert.rejects(acquisition, function abort(error) { return (error as Error).name == 'AbortError' })
    await admitted.promise
    cancelled.abort()
    const deadline = late.close()
    assert.equal(deadline, late.close())
    await assert.rejects(deadline, ResourceCloseTimeoutError)
    let complete = false
    late.settled().then(function finished() { complete = true })
    assert.equal(complete, false)
    opened.resolve({id: 7})
    await rejection
    await late.settled()
    assert.deepEqual(released, [7])
    assert.equal(complete, true)
    await assert.rejects(late.close(), ResourceCloseTimeoutError)
    const disposeLateOwn = late.resource.own(function lateOwn() { released.push(8) })
    assert.equal(disposeLateOwn(), disposeLateOwn())
    await disposeLateOwn()
    assert.deepEqual(released, [7, 8])

    const failedOpen = createResourceScope()
    let disposals = 0
    await assert.rejects(failedOpen.start(async function start() {
        await failedOpen.resource.acquire({open() { throw startup }, close() { disposals++ }})
    }), error => error == startup)
    assert.equal(disposals, 0)
    await failedOpen.close()

    const cancelledBefore = createResourceScope({signal: AbortSignal.abort()})
    await assert.rejects(cancelledBefore.resource.acquire({open() { throw new Error('must not open') }, close() {}}),
        function abort(error) { return (error as Error).name == 'AbortError' })

    const groups = createResourceScope()
    groups.resource.own(function oldest() { disposals++ })
    groups.resource.parallel([function one() { throw startup }, async function two() { throw cleanup }])
    groups.events.errors(function badObserver() { throw new Error('observer') })
    await assert.rejects(groups.close(), function aggregated(error) {
        return error instanceof AggregateError && error.errors.length == 2
            && error.errors[0] instanceof AggregateError && error.errors[0].errors.length == 2
    })
    assert.equal(disposals, 1)
    assert.throws(() => createResourceScope({closeTimeoutMs: Infinity}), RangeError)
    console.log('PASS resource scope: ordered/parallel disposal, startup cause, late acquire, shared close, truthful deadline')
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
