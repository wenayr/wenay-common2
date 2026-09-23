import assert from 'node:assert/strict'
import {appendFileSync, readFileSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createAiRunHost} from '../../src/Common/ai/ai-index'
import {openAiCheckpoint} from '../../experiments/wenay-scaffold/examples/ai-support/persistence'

const request = {requestId: 'paid-intent-fixture', kind: 'local', input: {text: 'no paid calls'}}
if (process.argv[2] == '--effect-child') {
    const directory = process.argv[3]
    const host = createAiRunHost({...openAiCheckpoint(path.join(directory, 'runs.log')), runner: {run() {
        appendFileSync(path.join(directory, 'effects.txt'), 'effect\n')
        // Terminate this owned fixture between external effect and result commit, without close().
        process.exit(0)
    }}})
    host.connection('alice').fragment.createRun(request)
} else {
    const tempRoot = realpathSync(tmpdir())
    const directory = mkdtempSync(path.join(tempRoot, 'ai-process-restart-'))
    try {
        const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', __filename, '--effect-child', directory],
            {encoding: 'utf8', windowsHide: true, timeout: 15_000})
        assert.equal(child.status, 0, child.stderr)
        const effects = path.join(directory, 'effects.txt')
        assert.equal(readFileSync(effects, 'utf8'), 'effect\n')
        const file = path.join(directory, 'runs.log')
        const runner = {run() { appendFileSync(effects, 'DUPLICATE\n'); return {} }}
        let host = createAiRunHost({...openAiCheckpoint(file), runner})
        const restored = host.connection('alice').fragment.createRun(request)
        assert.equal(restored.recovery?.from, 'running')
        assert.equal(readFileSync(effects, 'utf8'), 'effect\n')
        host.recovery.settle(restored.id, {state: 'completed', output: {result: {confirmed: true}}})
        host.close()
        host = createAiRunHost({...openAiCheckpoint(file), runner})
        try {
            assert.deepEqual(host.connection('alice').fragment.createRun(request).result, {confirmed: true})
            assert.equal(readFileSync(effects, 'utf8'), 'effect\n')
        } finally { host.close() }
        console.log('PASS A1 process restart: effect persisted by a terminated child, no hidden repeat, explicit reconciliation and durable receipt')
    } finally {
        const resolved = realpathSync(directory)
        assert.equal(path.dirname(resolved), tempRoot)
        assert(path.basename(resolved).startsWith('ai-process-restart-'))
        rmSync(resolved, {recursive: true, force: true})
    }
}
