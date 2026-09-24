import assert from 'node:assert/strict'
import {setImmediate as flushTurn} from 'node:timers/promises'
import {createResourceScope, createReconciler, Observe} from '../../../../src'
import {runCheck} from '../../resources/run-check'

// External operations stay in the application's injected resource.
async function startAgent(deps: {apply: (ids: string[], signal: AbortSignal) => Promise<void>}) {
    const scope = createResourceScope()
    return scope.start(async function start(signal) {
        const store = Observe.createStore({ids: ['initial']})
        const worker = await scope.resource.acquire({
            open: () => createReconciler({
                signal,
                read: () => store.snapshot(),
                subscribe: store.listen().on,
                async run(snapshot, context) {
                    try { await deps.apply(snapshot.ids, context.signal) }
                    catch (error) {
                        if (context.signal.aborted) return
                        // The application chooses whether and when the same work is safe to retry.
                        context.retry('assignments', 5000)
                    }
                },
            }),
            close: worker => worker.close(),
        })
        return {store, control: worker.control, close: scope.close}
    })
}

async function main() {
    let release!: () => void
    let started!: () => void
    const io = new Promise<void>(function pending(resolve) { release = resolve })
    const admitted = new Promise<void>(function pending(resolve) { started = resolve })
    const seen: string[][] = []
    const agent = await startAgent({async apply(ids) {
        seen.push(ids)
        if (seen.length == 1) { started(); await io }
    }})
    agent.control.request()
    await admitted
    agent.store.state.ids.push('during-io')
    agent.store.state.ids.push('same-pending-pass')
    await flushTurn()
    assert.deepEqual(seen, [['initial']])
    release()
    await agent.control.idle()
    assert.deepEqual(seen, [['initial'], ['initial', 'during-io', 'same-pending-pass']])
    assert.equal(agent.close(), agent.close())
    await agent.close()
    agent.store.state.ids.push('after-close')
    await agent.control.idle()
    assert.equal(seen.length, 2)
    console.log('PASS hosting agent ownership and coalescing over fresh Store snapshots')
}

runCheck(main)
