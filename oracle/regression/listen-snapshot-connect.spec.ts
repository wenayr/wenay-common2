import assert from 'node:assert/strict'
import {listenSnapshot} from '../../src/Common/events/SocketBuffer'

// listenSnapshot connects its source for the first subscriber and after every
// reconnect, and data the source pushes while connecting reaches that subscriber.

function createSource(options: {failFirstConnect?: boolean} = {}) {
    const stats = {connects: 0, disconnects: 0}
    let failNext = options.failFirstConnect == true
    function source(args: {callback: (data: number) => void}) {
        if (failNext) {
            failNext = false
            throw new Error('connect failed')
        }
        stats.connects++
        args.callback(40 + stats.connects) // pushed synchronously while connecting
        return function disconnect() { stats.disconnects++ }
    }
    const snap = listenSnapshot({
        func: () => source as any,
        callbackSave: (data: any) => [data] as [number],
        memo: {} as any,
    })
    return {snap, stats}
}

function checkFirstSubscriberConnects() {
    const {snap, stats} = createSource()
    const received: number[] = []
    const off = snap.run(function first(value: any) { received.push(value) })
    assert.equal(stats.connects, 1, 'the first subscriber connects the source')
    assert.deepEqual(received, [41], 'data pushed while connecting reaches the first subscriber')
    off()
    assert.equal(stats.disconnects, 1, 'the last subscriber disconnects it')
}

function checkReconnectKeepsConnectData() {
    const {snap, stats} = createSource()
    snap.run(function first() {})()
    const received: number[] = []
    const off = snap.run(function second(value: any) { received.push(value) })
    assert.equal(stats.connects, 2, 'a new subscriber after the last one left reconnects')
    assert.deepEqual(received, [42], 'data pushed while reconnecting reaches the new subscriber')
    off()
}

function checkFailedConnectLeavesNoSubscriber() {
    const {snap, stats} = createSource({failFirstConnect: true})
    assert.throws(function subscribe() { snap.run(function never() {}) }, /connect failed/)
    assert.equal(snap.listenA.count(), 0, 'a failed connect leaves no subscriber behind')
    const received: number[] = []
    const off = snap.run(function retry(value: any) { received.push(value) })
    assert.equal(stats.connects, 1, 'the next subscriber connects again')
    assert.deepEqual(received, [41])
    off()
}

let failures = 0
const checks = [
    checkFirstSubscriberConnects,
    checkReconnectKeepsConnectData,
    checkFailedConnectLeavesNoSubscriber,
]
for (const check of checks) {
    try {
        check()
        console.log(`PASS ${check.name}`)
    } catch (error) {
        failures++
        console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
    }
}
if (failures) {
    console.error(`${failures} listenSnapshot connect checks failed`)
    process.exit(1)
}
console.log('PASS listenSnapshot: first and returning subscribers connect the source and see its connect-time data')
