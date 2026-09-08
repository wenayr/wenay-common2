import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createAiRunHost} from '../src/Common/ai/ai-run-host'

test('provider cancellation exceptions cannot interrupt host shutdown', async function isolatedProviderCancel() {
    const waits: Promise<unknown>[] = []
    let cancellations = 0
    let eventsClosed = false
    const host = createAiRunHost({runner: {
        async run({run, waitForInput, requestApproval}) {
            const waiting = run.kind == 'input'
                ? waitForInput({label: 'Input'})
                : requestApproval({kind: 'review', label: 'Approve'})
            waits.push(waiting)
            await waiting
        },
        cancel() { cancellations++; throw new Error('provider cancellation failed') },
    }})
    const connection = host.connection('alice')
    connection.fragment.events.line.onClose(function closed() { eventsClosed = true })
    connection.fragment.createRun({kind: 'input', requestId: 'input', input: {}})
    connection.fragment.createRun({kind: 'approval', requestId: 'approval', input: {}})
    const outcomes = Promise.allSettled(waits)
    assert.equal(waits.length, 2)
    assert.doesNotThrow(function close() { host.close() })
    assert.equal(cancellations, 2)
    assert.equal(eventsClosed, true)
    const settled = await outcomes
    assert(settled.every(result => result.status == 'rejected' && /host closed/.test(String(result.reason))))
    host.close()
    assert.equal(cancellations, 2)
})

test('AI request identities preserve account boundaries including delimiters', async function accountScopedRequests() {
    const host = createAiRunHost({runner: {run() { return {result: 'done'} }}})
    try {
        const first = host.connection('alice\u0000task').fragment
        const second = host.connection('alice').fragment
        const one = first.createRun({kind: 'summary', requestId: 'request', input: {}})
        const two = second.createRun({kind: 'summary', requestId: 'task\u0000request', input: {}})
        assert.notEqual(one.id, two.id)
        assert.equal(two.owner, 'alice')
        assert.equal(first.createRun({kind: 'summary', requestId: 'request', input: {}}).id, one.id)
        assert.equal(second.createRun({kind: 'summary', requestId: 'task\u0000request', input: {}}).id, two.id)
        assert.equal(Object.keys(host.store.state.runs).length, 2)
    } finally { host.close() }
})
