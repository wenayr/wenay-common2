export declare const PEER_PUBLISH_BATCH_MAX_ITEMS = 64;
export declare const PEER_PUBLISH_BATCH_MAX_BYTES: number;
export declare function peerPublishBatchBytes(envelopes: readonly unknown[]): number;
export type tMeasuredPeerPublishBatch<T> = {
    items: T[];
    byteLength: number;
};
export declare function createMeasuredPeerPublishBatchQueue<T>(deps: {
    emit: (batch: tMeasuredPeerPublishBatch<T>) => void;
    schedule?: (run: () => void) => void;
}): {
    push: (item: T) => void;
    flush: () => void;
    close: () => void;
};
export declare function createPeerPublishBatchQueue<T>(deps: {
    emit: (batch: T[]) => void;
    schedule?: (run: () => void) => void;
}): {
    push: (item: T) => void;
    flush: () => void;
    close: () => void;
};
export declare function splitMeasuredPeerPublishEnvelopes<T>(envelopes: readonly T[]): tMeasuredPeerPublishBatch<T>[];
export declare function splitPeerPublishEnvelopes<T>(envelopes: readonly T[]): T[][];
