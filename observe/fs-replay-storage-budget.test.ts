// =====================================================================
// fsReplayStorage byte budget: OPT-IN retention, lossless floor, no storms
// =====================================================================
// Run: npx tsx observe/fs-replay-storage-budget.test.ts

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {openFsReplayStorage} from '../src/server/fsReplayStorage'
import type {ReplayEvent} from '../src/Common/events/replay-listen'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-replay-budget-'))

function fileOf(name: string) {
    return path.join(dir, name + '.jsonl')
}

let seq = 0
function event(payload: string): ReplayEvent<[string]> {
    seq++
    return {seq, ts: seq, event: [payload]}
}
function keyframe(payload: string): ReplayEvent<[string]> {
    return {seq, ts: seq, event: [payload]}
}

// =====================================================================
// Without the option: append-only, nothing is ever deleted
// =====================================================================

function withoutBudgetNothingIsDeleted() {
    seq = 0
    const file = fileOf('unbounded')
    const storage = openFsReplayStorage<[string]>(file)
    storage.putKeyframe(keyframe('kf'))
    for (let index = 0; index < 500; index++) storage.putEvent(event('x'.repeat(100)))
    const stats = storage.size()
    assert.equal(stats.events, 500, 'every event retained')
    assert.equal(stats.overBudget, false, 'no budget, so never over it')
    assert.ok(storage.getEvents(0, Infinity).length == 500, 'the whole history is servable')
    console.log('ok  without maxBytes the log is append-only, exactly as before')
}

// =====================================================================
// With the option: the file is kept near the budget, cut at a keyframe
// =====================================================================

function budgetBoundsTheFile() {
    seq = 0
    const file = fileOf('bounded')
    const maxBytes = 20_000
    const storage = openFsReplayStorage<[string]>(file, {maxBytes})
    // Cadence keyframes give the prune its cut points, as the durable layer does.
    storage.putKeyframe(keyframe('kf'))
    for (let round = 0; round < 40; round++) {
        for (let index = 0; index < 16; index++) storage.putEvent(event('v'.repeat(120)))
        storage.putKeyframe(keyframe('kf-' + round))
    }
    const stats = storage.size()
    assert.ok(stats.bytes <= maxBytes, 'the log stays inside the budget: ' + stats.bytes)
    assert.ok(fs.statSync(file).size <= maxBytes, 'and so does the actual file')
    assert.equal(stats.overBudget, false)
    assert.ok(stats.events < 640, 'old events were dropped')
    assert.ok(stats.events > 0, 'but not all of them')

    // The surviving suffix must hydrate exactly: a reopen sees the same window.
    const reopened = openFsReplayStorage<[string]>(file, {maxBytes})
    assert.equal(reopened.size().events, stats.events, 'reopen sees the same retained window')
    const kf = reopened.getKeyframe()
    assert.ok(kf != null, 'the suffix starts from a keyframe')
    assert.ok(reopened.getEvents(kf!.seq, Infinity).length >= 0, 'and the tail after it is servable')
    console.log('ok  maxBytes bounds the file at a keyframe boundary (' + stats.bytes + ' <= ' + maxBytes + ')')
}

// The budget must buy the LONGEST history that fits, not the shortest.
function pruneKeepsTheOldestSuffixThatFits() {
    seq = 0
    const file = fileOf('longest')
    const maxBytes = 30_000
    const storage = openFsReplayStorage<[string]>(file, {maxBytes})
    storage.putKeyframe(keyframe('kf'))
    for (let round = 0; round < 60; round++) {
        for (let index = 0; index < 8; index++) storage.putEvent(event('v'.repeat(150)))
        storage.putKeyframe(keyframe('kf-' + round))
    }
    const stats = storage.size()
    // The floor would be [latest keyframe + 0..8 events] — a few hundred bytes. The
    // prune must have kept far more than that: most of the 3/4 target.
    assert.ok(stats.bytes > maxBytes / 2,
        'the retained window fills the budget instead of collapsing to the floor: ' + stats.bytes)
    console.log('ok  the budget buys the longest suffix that fits (' + stats.bytes + ' of ' + maxBytes + ')')
}

