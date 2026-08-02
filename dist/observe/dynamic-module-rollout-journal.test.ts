import {strict as assert} from 'node:assert'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {openFsReplayStorage} from '../src/server/fsReplayStorage'
import {
    createMemoryReplayStorage,
    ReplayStorage,
} from '../src/Common/events/replay-history'
import {tModuleArtifactRef} from '../experiments/dynamic-runtime/artifact-registry'
import {
    createModuleRolloutJournal,
    ModuleRolloutJournalState,
    ModuleRolloutCommand,
    RolloutNodeBinding,
} from '../experiments/dynamic-runtime/rollout-journal'

const V1 = ('sha256:' + '1'.repeat(64)) as tModuleArtifactRef
const V2 = ('sha256:' + '2'.repeat(64)) as tModuleArtifactRef

function command(
    commandId: string,
    generation: number,
    artifactRef: tModuleArtifactRef,
): ModuleRolloutCommand {
    return {
        commandId,
        rolloutId: 'journal-rollout-' + generation,
        slotId: 'journal.primary',
        artifactRef,
        authorityId: 'journal-controller',
        authorityEpoch: 3,
        generation,
    }
}

function binding(
    artifactRef: tModuleArtifactRef,
    version: string,
    bindingGeneration: number,
): Record<string, RolloutNodeBinding> {
    return {
        'runtime-1': {
            nodeId: 'runtime-1',
            artifactRef,
            moduleId: 'journal.impl',
            version,
            bindingGeneration,
        },
    }
}

async function main() {
    const corruptStorage = createMemoryReplayStorage<[ModuleRolloutJournalState]>()
    corruptStorage.putKeyframe({
        seq: 0,
        ts: 1,
        event: [{...({} as ModuleRolloutJournalState), protocol: 99 as 1}],
    })
    assert.throws(
        () => createModuleRolloutJournal({storage: corruptStorage}),
        /restored protocol is unsupported/,
    )

    const memory = createMemoryReplayStorage<[ModuleRolloutJournalState]>()
    let rejectNextCommit = true
    const failingStorage: ReplayStorage<[ModuleRolloutJournalState]> = {
        ...memory,
        putEvent(event) {
            if (rejectNextCommit) {
                rejectNextCommit = false
                throw new Error('injected persistence failure')
            }
            memory.putEvent(event)
        },
    }
    const failureJournal = createModuleRolloutJournal({storage: failingStorage})
    assert.throws(
        () => failureJournal.control.accept(command('persistence-retry', 1, V1)),
        /injected persistence failure/,
    )
    assert.equal(failureJournal.view.snapshot().generation, 0)
    assert.equal(failureJournal.view.receipt('persistence-retry'), null)
    assert.equal(failureJournal.control.accept(command('persistence-retry', 1, V1)).replay, false)
    failureJournal.close()

    const directory = await mkdtemp(join(tmpdir(), 'wenay-rollout-journal-'))
    const file = join(directory, 'journal.jsonl')
    try {
        const first = createModuleRolloutJournal({storage: openFsReplayStorage(file)})
        const v1 = command('journal-v1', 1, V1)
        const accepted = first.control.accept(v1)
        assert.equal(accepted.replay, false)
        assert.equal(first.control.accept(v1).replay, true)
        assert.throws(
            () => first.control.accept({...v1, artifactRef: V2}),
            /commandId was reused/,
        )
        assert.throws(
            () => first.control.accept(command('parallel-v2', 2, V2)),
            /rollout is already in progress/,
        )
        first.close()

        const recovered = createModuleRolloutJournal({storage: openFsReplayStorage(file)})
        assert.equal(recovered.view.restored().fromArchive, true)
        assert.equal(recovered.view.pending()[0]?.commandId, v1.commandId)
        recovered.control.fact(v1.commandId, {
            action: 'test node activated',
            nodeId: 'runtime-1',
            artifactRef: V1,
        })
        const completed = recovered.control.complete(v1.commandId, binding(V1, '1.0.0', 1))
        assert.equal(completed.state, 'completed')
        recovered.close()

        const second = createModuleRolloutJournal({storage: openFsReplayStorage(file)})
        assert.equal(second.view.pending().length, 0)
        assert.equal(second.view.snapshot().lastKnownGood['runtime-1']?.version, '1.0.0')
        const v2 = command('journal-v2', 2, V2)
        second.control.accept(v2)
        const failed = second.control.fail(
            v2.commandId,
            new Error('injected rollout failure'),
            binding(V1, '1.0.0', 1),
        )
        assert.equal(failed.state, 'failed')
        assert.equal(second.view.snapshot().active['runtime-1']?.artifactRef, V1)
        assert.equal(second.view.snapshot().lastKnownGood['runtime-1']?.artifactRef, V1)
        assert.equal(second.view.snapshot().quarantined[V2]?.reason, 'injected rollout failure')
        assert.throws(
            () => second.control.accept({
                ...command('stale-authority', 3, V1),
                authorityEpoch: 2,
            }),
            /stale authority epoch/,
        )
        assert.ok(second.view.snapshot().audit.length >= 5)
        second.close()
        console.log('[dynamic rollout journal] failed commit, receipt, restart, LKG, quarantine, fencing: ok')
    } finally {
        await rm(directory, {recursive: true, force: true})
    }
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
