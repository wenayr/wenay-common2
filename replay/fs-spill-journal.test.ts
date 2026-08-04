// =====================================================================
// fsSpillJournal: RAM-first window, disk only on eviction, bounded budget
// =====================================================================
// Run: npx tsx replay/fs-spill-journal.test.ts

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {openFsSpillJournal} from '../src/server/fsSpillJournal'
import {replayListen} from '../src/Common/events/replay-index'
import type {ReplayEvent} from '../src/Common/events/replay-listen'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-spill-journal-'))

function fileOf(name: string) {
    return path.join(dir, name + '.jsonl')
}

function feed(journal: {line: {onJournal: (ev: ReplayEvent<[string]>) => void}}, from: number, to: number, payload = 'v') {
    for (let seq = from; seq <= to; seq++) journal.line.onJournal({seq, ts: seq, event: [payload + seq]})
}

function seqs(events: ReplayEvent<[string]>[] | undefined) {
    return events?.map(ev => ev.seq)
}

function range(from: number, to: number) {
    return Array.from({length: to - from + 1}, (_, index) => from + index)
}

// =====================================================================
// Within the RAM window the disk is never touched
// =====================================================================

function ramOnlyPhaseWritesNothing() {
    const file = fileOf('ram-only')
    const spill = openFsSpillJournal<[string]>(file, {history: 50, maxBytes: 100_000})
    feed(spill, 1, 50)
    assert.equal(fs.existsSync(file), false, 'no eviction yet — no file')
    assert.deepEqual(seqs(spill.line.getSince(20)), range(21, 50), 'tail served from RAM')
    assert.deepEqual(spill.line.getSince(50), [], 'up-to-date reader costs nothing')
    assert.equal(spill.size().diskBytes, 0, 'zero disk bytes')
    spill.close()
    console.log('ok  within the RAM window the disk is never written')
}

// =====================================================================
// Eviction spills; an old reader gets the exact disk+RAM tail
// =====================================================================

function evictionSpillsAndServesContiguously() {
    const file = fileOf('spill')
    const spill = openFsSpillJournal<[string]>(file, {history: 10, maxBytes: 1_000_000})
    feed(spill, 1, 100)
    assert.equal(fs.existsSync(file), true, 'overflow reached the disk')
    const stats = spill.size()
    assert.equal(stats.ramEvents, 10, 'RAM holds exactly the window')
    assert.equal(stats.diskEvents, 90, 'everything evicted is on disk')
    assert.equal(stats.oldestSeq, 1, 'the whole lifetime is provable')
    assert.deepEqual(seqs(spill.line.getSince(0)), range(1, 100), 'disk prefix + RAM tail, contiguous')
    assert.deepEqual(seqs(spill.line.getSince(95)), range(96, 100), 'recent reader still served from RAM')
    spill.close()
    assert.equal(fs.existsSync(file), false, 'close removes the spill')
    console.log('ok  eviction spills and an old reader gets the exact tail')
}

// =====================================================================
// The budget bounds the disk by segment rotation, never by rewrite
// =====================================================================

function budgetRotatesInsteadOfRewriting() {
    const file = fileOf('rotate')
    const maxBytes = 8_000
    const spill = openFsSpillJournal<[string]>(file, {history: 5, maxBytes})
    feed(spill, 1, 800, 'x'.repeat(40) + '-')
    const stats = spill.size()
    assert.ok(stats.diskBytes <= maxBytes, `disk stays within the budget (${stats.diskBytes} <= ${maxBytes})`)
    assert.ok(stats.oldestSeq! > 1, 'the oldest spilled prefix fell off')
    assert.equal(spill.line.getSince(1), undefined, 'a reader older than the window gets a keyframe reset')
    const provable = stats.oldestSeq!
    assert.deepEqual(seqs(spill.line.getSince(provable - 1)), range(provable, 800), 'the surviving window is exact')
    spill.close()
    console.log('ok  the budget rotates segments, the surviving window stays exact')
}

// =====================================================================
// Disk trouble degrades to the RAM window, never to a broken tail
// =====================================================================

function diskLossDegradesToKeyframeReset() {
    const file = fileOf('degrade')
    const spill = openFsSpillJournal<[string]>(file, {history: 10, maxBytes: 1_000_000})
    feed(spill, 1, 60)
    fs.rmSync(file, {force: true}) // the spill vanishes behind the journal's back
    assert.equal(spill.line.getSince(0), undefined, 'unreadable disk → keyframe reset, not a gap')
    assert.deepEqual(seqs(spill.line.getSince(55)), range(56, 60), 'the RAM window still serves')
    spill.close()
    console.log('ok  losing the spill degrades to a keyframe reset')
}

// =====================================================================
// open() starts a fresh lifetime: leftovers are removed
// =====================================================================

function openRemovesLeftovers() {
    const file = fileOf('lifetime')
    fs.writeFileSync(file, 'stale previous lifetime\n')
    fs.writeFileSync(file + '.1', 'stale rotated segment\n')
    const spill = openFsSpillJournal<[string]>(file, {history: 5, maxBytes: 10_000})
    assert.equal(fs.existsSync(file), false, 'previous lifetime removed at open')
    assert.equal(fs.existsSync(file + '.1'), false, 'rotated leftover removed too')
    spill.close()
    console.log('ok  open() removes a previous lifetime — its gap cannot be filled')
}

// =====================================================================
// On a live line: a subscriber far behind the RAM ring replays exactly
// =====================================================================

function liveLineServesLateSubscriberFromSpill() {
    const file = fileOf('live-line')
    const spill = openFsSpillJournal<[number]>(file, {history: 8, maxBytes: 1_000_000})
    let value = 0
    const [emit, replay] = replayListen<[number]>({
        current: () => [value],
        ...spill.line,
        now: () => 1000 + value,
    })
    for (let n = 1; n <= 100; n++) { value = n; emit(n) }
    const got: number[] = []
    const off = replay.on(function lateSubscriber(n: number) { got.push(n) }, {since: 30})
    assert.deepEqual(got, range(31, 100), 'spilled prefix + RAM tail replayed exactly, no keyframe jump')
    // and live continues seamlessly after the catch-up
    value = 101; emit(101)
    assert.equal(got[got.length - 1], 101, 'live event follows the replay')
    off()
    spill.close()
    console.log('ok  a live line serves a far-behind subscriber from the spill')
}

function main() {
    ramOnlyPhaseWritesNothing()
    evictionSpillsAndServesContiguously()
    budgetRotatesInsteadOfRewriting()
    diskLossDegradesToKeyframeReset()
    openRemovesLeftovers()
    liveLineServesLateSubscriberFromSpill()
    fs.rmSync(dir, {recursive: true, force: true})
    console.log('fs-spill-journal: all checks passed')
}

main()
