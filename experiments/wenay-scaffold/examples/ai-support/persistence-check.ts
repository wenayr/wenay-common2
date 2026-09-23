import assert from 'node:assert/strict'
import {mkdtempSync, appendFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Ai} from '../../../../src'
import {openAiCheckpoint} from './persistence'

async function main() {
    const directory = mkdtempSync(path.join(tmpdir(), 'ai-checkpoint-'))
    const file = path.join(directory, 'runs.jsonl')
    let effects = 0
    const request = {kind: 'local-fixture', requestId: 'one-intent', input: {text: 'no paid calls'}}
    const runner: Ai.AiRunRunner = {
        async run({requestApproval}) {
            effects++
            await requestApproval({kind: 'review', label: 'Confirm local result'})
            return {result: 'local result'}
        },
        async recover({checkpoint, requestApproval}) {
            // A real adapter first reconciles the provider's stable operation ID.
            // This fixture resumes only its retained confirmation after a local effect.
            const pending = checkpoint.approvals[0]
            const decision = await requestApproval({id: pending.id, kind: pending.kind, label: pending.label})
            return {result: decision == 'approved' ? 'local result' : 'rejected'}
        },
    }
    let host = Ai.createAiRunHost({runner, ...openAiCheckpoint(file)})
    try {
        let session = host.connection('alice')
        const original = session.fragment.createRun(request)
        assert.equal(effects, 1)
        session.close(); host.close()
        // Simulate an interrupted final append. ReplayStorage retains only complete records.
        appendFileSync(file, '{"t":"k","v":')
        host = Ai.createAiRunHost({runner, ...openAiCheckpoint(file)})
        session = host.connection('alice')
        const restored = session.fragment.createRun(request)
        assert.equal(restored.id, original.id)
        assert.equal(restored.recovery?.from, 'waiting_approval')
        assert.equal(effects, 1)
        const recovering = host.recovery.resume(original.id)
        const approval = Object.values(host.store.state.approvals)[0]
        session.fragment.resolveApproval(approval.id, 'approved')
        assert.equal((await recovering).result, 'local result')
        session.close(); host.close()
        host = Ai.createAiRunHost({runner, ...openAiCheckpoint(file)})
        assert.equal(host.connection('alice').fragment.createRun(request).result, 'local result')
        assert.equal(effects, 1)
        console.log('PASS AI persistence composition: filesystem restart, torn append, retained approval/result/receipt; no paid requests')
    } finally {
        host.close()
        // mkdtemp allocated this exact directory; never accept an external cleanup path.
        rmSync(directory, {recursive: true, force: true})
    }
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
