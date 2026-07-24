import {isDeepStrictEqual} from 'node:util'
import {
    inspectRpcBinaryEnvelope,
    RPC_BINARY_MSGPACK_PROTOCOL_VERSION,
} from './rpc-binary-envelope'
import {createRpcBinaryPeer} from './rpc-binary-peer'
import {
    createRpcBinaryCallbackRef,
    rpcBinaryCallbackRefId,
} from './rpc-binary-value'
import {Pkt} from './rpc-protocol'

export async function runRpcBinaryMsgpackTests() {
    let fails = 0

    function ok(condition: unknown, message: string) {
        if (!condition) {
            fails++
            console.log('FAIL  ' + message)
            return
        }
        console.log('PASS  ' + message)
    }

    function createPair() {
        const sender = createRpcBinaryPeer({
            sessionId: 71,
            maxShapes: 1_000,
            protocolVersion: RPC_BINARY_MSGPACK_PROTOCOL_VERSION,
        })
        const receiver = createRpcBinaryPeer({
            sessionId: 71,
            maxShapes: 1_000,
            protocolVersion: RPC_BINARY_MSGPACK_PROTOCOL_VERSION,
        })

        function roundTrip(packet: any[]) {
            const prepared = sender.prepare(packet)
            const envelope = inspectRpcBinaryEnvelope(prepared.wire)
            if (!envelope) throw new Error('missing msgpack RPC envelope')
            const decoded = receiver.decode(envelope.payload)
            prepared.commit()
            return {wire: prepared.wire, envelope, decoded}
        }

        return {roundTrip}
    }

    console.log('\n--- RPC universal msgpack v3 ---')
    const pair = createPair()
    const callbackRef = createRpcBinaryCallbackRef(91)
    const call = pair.roundTrip([
        Pkt.CALL,
        7,
        'quote',
        [{
            symbol: 'BTCUSDT',
            price: 67_123.5,
            active: true,
            source: null,
            callback: callbackRef,
        }],
        true,
    ])
    ok(call.envelope.version == RPC_BINARY_MSGPACK_PROTOCOL_VERSION
        && call.wire instanceof Uint8Array,
    'CALL is one RPB/3 Uint8Array')
    ok(rpcBinaryCallbackRefId(call.decoded[3][0].callback) == 91,
        'CALL callback reference keeps its private identity')

    const rich = {
        falseValue: false,
        trueValue: true,
        nullValue: null,
        undefinedValue: undefined,
        integer: 42,
        decimal: 42.5,
        text: 'котировка 🚀\u0000',
        bigint: 9_007_199_254_740_993n,
        date: new Date(1_700_000_000_123),
        regexp: /quote/giu,
        map: new Map([['desk', new Set(['spot', 'fast'])]]),
        bytes: new Uint8Array([1, 2, 3, 4]),
    }
    const response = pair.roundTrip([Pkt.RESP, 7, rich])
    ok(isDeepStrictEqual(response.decoded, [Pkt.RESP, 7, rich]),
        'RESP preserves representative primitive, rich and binary values')

    const callbacks = pair.roundTrip([
        Pkt.CB_BATCH,
        [
            [Pkt.CB, 3, [rich]],
            [Pkt.CB, 3, [1]],
            [Pkt.CB_END, 3],
        ],
    ])
    ok(isDeepStrictEqual(callbacks.decoded, [
        Pkt.CB_BATCH,
        [
            [Pkt.CB, 3, [rich]],
            [Pkt.CB, 3, [1]],
            [Pkt.CB_END, 3],
        ],
    ]), 'callback batch and callback end use the same msgpack codec')

    const error = {
        name: 'Error',
        message: 'boom',
        code: 'E_QUOTE',
        data: rich,
    }
    const errorResponse = pair.roundTrip([Pkt.RESP, 8, null, error])
    ok(isDeepStrictEqual(errorResponse.decoded, [Pkt.RESP, 8, null, error]),
        'error DTO uses the same msgpack codec')

    const sparse = new Array<unknown>(3)
    sparse[1] = 'middle'
    const normalized = pair.roundTrip([Pkt.RESP, 9, {
        negativeZero: -0,
        sparse,
    }]).decoded[2]
    ok(Object.is(normalized.negativeZero, 0)
        && normalized.sparse.length == 3
        && normalized.sparse[1] == 'middle',
    'documented scalar -0 and sparse-array normalization stays bounded')

    for (const fields of [5, 8, 16, 30]) {
        const value: Record<string, unknown> = {}
        for (let index = 0; index < fields; index++) {
            value['field' + index] = index % 4 == 0
                ? index + 0.5
                : index % 4 == 1
                    ? 'value-' + index
                    : index % 4 == 2
                        ? index % 2 == 0
                        : null
        }
        const first = pair.roundTrip([Pkt.CB, fields, [value]])
        const second = pair.roundTrip([Pkt.CB, fields, [value]])
        ok(isDeepStrictEqual(first.decoded, second.decoded)
            && isDeepStrictEqual(second.decoded[2][0], value),
        fields + '-field repeated response round-trips after warm-up')
    }

    return fails
}
