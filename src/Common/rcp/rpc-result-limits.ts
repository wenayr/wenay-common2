import type {RpcLimits} from './rpc-limits'

// Internal proxy metadata lets an opaque binary result apply the same client
// policy that the ordinary RPC result walker already enforced.
const RPC_RESULT_LIMITS = Symbol.for('wenay-common2.rpc.resultLimits')

export function rpcResultLimitsProperty(property: PropertyKey) {
    return property == RPC_RESULT_LIMITS
}

export function getRpcResultLimits(value: unknown) {
    if ((typeof value != 'object' || value == null) && typeof value != 'function') return undefined
    return (value as {[RPC_RESULT_LIMITS]?: Required<RpcLimits>})[RPC_RESULT_LIMITS]
}
