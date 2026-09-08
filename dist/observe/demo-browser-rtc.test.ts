import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createBrowserRtc} from '../demo/browser-rtc'

type BrowserConnection = Parameters<typeof createBrowserRtc>[0]['connection']

function createBrowserResource() {
    const sent: unknown[] = []
    const candidates: unknown[] = []
    const descriptions: unknown[] = []
    let channelClosed = 0
    let connectionClosed = 0
    const channel: ReturnType<BrowserConnection['createDataChannel']> = {
        binaryType: 'blob', onopen: null, onmessage: null, onclose: null, onerror: null,
        send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) { sent.push(data) },
        close() { channelClosed++ },
    }
    const connection: BrowserConnection = {
        onicecandidate: null, ondatachannel: null,
        createDataChannel() { return channel },
        async createOffer() { return {type: 'offer', sdp: 'offer-sdp'} },
        async createAnswer() { return {type: 'answer', sdp: 'answer-sdp'} },
        async setLocalDescription(description) { descriptions.push(description) },
        async setRemoteDescription(description) { descriptions.push(description) },
        async addIceCandidate(candidate) { candidates.push(candidate) },
        close() { connectionClosed++ },
    }
    return {connection, channel, sent, candidates, descriptions,
        closed: () => ({channel: channelClosed, connection: connectionClosed})}
}

test('browser RTC adapter validates signaling and relays native lifecycle', async function rtcResource() {
    const resource = createBrowserResource()
    const rtc = createBrowserRtc({connection: resource.connection})
    assert.deepEqual(await rtc.createOffer(), {type: 'offer', sdp: 'offer-sdp'})
    assert.deepEqual(await rtc.createAnswer(), {type: 'answer', sdp: 'answer-sdp'})
    await rtc.setLocalDescription({type: 'offer', sdp: 'local'})
    await rtc.setRemoteDescription({type: 'answer', sdp: 'remote'})
    assert.deepEqual(resource.descriptions, [{type: 'offer', sdp: 'local'}, {type: 'answer', sdp: 'remote'}])
    assert.throws(function invalidDescription() { rtc.setRemoteDescription({type: 'bogus'}) }, /description type/)
    const candidate = {candidate: 'candidate:1', sdpMid: 'data', sdpMLineIndex: 0, usernameFragment: 'u'}
    await rtc.addIceCandidate(candidate)
    await rtc.addIceCandidate(null)
    assert.deepEqual(resource.candidates, [candidate, undefined])
    assert.throws(function invalidCandidate() { rtc.addIceCandidate({sdpMid: 3}) }, /candidate fields/)
    assert.equal(resource.candidates.length, 2)

    const data = rtc.createDataChannel('replay')
    data.binaryType = 'arraybuffer'
    assert.equal(resource.channel.binaryType, 'arraybuffer')
    data.send('hello')
    const bytes = new Uint8Array([9, 1, 2, 9])
    data.send(bytes.subarray(1, 3))
    assert.deepEqual(resource.sent, ['hello', new Uint8Array([1, 2])])
    const shared = new Uint8Array(new SharedArrayBuffer(4))
    shared.set([9, 3, 4, 9])
    data.send(shared.subarray(1, 3))
    const sharedSent = resource.sent[2]
    assert(sharedSent instanceof Uint8Array)
    assert(sharedSent.buffer instanceof ArrayBuffer, 'shared views become valid DOM send buffers')
    assert.deepEqual([...sharedSent], [3, 4])
    let opened = 0
    let received: unknown
    let closed = 0
    let failed = 0
    data.onopen = function open() { opened++ }
    data.onmessage = function message(event) { received = event.data }
    data.onclose = function close() { closed++ }
    data.onerror = function error() { failed++ }
    Reflect.apply(resource.channel.onopen!, resource.channel, [{}])
    Reflect.apply(resource.channel.onmessage!, resource.channel, [{data: 'message'}])
    Reflect.apply(resource.channel.onclose!, resource.channel, [{}])
    Reflect.apply(resource.channel.onerror!, resource.channel, [{}])
    assert.deepEqual({opened, received, closed, failed}, {opened: 1, received: 'message', closed: 1, failed: 1})

    let receivedCandidate: unknown
    rtc.onicecandidate = function ice(event) { receivedCandidate = event.candidate }
    Reflect.apply(resource.connection.onicecandidate!, resource.connection, [{candidate}])
    assert.equal(receivedCandidate, candidate)
    let incoming = 0
    rtc.ondatachannel = function incomingChannel(event) { event.channel.send('incoming'); incoming++ }
    Reflect.apply(resource.connection.ondatachannel!, resource.connection, [{channel: resource.channel}])
    assert.equal(incoming, 1)
    assert.equal(resource.sent.at(-1), 'incoming')
    data.close()
    rtc.close()
    assert.deepEqual(resource.closed(), {channel: 1, connection: 1})
})
