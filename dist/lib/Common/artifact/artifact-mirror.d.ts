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
            state: import("../events/replay-wire").ReplayExpose<[import("../Observe/store").StorePatch]>;
            open: (artifactId: string) => Promise<{
                url: string;
                expiresAt: number;
            }>;
            revoke: (artifactId: string) => Promise<ArtifactRecord>;
        };
        close(): void;
    };
    close(): void;
};
export type ArtifactMirror = ReturnType<typeof createArtifactMirror>;
