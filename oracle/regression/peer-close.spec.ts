import assert from 'node:assert/strict'
import {createPeerHost, type PatchEnvelope} from '../../src/Common/peer/peer-index'
import {runOracle} from '../run-oracle'

function frame(seq: number, x: number): PatchEnvelope {
    return {seq, ts: seq, event: [{path: [], exists: true, value: {x}}]}
}

async function pendingSignal(closeHost = false) {
    let allow: (value: boolean)=>void = ()=>{}
    let entered: ()=>void = ()=>{}
    const started = new Promise<void>(function markStarted(resolve) {entered = resolve})
    const approval = new Promise<boolean>(function waitApproval(resolve) {allow = resolve})
    const host = createPeerHost({authorize: function authorize() {
        entered()
        return approval
    }})
    const sender = host.connection('sender')
    const receiver = host.connection('receiver')
    let signals = 0
    const off = receiver.fragment.signal.signals.on(function received() {signals++})
    try {
        const pending = sender.fragment.signal.send({type: 'ice', pair: 'sender-receiver', from: 'sender', to: 'receiver'})
        await started
        if (closeHost) host.close()
        else sender.close()
        allow(true)
        const sent = await pending
        console.log(JSON.stringify({pendingAfterClose: sent, delivered: signals}))
        assert.equal(sent, false)
        assert.equal(signals, 0, 'close must invalidate signaling waiting for authorization')
    } finally {
        allow(false)
        off()
        sender.close()
        receiver.close()
        host.close()
    }
}

async function main() {
    const host = createPeerHost({history: 8})
    const sender = host.connection('sender')
    const receiver = host.connection('receiver')
    let signals = 0
    const off = receiver.fragment.signal.signals.on(function received() {signals++})
    try {
        assert.equal(sender.fragment.publish(frame(0, 1)), true)
        assert.equal(await sender.fragment.signal.send({type: 'ice', pair: 'sender-receiver', from: 'sender', to: 'receiver'}), true)
        assert.equal(signals, 1)
        const before = host.relay('sender').snapshot()
        assert.equal(before.x, 1)
        sender.close()
        sender.close()
        assert(!host.presence.list().includes('sender'))

        let published: unknown
        try {published = sender.fragment.publish(frame(1, 2))} catch {published = 'rejected'}
        const singleChanged = host.relay('sender').snapshot().x!=1
        let batchPublished: unknown
        try {batchPublished = sender.fragment.publishBatch([frame(2, 3)])} catch {batchPublished = 'rejected'}
        const batchChanged = host.relay('sender').snapshot().x==3
        let sent: unknown
        try {sent = await sender.fragment.signal.send({type: 'ice', pair: 'sender-receiver', from: 'sender', to: 'receiver'})} catch {sent = 'rejected'}
        const deliveredAfterClose = signals-1
        const result = {published, singleChanged, batchPublished, batchChanged, sent, deliveredAfterClose}
        console.log(JSON.stringify(result))
        assert.equal(published, false)
        assert.equal(batchPublished, false)
        assert.equal(sent, false)
        assert.equal(singleChanged, false, 'closed peer connection must not publish')
        assert.equal(batchChanged, false, 'closed peer connection must not publishBatch')
        assert.equal(deliveredAfterClose, 0, 'closed peer connection must not send signaling')
        const second = host.connection('sender')
        const third = host.connection('sender')
        second.close()
        second.close()
        assert(host.presence.list().includes('sender'))
        assert.equal(third.fragment.publish(frame(1, 5)), true)
        assert.equal(await third.fragment.signal.send({type: 'ice', pair: 'sender-receiver', from: 'sender', to: 'receiver'}), true)
        assert.equal(host.relay('sender').snapshot().x, 5)
        host.close()
        host.close()
        assert.equal(third.fragment.publish(frame(2, 6)), false)
        assert.equal(await third.fragment.signal.send({type: 'ice', pair: 'sender-receiver', from: 'sender', to: 'receiver'}), false)
        assert.throws(() => host.connection('new'), /closed/)
        console.log('PASS peer close regression and independent same-account session')
    } finally {
        off()
        sender.close()
        receiver.close()
        host.close()
    }
    await pendingSignal()
    await pendingSignal(true)
}

runOracle(main)

