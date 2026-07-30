// =====================================================================
// Internal replay-wire metadata for automatic RPC backpressure gates
// =====================================================================

export const RPC_REPLAY_WIRE_SOURCE = Symbol.for('wenay-common2.rpc.replayWireSource')

export type RpcReplayWireSource = {
    head: () => number
    sequenceOf: (event: unknown) => number | undefined
}

export function brandRpcReplayWire<T extends object>(facade: T, source: RpcReplayWireSource) {
    Object.defineProperty(facade, RPC_REPLAY_WIRE_SOURCE, {value: source})
    return facade
}

export function getRpcReplayWireSource(value: any) {
    if (value == null || typeof value != 'object') return undefined
    const source = Object.getOwnPropertyDescriptor(value, RPC_REPLAY_WIRE_SOURCE)?.value
    if (source == null || typeof source != 'object'
        || typeof source.head != 'function' || typeof source.sequenceOf != 'function') return undefined
    return source as RpcReplayWireSource
}

export function retransmitRpcReplayWire<T extends object>(source: object, facade: T) {
    const replaySource = getRpcReplayWireSource(source)
    return replaySource ? brandRpcReplayWire(facade, replaySource) : facade
}
