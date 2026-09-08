import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {openFsSpillJournal} from '../src/server/fsSpillJournal'

for (const maxBytes of [2 ** 31, 2 ** 32]) {
    test(`spill retains small history under a ${maxBytes} byte budget`, function () {
        const dir = mkdtempSync(path.join(tmpdir(), 'spill-budget-boundary-'))
        const spill = openFsSpillJournal<[number]>(path.join(dir, 'events'), {history: 1, maxBytes})
        try {
            for (let seq = 1; seq <= 5; seq++) spill.line.onJournal({seq, ts: seq, event: [seq]})
            assert.deepEqual(spill.line.getSince(0)?.map(event => event.seq), [1, 2, 3, 4, 5])
            assert.equal(spill.size().diskEvents, 4)
        } finally {
            spill.close()
            rmSync(dir, {recursive: true, force: true})
        }
    })
}

test('spill codec failure degrades to the RAM window without rejecting the producer', function () {
    const dir = mkdtempSync(path.join(tmpdir(), 'spill-codec-boundary-'))
    const spill = openFsSpillJournal<[number]>(path.join(dir, 'events'), {
        history: 1,
        maxBytes: 1024,
        codec: {
            stringify() { throw new Error('codec unavailable') },
            parse: JSON.parse,
        },
    })
    try {
        spill.line.onJournal({seq: 1, ts: 1, event: [1]})
        assert.doesNotThrow(function append() { spill.line.onJournal({seq: 2, ts: 2, event: [2]}) })
        assert.equal(spill.size().spillErrors, 1)
        assert.equal(spill.line.getSince(0), undefined)
        assert.deepEqual(spill.line.getSince(1)?.map(event => event.seq), [2])
    } finally {
        spill.close()
        rmSync(dir, {recursive: true, force: true})
    }
})
