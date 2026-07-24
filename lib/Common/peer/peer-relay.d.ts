import { ReplayEvent } from '../events/replay-listen';
import { ReplayRemote } from '../events/replay-wire';
import { StorePatch } from '../Observe/store';
export type PatchEnvelope = ReplayEvent<[StorePatch]>;
export type tRelayGap = 'resume' | 'sacred';
export type RelayPushResult = boolean | {
    seq: number;
};
export declare function createPatchRelayJournal(opts?: {
    history?: number;
    gap?: tRelayGap;
}): {
    push: (env: PatchEnvelope) => RelayPushResult;
    pushBatch: (envelopes: PatchEnvelope[]) => RelayPushResult;
    remote: ReplayRemote<[StorePatch]> & {
        seq: () => number;
    };
    gap: tRelayGap;
    seq: () => number;
    snapshot: () => any;
    close: () => void;
};
export type PatchRelayJournal = ReturnType<typeof createPatchRelayJournal>;
