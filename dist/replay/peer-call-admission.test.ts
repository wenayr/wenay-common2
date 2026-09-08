import {strict as assert} from 'node:assert'
import {test} from 'node:test'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {listen} from '../src/Common/events/Listen'
import {createSignalHub, SignalEnvelope} from '../src/Common/events/route-signal-webrtc'
import {CallHandle, createCallManager} from '../src/Common/peer/peer-call'

for (const action of ['hangup', 'duplicate'] as const) {
    test('pending admission handles ' + action, async function pendingAdmission() {
        let approve!: (value: boolean) => void
        const admitted = new Promise<boolean>(function capture(resolve) { approve = resolve })
        const [emit, signals] = listen<[SignalEnvelope]>()
        let checks = 0
        const manager = createCallManager({
            self: 'callee',
            incoming() { checks++; return admitted },
            port: {signals, send() { return false }},
        })
        const received: CallHandle[] = []
        manager.rings.on(function receivedRing(handle) { received.push(handle) })
        try {
            const ring: SignalEnvelope = {type: 'ring', pair: 'call:1', from: 'caller', to: 'callee'}
            emit(ring)
            emit({...ring, type: action == 'hangup' ? 'hangup' : 'ring'})
            approve(true)
            await nextTurn()
            assert.equal(received.length, action == 'hangup' ? 0 : 1)
            assert.equal(checks, 1)
        } finally {
            approve(true)
            for (const handle of received) handle.hangup()
            manager.close()
            signals.close()
        }
    })
}

for (const type of ['accept', 'decline', 'hangup'] as const) {
    test('an unrelated account cannot send ' + type + ' to a live call', async function unrelatedAccountSignal() {
        const hub = createSignalHub()
        const callerPort = hub.register('caller')
        const peer = hub.register('peer')
        const stranger = hub.register('stranger')
        const manager = createCallManager({self: 'caller', port: callerPort})
        const call = manager.call('peer')
        try {
            await stranger.send({type, pair: call.id, from: 'stranger', to: 'caller'})
            assert.equal(call.state(), 'ringing')
            await peer.send({type, pair: call.id, from: 'peer', to: 'caller'})
            assert.equal(call.state(), type == 'accept' ? 'active' : 'ended')
        } finally {
            manager.close()
            callerPort.close()
            peer.close()
            stranger.close()
            hub.close()
        }
    })
}
