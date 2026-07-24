import { ReplayRemote } from '../events/replay-wire';
export declare function readPeerRelaySeq(node: {
    seq?: () => number | Promise<number>;
} | undefined): Promise<number>;
export declare function readPeerRelayFrame<Z extends any[]>(remote: ReplayRemote<Z>, seq: number, hint?: unknown): Promise<import("../events/replay-listen").ReplayEvent<Z>[] | null | undefined>;
