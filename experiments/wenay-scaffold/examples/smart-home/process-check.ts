import assert from 'node:assert/strict'
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../../../../src/Common/rcp/rpc-clientHub'
import {createHomeReader, createHomeDevice} from './client'
import {startHomeStand} from './stand'
import type {ReaderFacade, DeviceFacade} from './host'
import {runCheck} from '../../resources/run-check'

async function until(check: () => boolean | Promise<boolean>, message: string) {
    const deadline = Date.now() + 12_000
    while (!await check()) {
        assert(Date.now() < deadline, message)
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

async function main() {
    const stand = await startHomeStand()
    const phone = createHomeReader(stand.source.reader('anna'))
    const tablet = createHomeReader(stand.source.reader('anna'))
    const bob = createHomeReader(stand.source.reader('bob'))
    const meter = createHomeDevice(stand.source.device('anna'))
    const heater = createHomeDevice(stand.source.device('bob'))
    const readers = [phone, tablet, bob]
    const probes: {close(): unknown}[] = []
    const watchdog = setTimeout(function expired() {
        console.error('smart-home process check timed out')
        for (const reader of readers) reader.close()
        meter.close(); heater.close()
        void stand.close()
        process.exitCode = 3
    }, 60_000)
    try {
        await Promise.all([phone.ready, tablet.ready, bob.ready, meter.ready, heater.ready])
        assert.equal(new Set([process.pid, stand.view.pid('anna'), stand.view.pid('bob')]).size, 3)
        assert.deepEqual(Object.keys(phone.store.state.devices), ['meter'])
        assert.deepEqual(Object.keys(bob.store.state.devices), ['heater'])
        const stats = await stand.view.stats('anna')
        assert.equal(stats.lines, 1)
        assert.equal(stats.readers, 2)
        console.log('PASS placement: two household owner processes; two readers share one line')

        // === The token grants a facet, never a client-selected household ===
        const annaEndpoint = stand.source.reader('anna')
        const forged = createRpcClientHub(
            function socket() { return io(annaEndpoint.url, {transports: ['websocket'], forceNew: true}) },
            r => ({home: r<ReaderFacade & DeviceFacade>('home')}),
            {token: annaEndpoint.token},
        )
        probes.push(forged)
        await forged.promise
        await forged.facade.home.readyStrict()
        assert.equal(forged.facade.home.schema().control, undefined)
        assert.equal(forged.facade.home.schema().source.line.emit, undefined)
        const forgedLine = forged.facade.home.func.source.line as unknown as {emit(value: unknown): Promise<unknown>}
        await assert.rejects(forgedLine.emit(null), 'a reader cannot publish forged batches to the shared source')
        await forged.facade.home.func.source.line.close()
        assert.equal((await stand.view.stats('anna')).readers, 2, 'one reader cannot close the shared source')
        await assert.rejects(forged.facade.home.func.control.record(99), 'a forged write is refused on a reader connection')
        const wrongHome = createRpcClientHub(
            function socket() { return io(annaEndpoint.url, {transports: ['websocket'], forceNew: true}) },
            r => ({home: r<ReaderFacade>('home')}),
            {token: stand.source.reader('bob').token},
        )
        probes.push(wrongHome)
        const wrong = await wrongHome.promise
        await wrong.home.readyStrict()
        assert.equal((await wrong.home.auth())?.ok, false)
        await assert.rejects(wrong.home.func.source.keyframe(), 'another household token cannot read this process')
        forged.close(); wrongHome.close()
        console.log('PASS RPC: reader cannot write or close shared source; foreign household cannot read')

        const stable = phone.store
        const bobSeq = bob.view.seq()
        for (const reading of [false, 0, '0', null, 1, 2, 3, 4] as const) {
            await meter.control.record(reading)
            await until(() => Object.is(phone.store.state.devices.meter.reading, reading)
                && Object.is(tablet.store.state.devices.meter.reading, reading), 'both readers receive the exact telemetry value')
        }
        assert.equal(bob.view.seq(), bobSeq)
        assert(!JSON.stringify(phone.store.snapshot()).includes('private'))
        const oldSeq = phone.view.seq()
        assert(oldSeq >= 5)
        const oldPid = stand.view.pid('anna')
        await stand.control.crash('anna')
        await until(() => phone.health.state.state == 'offline' && meter.health.state.state == 'offline', 'reader and device report owner outage')
        await assert.rejects(meter.control.record(999), 'offline commands fail visibly rather than silently queueing')
        assert.equal(phone.store.state.devices.meter.reading, 4, 'last known value stays available while offline')
        await heater.control.record(22)
        await until(() => bob.store.state.devices.heater.reading == 22, 'other household keeps accepting writes')
        assert.equal(bob.health.state.state, 'live')
        await stand.control.restart('anna')
        await until(() => phone.health.state.state == 'live' && phone.view.connections() >= 2
            && tablet.health.state.state == 'live' && tablet.view.connections() >= 2, 'same readers reconnect after restart')
        assert.notEqual(stand.view.pid('anna'), oldPid)
        assert.equal(phone.store, stable, 'the local Store object survives the process restart')
        assert.equal(phone.store.state.devices.meter.reading, 4, 'acknowledged reading survived a hard process crash')
        assert(phone.view.seq() < oldSeq, 'explicit snapshot policy accepted the restarted projection sequence')
        await until(() => meter.health.state.state == 'live', 'device authenticated its own independent reconnect')
        await meter.control.record(false)
        await until(() => phone.store.state.devices.meter.reading === false
            && tablet.store.state.devices.meter.reading === false, 'live updates continue after restored snapshot')
        console.log('PASS recovery: hard crash, durable value, independent household, same Store and live reconnect')

        // === Drop all readers, keep accepting device facts, then read again ===
        phone.close(); tablet.close()
        await until(async () => (await stand.view.stats('anna')).lines == 0, 'last reader releases idle projection')
        const idle = await stand.view.stats('anna')
        assert.equal(idle.readers, 0)
        await meter.control.record('offline update')
        assert.equal((await stand.view.stats('anna')).projections, idle.projections, 'idle home does not recompute its view')
        const returned = createHomeReader(stand.source.reader('anna'))
        readers.push(returned)
        await returned.ready
        assert.equal(returned.store.state.devices.meter.reading, 'offline update')
        assert.equal((await stand.view.stats('anna')).lines, 1)
        returned.close()
        await until(async () => (await stand.view.stats('anna')).lines == 0, 'reopened line is reclaimed again')
        console.log('PASS idle lifecycle: reclaim, durable device writes without a view, fresh reopen, reclaim again')
    } finally {
        clearTimeout(watchdog)
        for (const probe of probes) probe.close()
        for (const reader of readers) reader.close()
        meter.close(); heater.close()
        await stand.close()
    }
}

runCheck(main)
