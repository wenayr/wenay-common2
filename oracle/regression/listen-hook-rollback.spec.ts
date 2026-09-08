import assert from 'node:assert/strict'
import {createListen, createListenCore} from '../../src/Common/events/Listen'

const failure = new Error('add hook failed')

function checkCore(fast: boolean) {
    let deliveries = 0
    let rejectAdd = true
    const core = createListenCore<[]>({fast, event: function changed(type) {
        if (type == 'add' && rejectAdd) throw failure
    }})
    assert.throws(function subscribeRejected() {
        core.on(function rejected() { deliveries++ })
    }, error => error === failure)
    assert.equal(core.count(), 0, 'failed core registration leaves no subscriber')
    core.emit()
    assert.equal(deliveries, 0, 'failed core registration leaves no cached dispatch')
    rejectAdd = false
    const off = core.on(function accepted() { deliveries++ })
    core.emit()
    off()
    assert.equal(deliveries, 1, 'next registration still works')
}

function checkFull(fast: boolean) {
    let deliveries = 0
    let closed = 0
    const events: string[] = []
    const full = createListen<[]>(function produce() {}, {fast, event: function changed(type) {
        events.push(type)
        if (type == 'add') throw failure
    }})
    assert.throws(function subscribeRejected() {
        full.on(function rejected() { deliveries++ }, {cbClose: function rejectedClosed() { closed++ }})
    }, error => error === failure)
    assert.equal(full.count(), 0, 'failed full registration leaves no subscriber')
    full.emit()
    full.close()
    assert.equal(deliveries, 0)
    assert.equal(closed, 0, 'failed registration does not retain its close callback')
    assert.deepEqual(events, ['add', 'remove'], 'rollback reports the resulting subscriber count')
}

function checkReentrantReplacement(fast: boolean, full: boolean) {
    let first = true
    let delivered = 0
    function sameCallback() { delivered++ }
    function changed(type: 'add' | 'remove') {
        if (type != 'add' || !first) return
        first = false
        api.on(sameCallback, {key: 'shared'})
        throw failure
    }
    const api = full
        ? createListen<[]>(function produce() {}, {fast, event: changed})
        : createListenCore<[]>({fast, event: changed})
    assert.throws(function subscribeOuter() { api.on(sameCallback, {key: 'shared'}) }, error => error === failure)
    assert.equal(api.count(), 1, 'failed outer registration preserves reentrant replacement at the same key')
    api.emit()
    assert.equal(delivered, 1)
    api.close()
}

function checkSiblingAndReplacementClose(fast: boolean) {
    let rejectAdd = false
    let delivered = 0
    let failedClose = 0
    let acceptedClose = 0
    const api = createListen<[]>(function produce() {}, {fast, event: function changed(type) {
        if (type == 'add' && rejectAdd) throw failure
    }})
    api.on(function sibling() { delivered++ }, {cbClose: function siblingClosed() { acceptedClose++ }})
    rejectAdd = true
    assert.throws(function subscribeRejected() {
        api.on(function rejected() { delivered += 100 }, {cbClose: function rejectedClosed() { failedClose++ }})
    }, error => error === failure)
    api.emit()
    assert.equal(delivered, 1, 'rollback preserves an existing sibling subscriber')
    api.close()
    assert.equal(acceptedClose, 1)
    assert.equal(failedClose, 0)

    let replace = true
    const replacements = createListen<[]>(function produce() {}, {fast, event: function changed(type) {
        if (type != 'add' || !replace) return
        replace = false
        replacements.on(function successor() {}, {key: 'shared', cbClose: function successorClosed() { acceptedClose++ }})
        throw failure
    }})
    assert.throws(function subscribeOuter() {
        replacements.on(function outer() {}, {key: 'shared', cbClose: function outerClosed() { failedClose++ }})
    }, error => error === failure)
    replacements.close()
    assert.equal(acceptedClose, 2, 'rollback retains the reentrant successor close callback')
    assert.equal(failedClose, 0, 'replacing the rejected registration removes its close callback')
}

function checkThrowingRemoval(fast: boolean) {
    let delivered = 0
    const core = createListenCore<[]>({fast, onRemove: function removed() { throw new Error('remove hook failed') }})
    const off = core.on(function receive() { delivered++ })
    assert.throws(off, /remove hook failed/)
    assert.equal(core.count(), 0)
    core.emit()
    assert.equal(delivered, 0, 'throwing cleanup cannot leave the removed callback in fast dispatch')
}

function checkRollbackFailure(fast: boolean, full: boolean) {
    function changed(type: 'add' | 'remove') {
        if (type == 'add') throw failure
        throw new Error('rollback hook failed')
    }
    const api = full
        ? createListen<[]>(function produce() {}, {fast, event: changed})
        : createListenCore<[]>({fast, event: changed})
    assert.throws(function subscribeRejected() { api.on(function rejected() {}) }, error => error === failure)
    assert.equal(api.count(), 0, 'rollback errors preserve the admission error without leaking the callback')
}

let failures = 0
for (const fast of [false, true]) {
    const checks = [
        function core() { checkCore(fast) },
        function full() { checkFull(fast) },
        function reentrantCore() { checkReentrantReplacement(fast, false) },
        function reentrantFull() { checkReentrantReplacement(fast, true) },
        function siblingAndClose() { checkSiblingAndReplacementClose(fast) },
        function removal() { checkThrowingRemoval(fast) },
        function rollbackCore() { checkRollbackFailure(fast, false) },
        function rollbackFull() { checkRollbackFailure(fast, true) },
    ]
    for (const check of checks) {
        try { check() }
        catch (error) { failures++; console.error(`FAIL ${check.name} fast=${fast}`, error) }
    }
}
assert.equal(failures, 0, `${failures} Listen admission/rollback checks failed`)
console.log('PASS Listen admission rollback: core/full, fast/slow, reentrant replacement, failing cleanup')
