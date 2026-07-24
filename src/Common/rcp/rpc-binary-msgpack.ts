// =====================================================================
// Universal RPC MessagePack value codec
// =====================================================================

import {addExtension, Packr, Unpackr} from 'msgpackr'
import {
    createRpcBinaryCallbackRef,
    RpcBinaryCallbackRefValue,
    rpcBinaryCallbackRefId,
} from './rpc-binary-value'

const RPC_MSGPACK_CALLBACK_REF_EXTENSION = 63

addExtension({
    Class: RpcBinaryCallbackRefValue as any,
    type: RPC_MSGPACK_CALLBACK_REF_EXTENSION,
    write(value) {
        return rpcBinaryCallbackRefId(value)
    },
    read(id) {
        return createRpcBinaryCallbackRef(id as number)
    },
})

export function createRpcBinaryMsgpackCodec({
    maxWireBytes,
}: {
    maxWireBytes: number
}) {
    const encoder = new Packr({
        useRecords: true,
        moreTypes: true,
        writeFunction() {
            throw new TypeError('function values are not supported')
        },
    })
    const decoder = new Unpackr({
        useRecords: true,
        moreTypes: true,
        copyBuffers: true,
    })
    let encodedFrames = 0
    let decodedFrames = 0
    let encodedBytes = 0
    let decodedBytes = 0

    function encode(value: unknown) {
        const wire = encoder.pack(value)
        if (wire.byteLength > maxWireBytes) {
            throw new RangeError('RPC msgpack value: encoded frame exceeds binary limit')
        }
        encodedFrames++
        encodedBytes += wire.byteLength
        return wire
    }

    function decode(wire: Uint8Array) {
        if (wire.byteLength > maxWireBytes) {
            throw new RangeError('RPC msgpack value: encoded frame exceeds binary limit')
        }
        const source = Object.isExtensible(wire)
            ? wire
            : new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength)
        const value = decoder.unpack(source)
        decodedFrames++
        decodedBytes += wire.byteLength
        return value
    }

    function measure(value: unknown) {
        return encoder.pack(value).byteLength
    }

    function stats() {
        return {
            encodedFrames,
            decodedFrames,
            encodedBytes,
            decodedBytes,
        }
    }

    function reset() {
        encodedFrames = 0
        decodedFrames = 0
        encodedBytes = 0
        decodedBytes = 0
    }

    return {
        encode,
        decode,
        measure,
        stats,
        reset,
    }
}

export type RpcBinaryMsgpackCodec = ReturnType<typeof createRpcBinaryMsgpackCodec>
