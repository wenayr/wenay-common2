// Focused Store Replay release benchmark: legacy JSON, v2 JSON and v7 binary.

import {isDeepStrictEqual} from 'node:util'
import {performance} from 'node:perf_hooks'
import {ReplayEvent} from '../src/Common/events/replay-listen'
import {
    inspectRpcBinaryEnvelope,
    RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
} from '../src/Common/rcp/rpc-binary-envelope'
import {createRpcBinaryPeer} from '../src/Common/rcp/rpc-binary-peer'
import {RPC_BINARY_MAX_SHAPES} from '../src/Common/rcp/rpc-caps'
import {Pkt} from '../src/Common/rcp/rpc-protocol'
import {StorePatch} from '../src/Common/Observe/store'
import {
    decodeStoreReplayBatchV2,
    encodeStoreReplayBatchV2,
} from '../src/Common/Observe/store-replay-codec'
import {createStoreReplayMsgpackCodec} from '../src/Common/Observe/store-replay-msgpack'

type tEvent = ReplayEvent<[StorePatch[]]>
type tLegacyEvent = ReplayEvent<[StorePatch]>
type tWorkload = {
    name: string
    event: tEvent
    rounds: number
    legacyEvents: tLegacyEvent[]
}
type tRoute = {
    encode(event: tEvent, legacyEvents: tLegacyEvent[]): unknown
    decode(wire: any): StorePatch[]
    bytes(wire: any): number
    messages(wire: any): number
}

function createOuterPair() {
    const sender = createRpcBinaryPeer({
        sessionId: 1,
        maxShapes: RPC_BINARY_MAX_SHAPES,
        protocolVersion: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
    })
    const receiver = createRpcBinaryPeer({
        sessionId: 1,
        maxShapes: RPC_BINARY_MAX_SHAPES,
        protocolVersion: RPC_BINARY_SCHEMA_PROTOCOL_VERSION,
    })
    receiver.decodePrelude(sender.encodePrelude())

    function encode(value: unknown) {
        const prepared = sender.prepare([Pkt.CB, 1, [value]])
        prepared.commit()
        return prepared.wire
    }

    function decode(wire: Uint8Array) {
        const envelope = inspectRpcBinaryEnvelope(wire)
        if (envelope?.version != RPC_BINARY_SCHEMA_PROTOCOL_VERSION) {
            throw new Error('V7 benchmark expected an RPB/2 packet')
        }
        return receiver.decode(envelope.payload)[2][0]
    }

    return {encode, decode}
}

function callbackJson(value: unknown) {
    return JSON.stringify([Pkt.CB, 1, [value]])
}

function callbackJsonValue(wire: string) {
    return JSON.parse(wire)[2][0]
}

function createLegacyRoute(): tRoute {
    function encode(_event: tEvent, legacyEvents: tLegacyEvent[]) {
        return legacyEvents.map(callbackJson)
    }

    function decode(wires: string[]) {
        return wires.map(function decodeLegacyWire(wire) {
            return callbackJsonValue(wire).event[0] as StorePatch
        })
    }

    return {
        encode,
        decode,
        bytes(wires: string[]) {
            return wires.reduce(function addLegacyBytes(total, wire) {
                return total + Buffer.byteLength(wire)
            }, 0)
        },
        messages: (wires: string[]) => wires.length,
    }
}

function createV2Route(): tRoute {
    function encode(event: tEvent) {
        return callbackJson(encodeStoreReplayBatchV2(event))
    }

    function decode(wire: string) {
        return decodeStoreReplayBatchV2(callbackJsonValue(wire)).event[0]
    }

    return {
        encode,
        decode,
        bytes: (wire: string) => Buffer.byteLength(wire),
        messages: () => 1,
    }
}

function createV7Route(): tRoute {
    const outer = createOuterPair()
    const sender = createStoreReplayMsgpackCodec()
    const receiver = createStoreReplayMsgpackCodec()

    function encode(event: tEvent) {
        return outer.encode(sender.encode(event))
    }

    function decode(wire: Uint8Array) {
        return receiver.decode(outer.decode(wire)).event[0]
    }

    return {
        encode,
        decode,
        bytes: (wire: Uint8Array) => wire.byteLength,
        messages: () => 1,
    }
}

