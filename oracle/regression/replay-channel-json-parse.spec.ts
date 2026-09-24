import assert from 'node:assert/strict'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from '../../src/Common/events/replay-channel'
import {runOracle} from '../run-oracle'

// A JSON peer's messages are parsed with a reviver that turns byte markers
// ({"__wenayReplayBytes": base64}) back into Uint8Array. Most messages carry no
// marker, and the reviver costs more than the parse. Skipping it must never
// change a parsed message: markers, escaped markers, look-alikes and hostile
// keys all come out exactly as the reviver made them.

const MARKER = '__wenayReplayBytes'

// ============================================================
// Reference: the historical parse (replay-channel.ts parseMessage in 3.0.1)
// ============================================================

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function referenceBase64ToBytes(text: string) {
    const clean = text.replace(/=+$/, '')
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
    let bits = 0
    let nBits = 0
    let at = 0
    for (const char of clean) {
        const n = BASE64.indexOf(char)
        if (n < 0) throw new Error('replay channel: invalid binary payload')
        bits = (bits << 6) | n
        nBits += 6
        if (nBits < 8) continue
        nBits -= 8
        out[at++] = (bits >> nBits) & 255
    }
    return out
}

function referenceParse(raw: string) {
    return JSON.parse(raw, function decodeReplayBytes(_key, item) {
        if (item != null && typeof item == 'object' && Object.keys(item).length == 1 && typeof item[MARKER] == 'string') {
            return referenceBase64ToBytes(item[MARKER])
        }
        return item
    })
}

// ============================================================
// Harness: raw text straight into a client, and into a server
// ============================================================

function createClient() {
    const toClient = new Set<(data: string) => void>()
    const channel: ReplayMessageChannel = {
        send() {},
        onMessage(cb) { toClient.add(cb); return () => toClient.delete(cb) },
    }
    const remote = channelReplayRemote<any[]>(channel)
    const got: unknown[] = []
    remote.line.on(ev => got.push(ev))
    return {
        got,
        deliver(raw: string) { for (const cb of [...toClient]) cb(raw) },
    }
}

function evs(...events: string[]) {
    return `{"t":"evs","evs":[${events.join(',')}]}`
}

function envelope(seq: number, eventJson: string) {
    return `{"seq":${seq},"ts":${seq},"event":[${eventJson}]}`
}

function tickJson(index: number) {
    return JSON.stringify({symbol: 'SYM' + (index % 50), price: 100 + index * 0.25, qty: index % 17, side: index % 2 ? 'buy' : 'sell', ts: 1727000000000 + index})
}

const CORPUS: Record<string, string> = {
    'ticks, no marker': evs(...Array.from({length: 8}, (_, index) => envelope(index + 1, tickJson(index)))),
    'bytes marker': evs(envelope(1, `{"frame":{"${MARKER}":"AAECAwT/"},"n":1}`)),
    'empty bytes as the whole event': evs(envelope(1, `{"${MARKER}":""}`)),
    'marker spelled with a \\u escape': evs(envelope(1, `{"${MARKER.slice(0, -1)}\\u0073":"AQID"}`)),
    'marker text only inside a string': evs(envelope(1, `{"note":"${MARKER}"}`)),
    'marker with a second key': evs(envelope(1, `{"${MARKER}":"AQID","x":1}`)),
    'marker with a number': evs(envelope(1, `{"${MARKER}":5}`)),
    'control characters escaped': evs(envelope(1, JSON.stringify({text: 'a\u0001b\u001f', tab: 'x\ty'}))),
    'lone surrogate escaped': evs(envelope(1, JSON.stringify({text: 'a\uD800b'}))),
    'quotes and backslashes': evs(envelope(1, JSON.stringify({text: 'say "hi" \\ bye', path: 'C:\\x'}))),
    '__proto__ and constructor keys': evs(envelope(1, '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}')),
    'deep arrays': evs(envelope(1, '[[[[[[1,[2,[3]]]]]]]]')),
    'unicode text': evs(envelope(1, JSON.stringify({text: 'Привет 🌍'}))),
    'single event message': `{"t":"ev","ev":${envelope(7, '{"k":1}')}}`,
}

