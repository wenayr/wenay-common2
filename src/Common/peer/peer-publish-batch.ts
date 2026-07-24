import {rpcResultWireByteLength, rpcResultWireMetrics} from '../rcp/rpc-wire-size'

export const PEER_PUBLISH_BATCH_MAX_ITEMS = 64
export const PEER_PUBLISH_BATCH_MAX_BYTES = 64 * 1024

export function peerPublishBatchBytes(envelopes: readonly unknown[]) {
    return rpcResultWireByteLength(envelopes)
}

/** @internal A byte proof produced while partitioning; the relay never trusts this client-side value. */
export type tMeasuredPeerPublishBatch<T> = {
    items: T[]
    byteLength: number
}

/** @internal One measured partitioner serves repair tails and the live micro-queue. */
export function createMeasuredPeerPublishBatchQueue<T>(deps: {
    emit: (batch: tMeasuredPeerPublishBatch<T>) => void
    schedule?: (run: () => void) => void
}) {
    const {emit, schedule} = deps
    let batch: T[] = []
    let batchBytes = 2
    let batchBinaryCount = 0
    let scheduled = false
    let closed = false

    function flush() {
        if (batch.length == 0) return
        const ready = {
            items: batch,
            byteLength: batchBytes,
        }
        batch = []
        batchBytes = 2
        batchBinaryCount = 0
        emit(ready)
    }

    function measureItem(item: T) {
        const metrics = rpcResultWireMetrics([item], batchBinaryCount)
        return {
            byteLength: metrics.byteLength - 2,
            binaryCount: metrics.binaryCount,
        }
    }

    function push(item: T) {
        if (closed) return
        let itemMetrics = measureItem(item)
        let candidateBytes = batchBytes + (batch.length > 0 ? 1 : 0) + itemMetrics.byteLength
        if (batch.length > 0 && (batch.length >= PEER_PUBLISH_BATCH_MAX_ITEMS ||
            candidateBytes > PEER_PUBLISH_BATCH_MAX_BYTES)) {
            flush()
            itemMetrics = measureItem(item)
            candidateBytes = batchBytes + itemMetrics.byteLength
        }
        batch.push(item)
        batchBytes = candidateBytes
        batchBinaryCount += itemMetrics.binaryCount
        if (batch.length >= PEER_PUBLISH_BATCH_MAX_ITEMS || candidateBytes >= PEER_PUBLISH_BATCH_MAX_BYTES) {
            flush()
            return
        }
        if (scheduled || !schedule) return
        scheduled = true
        schedule(function flushScheduledPeerPublishBatch() {
            scheduled = false
            flush()
        })
    }

    function close() {
        if (closed) return
        flush()
        closed = true
    }

    return {push, flush, close}
}

/** One bounded partitioner serves callers that only need the original array batches. */
export function createPeerPublishBatchQueue<T>(deps: {
    emit: (batch: T[]) => void
    schedule?: (run: () => void) => void
}) {
    const {emit, schedule} = deps
    return createMeasuredPeerPublishBatchQueue<T>({
        emit(batch) { emit(batch.items) },
        schedule,
    })
}

/** @internal Carries the already-paid byte measurement into the Peer client send path. */
export function splitMeasuredPeerPublishEnvelopes<T>(envelopes: readonly T[]) {
    const batches: Array<tMeasuredPeerPublishBatch<T>> = []
    const queue = createMeasuredPeerPublishBatchQueue<T>({
        emit(batch) { batches.push(batch) },
    })
    for (const envelope of envelopes) queue.push(envelope)
    queue.close()
    return batches
}

export function splitPeerPublishEnvelopes<T>(envelopes: readonly T[]) {
    return splitMeasuredPeerPublishEnvelopes(envelopes).map(batch => batch.items)
}
