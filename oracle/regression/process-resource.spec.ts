import assert from 'node:assert/strict'
import {createProcessResource} from '../../src/server/process-resource'
import {runOracle} from '../run-oracle'

async function main() {
    function child(code: string, extra = {}) {
        return createProcessResource({command: process.execPath, args: ['-e', code], startTimeoutMs: 300, stopTimeoutMs: 50,
            ready: fact => fact.type == 'stdout' && fact.tail.includes('READY') ? 'ready' : undefined, ...extra})
    }
    const never = child('setInterval(() => {}, 100)')
    await assert.rejects(never.ready, /timed out/)
    await never.done
    assert(never.view.stopped())
    const early = child('process.exit(2)')
    await assert.rejects(early.ready, /exited/)
    await early.done
    const abort = new AbortController()
    const pending = child('setInterval(() => {}, 100)', {signal: abort.signal})
    abort.abort()
    await assert.rejects(pending.ready, /closed/)
    await pending.done
    const running = child('console.log("READY"); setInterval(() => {}, 100)', {shutdown: () => new Promise<void>(() => {})})
    await running.ready
    const close = running.close()
    assert.equal(close, running.close())
    await close
    assert(running.view.stopped())
    assert(running.view.output().includes('READY'))
    console.log('PASS process resource: never ready, early exit, cancel, concurrent close, hung shutdown force-kill (' + process.platform + ')')
}
runOracle(main)
