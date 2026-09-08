import assert from 'node:assert/strict'
import {createStoreFollower} from '../../../../src/Common/Observe/store-follower'
import {createHomeService, type tReading} from './service'

async function until(check: () => boolean) {
    const deadline = Date.now() + 3000
    while (!check()) {
        assert(Date.now() < deadline, 'readers did not converge on the exact device value')
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

async function main() {
    const service = createHomeService({initial: {devices: {
        meter: {home: 'anna', label: 'Power adapter', reading: 0, secret: 'anna-device-secret'},
        heater: {home: 'bob', label: 'Heater', reading: 21, secret: 'bob-device-secret'},
    }}})
    const annaLine = service.source.household('anna')
    const bobLine = service.source.household('bob')
    assert.equal(service.source.household('anna'), annaLine, 'readers share one household projection')
    const phone = createStoreFollower({remote: annaLine})
    const tablet = createStoreFollower({remote: annaLine})
    const bob = createStoreFollower({remote: bobLine})
    const readers = [phone, tablet, bob]
    const wire: unknown[] = []
    const off = annaLine.line.on(function capture(batch) { wire.push(batch) })
    try {
        await Promise.all(readers.map(reader => reader.ready))
        assert.deepEqual(Object.keys(phone.store.state.devices), ['meter'])
        assert.deepEqual(Object.keys(bob.store.state.devices), ['heater'])
        const bobSeq = bob.status.state.seq
        const readings: tReading[] = [false, 0, '0', null, 0]
        for (const reading of readings) {
            service.control.record('meter', reading)
            await until(() => Object.is(phone.store.state.devices.meter.reading, reading)
                && Object.is(tablet.store.state.devices.meter.reading, reading))
            console.log(`meter → ${JSON.stringify(reading)} (${typeof reading}); both readers agree`)
        }
        assert.equal(bob.status.state.seq, bobSeq, 'another home receives no unrelated updates')
        const captured = JSON.stringify({snapshot: await annaLine.keyframe(), wire})
        assert(!captured.includes('secret') && !captured.includes('heater'), 'snapshot and replay omit private/foreign facts')
        phone.close()
        const reopened = createStoreFollower({remote: annaLine})
        readers.push(reopened)
        await reopened.ready
        assert.equal(reopened.store.state.devices.meter.reading, 0, 'a new reader starts from the latest snapshot')
        service.control.record('meter', false)
        await until(() => reopened.store.state.devices.meter.reading === false
            && tablet.store.state.devices.meter.reading === false)
        assert.equal(phone.store.state.devices.meter.reading, 0, 'a closed reader receives no more facts')
        console.log('PASS smart-home: exact values, two households, shared line, reader replacement, private fields omitted')
    } finally {
        off()
        for (const reader of readers) reader.close()
        service.close()
    }
}

main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
