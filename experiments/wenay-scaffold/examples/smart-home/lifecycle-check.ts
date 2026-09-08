import assert from 'node:assert/strict'
import {createStoreFollower} from '../../../../src/Common/Observe/store-follower'
import {createMemoryReplayStorage} from '../../../../src/Common/events/replay-history'
import {type StorePatch} from '../../../../src/Common/Observe/store'
import {storeReplayAt} from '../../../../src/Common/Observe/store-replay'
import {createHomeService, type HomeState} from './service'

function pause(ms: number) {
    return new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })
}

async function until(check: () => boolean) {
    const deadline = Date.now() + 3000
    while (!check()) {
        assert(Date.now() < deadline, 'household lifecycle did not settle')
        await pause(5)
    }
}

async function main() {
    const initial = {devices: {
        meter: {home: 'anna', label: 'Power adapter', reading: 0, secret: 'anna-secret'},
        heater: {home: 'bob', label: 'Heater', reading: 21, secret: 'bob-secret'},
    }}
    const annaStorage = createMemoryReplayStorage<[readonly StorePatch[]]>()
    const bobStorage = createMemoryReplayStorage<[readonly StorePatch[]]>()
    function storage(home: string) { return home == 'anna' ? annaStorage : bobStorage }
    const service = createHomeService({initial, idleMs: 30, storage})
    const readers: ReturnType<typeof createStoreFollower<any>>[] = []
    try {
        assert.throws(() => service.source.household('missing'), /unknown home/)
        assert.throws(() => service.control.record('toString', 1), /unknown device/)
        assert.equal(service.view.stats().lines, 0, 'household resources start without public projections')
        const anna = service.source.household('anna')
        const bob = service.source.household('bob')
        const phone = createStoreFollower({remote: anna})
        const tablet = createStoreFollower({remote: anna})
        const otherHome = createStoreFollower({remote: bob})
        readers.push(phone, tablet, otherHome)
        await Promise.all(readers.map(reader => reader.ready))
        assert.equal(service.view.stats().readers, 3)
        anna.line.close()
        assert.equal(service.view.stats().readers, 3, 'a reader cannot close the shared household line')
        const before = service.view.stats().projections
        service.control.record('meter', false)
        await until(() => Object.is(phone.store.state.devices.meter.reading, false)
            && Object.is(tablet.store.state.devices.meter.reading, false))
        assert.equal(service.view.stats().projections, before + 1, 'only the owning household recomputes')
        phone.close()
        phone.close()
        await pause(80)
        assert.equal(service.view.stats().lines, 2, 'a second reader retains the line')
        assert.equal(service.view.stats().readers, 2, 'closing a reader twice is harmless')
        const previousSeq = tablet.status.state.seq
        tablet.close()
        await until(() => service.view.stats().lines == 1)
        assert.equal(service.source.household('anna'), anna, 'idle eviction preserves the stable remote facade')
        const idleProjectionCount = service.view.stats().projections
        service.control.record('meter', '0')
        assert.equal(storeReplayAt<HomeState>(annaStorage)?.devices.meter.reading, '0', 'record acknowledges only after the storage port accepted the value')
        await pause(10)
        assert.equal(service.view.stats().projections, idleProjectionCount, 'idle households do no projection work')
        assert((await anna.since(previousSeq)) == null, 'a cursor from the evicted lifetime requests a fresh snapshot')
        const reopened = createStoreFollower({remote: anna})
        readers.push(reopened)
        await reopened.ready
        assert.equal(reopened.store.state.devices.meter.reading, '0', 'retained remote reopens from authoritative state')
        assert(reopened.status.state.seq > previousSeq, 'a new lifetime advances beyond the old cursor')
        assert(!JSON.stringify(reopened.store.snapshot()).includes('secret'))
        reopened.close()
        await pause(10)
        const rapid = createStoreFollower({remote: anna})
        readers.push(rapid)
        await rapid.ready
        await pause(80)
        assert.equal(service.view.stats().lines, 2, 'reconnect cancels the pending idle timer')
        rapid.close()
        otherHome.close()
        service.close()
        await pause(80)
        assert.equal(service.view.stats().lines, 0, 'close cancels pending reclamation timers')
        assert.throws(() => service.source.household('anna'), /closed/)
        assert.throws(() => anna.keyframe(), /closed/)
        assert.throws(() => anna.line.on(function lateReader() {}), /closed/)
        assert.equal(anna.line.count(), 0, 'a failed late subscription does not retain its callback')
        assert.throws(() => service.control.record('meter', 4), /closed/)

        const restored = createHomeService({initial, storage, idleMs: 30})
        const restoredReader = createStoreFollower({remote: restored.source.household('anna')})
        try {
            await restoredReader.ready
            assert.equal(restoredReader.store.state.devices.meter.reading, '0', 'acknowledged device value survives service restart')
        } finally {
            restoredReader.close()
            restored.close()
        }
        console.log('PASS smart-home lifecycle: partitioned recomputation, shared readers, idle eviction, stable reopen, timer cancellation, durable restart')
    } finally {
        for (const reader of readers) reader.close()
        service.close()
    }
}

main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})