function measureStableUs(rounds: number, run: () => void) {
    for (let window = 0; window < 2; window++) {
        for (let index = 0; index < rounds; index++) run()
    }
    const samples = new Array<number>(7)
    for (let window = 0; window < samples.length; window++) {
        const started = performance.now()
        for (let index = 0; index < rounds; index++) run()
        samples[window] = (performance.now() - started) * 1_000 / rounds
    }
    samples.sort((left, right) => left - right)
    return samples[Math.floor(samples.length / 2)]
}

function measureRoute(
    workload: tWorkload,
    routeName: string,
    createRoute: () => tRoute,
) {
    const route = createRoute()
    let wire = route.encode(workload.event, workload.legacyEvents)
    let decoded = route.decode(wire)
    if (!isDeepStrictEqual(decoded, workload.event.event[0])) {
        throw new Error(workload.name + '/' + routeName + ' cold round-trip mismatch')
    }
    const coldBytes = route.bytes(wire)

    for (let index = 0; index < 20; index++) {
        wire = route.encode(workload.event, workload.legacyEvents)
        decoded = route.decode(wire)
    }
    if (!isDeepStrictEqual(decoded, workload.event.event[0])) {
        throw new Error(workload.name + '/' + routeName + ' warm round-trip mismatch')
    }

    let sink: unknown
    const encodeUs = measureStableUs(workload.rounds, function encodeRound() {
        sink = route.encode(workload.event, workload.legacyEvents)
    })
    const decodeUs = measureStableUs(workload.rounds, function decodeRound() {
        sink = route.decode(wire)
    })
    if (sink == undefined) throw new Error(workload.name + '/' + routeName + ' missing result')

    return {
        workload: workload.name,
        route: routeName,
        rounds: workload.rounds,
        messages: route.messages(wire),
        coldBytes,
        warmBytes: route.bytes(wire),
        encodeUs,
        decodeUs,
        totalUs: encodeUs + decodeUs,
    }
}

function createUpdateWorkload(items: number, rounds: number): tWorkload {
    const patches = Array.from({length: items}, function createPatch(_, index) {
        return {
            path: ['S' + String(index).padStart(5, '0')],
            exists: true,
            value: {
                c: index + 0.5,
                t: 1_000_000 + index,
                active: index % 2 == 0,
                venue: 'spot',
            },
        }
    })
    const event = {seq: items, ts: 1, event: [patches] as [StorePatch[]]}
    const legacyEvents = patches.map(function createLegacyEvent(patch, index) {
        return {
            seq: index + 1,
            ts: 1,
            event: [patch] as [StorePatch],
        }
    })
    return {
        name: items + ' updates',
        event,
        rounds,
        legacyEvents,
    }
}

function createKeyframeWorkload(items: number, rounds: number): tWorkload {
    const root: Record<string, unknown> = {}
    for (let index = 0; index < items; index++) {
        root['S' + String(index).padStart(5, '0')] = {
            c: index + 0.5,
            t: 1_000_000 + index,
        }
    }
    const patch = {path: [], exists: true, value: root} satisfies StorePatch
    const event = {seq: 1, ts: 1, event: [[patch]] as [StorePatch[]]}
    return {
        name: items + ' keyframe',
        event,
        rounds,
        legacyEvents: [{seq: 1, ts: 1, event: [patch]}],
    }
}

const routes = [
    ['legacy-json', createLegacyRoute],
    ['v2-json', createV2Route],
    ['v7-binary', createV7Route],
] as const

const workloads = [
    createUpdateWorkload(1, 40_000),
    createUpdateWorkload(10, 10_000),
    createUpdateWorkload(50, 4_000),
    createUpdateWorkload(250, 1_000),
    createKeyframeWorkload(15_000, 20),
]

const rows = workloads.flatMap(function measureWorkload(workload) {
    return routes.map(function measureNamedRoute([name, createRoute]) {
        return measureRoute(workload, name, createRoute)
    })
})

console.log('\nFocused Store Replay benchmark')
const bun = (globalThis as any).Bun
console.log(bun == undefined
    ? process.release.name + ' ' + process.version
    : 'bun ' + bun.version)
console.log('CPU is median of seven windows after two warm-up windows.')
console.table(rows.map(function displayRow(row) {
    return {
        workload: row.workload,
        route: row.route,
        rounds: row.rounds,
        messages: row.messages,
        coldB: row.coldBytes,
        warmB: row.warmBytes,
        encodeUs: row.encodeUs.toFixed(2),
        decodeUs: row.decodeUs.toFixed(2),
        totalUs: row.totalUs.toFixed(2),
    }
}))