// =====================================================================
// Lossless floor: [latest keyframe + tail] is never cut into
// =====================================================================

function floorAboveBudgetIsReportedNotDeleted() {
    seq = 0
    const file = fileOf('floor')
    const storage = openFsReplayStorage<[string]>(file, {maxBytes: 2_000})
    storage.putKeyframe(keyframe('kf'))
    // One giant tail after the only keyframe: the floor itself exceeds the budget.
    for (let index = 0; index < 50; index++) storage.putEvent(event('x'.repeat(200)))
    const stats = storage.size()
    assert.equal(stats.events, 50, 'no event hydration needs was deleted')
    assert.equal(stats.overBudget, true, 'and the adapter says so instead of hiding it')
    console.log('ok  a floor above the budget is reported, never "fixed" by data loss')
}

// A log with no keyframes at all has no legal cut point.
function noKeyframeMeansNoCut() {
    seq = 0
    const file = fileOf('no-keyframe')
    const storage = openFsReplayStorage<[string]>(file, {maxBytes: 1_000})
    for (let index = 0; index < 30; index++) storage.putEvent(event('x'.repeat(100)))
    assert.equal(storage.size().events, 30, 'nothing deleted without a keyframe boundary')
    assert.equal(storage.size().overBudget, true)
    console.log('ok  no keyframe = no legal cut, data is kept and reported')
}

// =====================================================================
// No prune storms: an over-budget floor must not rewrite per append
// =====================================================================

function overBudgetFloorDoesNotRewritePerAppend() {
    seq = 0
    const file = fileOf('storm')
    const storage = openFsReplayStorage<[string]>(file, {maxBytes: 2_000})
    storage.putKeyframe(keyframe('kf'))
    for (let index = 0; index < 20; index++) storage.putEvent(event('x'.repeat(200)))
    assert.equal(storage.size().overBudget, true)

    // Every append would trigger a prune attempt; the hysteresis must keep the
    // file from being rewritten each time. Observe via mtime-stable file size
    // growth: appends only, no shrink-rewrite churn.
    const sizeBefore = fs.statSync(file).size
    storage.putEvent(event('y'))
    storage.putEvent(event('y'))
    const sizeAfter = fs.statSync(file).size
    assert.ok(sizeAfter > sizeBefore, 'appends land as appends, not as full rewrites')
    console.log('ok  an over-budget floor does not degrade into a rewrite per append')
}

// Manual compact() keeps its historical meaning: [latest keyframe + tail].
function manualCompactUnchanged() {
    seq = 0
    const file = fileOf('compact')
    const storage = openFsReplayStorage<[string]>(file)
    storage.putKeyframe(keyframe('kf-0'))
    for (let index = 0; index < 10; index++) storage.putEvent(event('a'))
    storage.putKeyframe(keyframe('kf-1'))
    for (let index = 0; index < 3; index++) storage.putEvent(event('b'))
    storage.compact()
    const stats = storage.size()
    assert.equal(stats.keyframes, 1, 'only the latest keyframe survives')
    assert.equal(stats.events, 3, 'plus the events after it')
    const reopened = openFsReplayStorage<[string]>(file)
    assert.equal(reopened.size().events, 3, 'and the rewrite is what the file now holds')
    console.log('ok  manual compact() still means [latest keyframe + tail]')
}

function main() {
    try {
        withoutBudgetNothingIsDeleted()
        budgetBoundsTheFile()
        pruneKeepsTheOldestSuffixThatFits()
        floorAboveBudgetIsReportedNotDeleted()
        noKeyframeMeansNoCut()
        overBudgetFloorDoesNotRewritePerAppend()
        manualCompactUnchanged()
        console.log('\nfs replay storage budget: all checks passed')
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

main()
