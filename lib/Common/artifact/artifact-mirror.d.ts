import { Store, StoreDrain } from '../Observe/store';
import { ArtifactOpenInstruction, ArtifactPolicy, ArtifactRecord, ArtifactStore } from './artifact-host';
export type ArtifactMirrorDeps = {
    catalog: Store<ArtifactStore>;
    policy?: Pick<ArtifactPolicy, 'canRead' | 'canRevoke'>;
    open: (input: {
        artifact: ArtifactRecord;
        account: string;
    }) => Promise<ArtifactOpenInstruction> | ArtifactOpenInstruction;
    revoke?: (account: string, artifactId: string) => Promise<ArtifactRecord> | ArtifactRecord;
    history?: number;
    drain?: StoreDrain;
    now?: () => number;
};
export declare function createArtifactMirror(deps: ArtifactMirrorDeps): {
    connection: (account: string) => {
        fragment: {
            state: {
                line: {
                    on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                };
                since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                } | undefined;
            } | {
                line: {
                    on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                };
                since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                frameLine?: {
                    on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                } | undefined;
                describe: () => Record<string, any>;
            };
            open: (artifactId: string) => Promise<{
                url: string;
                expiresAt: number;
            }>;
            revoke: (artifactId: string) => Promise<ArtifactRecord>;
        };
        close: () => void;
    };
    close(): void;
};
export type ArtifactMirror = ReturnType<typeof createArtifactMirror>;