function checkParseMatchesReference() {
    for (const [name, raw] of Object.entries(CORPUS)) {
        const client = createClient()
        client.deliver(raw)
        const reference = referenceParse(raw)
        const expected = reference.t == 'evs' ? reference.evs : [reference.ev]
        assert.deepEqual(client.got, expected, name)
    }
    assert.equal(({} as any).polluted, undefined, 'no prototype pollution')
    // The escaped marker is still a marker, exactly as the reviver saw it.
    const escaped = createClient()
    escaped.deliver(CORPUS['marker spelled with a \\u escape'])
    assert.ok((escaped.got[0] as any).event[0] instanceof Uint8Array)
}

function checkInvalidMarkerDropsTheMessage() {
    const client = createClient()
    client.deliver(evs(envelope(1, `{"${MARKER}":"not base64!"}`)))
    client.deliver(evs(envelope(2, '{"after":true}')))
    assert.deepEqual((client.got as any[]).map(ev => ev.seq), [2], 'an undecodable marker drops its message, as before')
}

async function checkServerParsesRequestBytes() {
    // The server parses JSON-peer requests the same way: bytes in a frame hint survive.
    const toServer = new Set<(data: string) => void>()
    const sent: string[] = []
    let hint: unknown
    const source: any = {
        line: {on() { return function offLine() {} }},
        since: () => null,
        keyframe: () => null,
        frame(_seq: number, received: unknown) { hint = received; return null },
    }
    const stop = serveReplayChannel(source, {
        send(data) { sent.push(data) },
        onMessage(cb) { toServer.add(cb); return () => toServer.delete(cb) },
    })
    try {
        for (const cb of [...toServer]) cb(`{"t":"req","id":1,"m":"frame","a":[3,{"key":{"${MARKER}":"AQID"},"plain":"${MARKER}"}]}`)
        await new Promise(resolve => setTimeout(resolve, 5))
        assert.deepEqual(hint, {key: Uint8Array.from([1, 2, 3]), plain: MARKER})
        assert.equal(JSON.parse(sent[0]).t, 'res')
    } finally { stop() }
}

// ============================================================
// Cost: no reviver pass over a message without markers
// ============================================================

function checkMarkerFreeMessageSkipsReviver() {
    const raw = evs(...Array.from({length: 64}, (_, index) => envelope(index + 1, tickJson(index))))
    const client = createClient()
    const original = Object.keys
    let calls = 0
    Object.keys = function countingKeys(value: object) {
        calls++
        return original(value)
    } as typeof Object.keys
    try { client.deliver(raw) }
    finally { Object.keys = original }
    assert.equal(client.got.length, 64)
    assert.equal(calls, 0, `reviver object visits for 64 ticks without markers: ${calls}`)

    const rounds = 2_000
    const started = performance.now()
    for (let round = 0; round < rounds; round++) client.deliver(raw)
    const perMessage = (performance.now() - started) * 1000 / rounds
    const referenceStarted = performance.now()
    for (let round = 0; round < rounds; round++) referenceParse(raw)
    const referencePerMessage = (performance.now() - referenceStarted) * 1000 / rounds
    console.log(`    64-tick JSON message: ${perMessage.toFixed(1)} us delivered, reviver parse alone ${referencePerMessage.toFixed(1)} us`)
    assert.ok(perMessage < referencePerMessage * 3, 'wide bound: delivering costs less than three reviver parses')
}

async function runChecks() {
    let failures = 0
    const checks = [
        checkParseMatchesReference,
        checkInvalidMarkerDropsTheMessage,
        checkServerParsesRequestBytes,
        checkMarkerFreeMessageSkipsReviver,
    ]
    for (const check of checks) {
        try {
            await check()
            console.log(`PASS ${check.name}`)
        } catch (error) {
            failures++
            console.error(`FAIL ${check.name}: ${(error as Error)?.message ?? error}`)
        }
    }
    if (failures) {
        console.error(`${failures} replay channel JSON parse checks failed`)
        process.exit(1)
    }
    console.log('PASS replay channel JSON parse: identical results with and without byte markers, no reviver pass without one')
}

async function main() {
    await runChecks().catch(function fail(error) {
        console.error('FAIL', error)
        process.exit(1)
    })
}

runOracle(main)
