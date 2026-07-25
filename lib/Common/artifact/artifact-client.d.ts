import { StoreDrain } from '../Observe/store';
import { StoreReplayRemote } from '../Observe/store-replay';
import { ArtifactOpenInstruction, ArtifactRecord, ArtifactStore } from './artifact-host';
export type ArtifactRemote = {
    state: StoreReplayRemote;
    open: (artifactId: string) => ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>;
    revoke: (artifactId: string) => ArtifactRecord | Promise<ArtifactRecord>;
};
export type ArtifactClientDeps = {
    remote: ArtifactRemote;
    initial?: ArtifactStore;
    drain?: StoreDrain;
};
export declare function createArtifactClient(deps: ArtifactClientDeps): {
    store: import("../Observe").Store<ArtifactStore>;
    ready: Promise<void>;
    seq: () => number;
    stateMode: () => "v2";
    open: (artifactId: string) => Promise<ArtifactOpenInstruction>;
    revoke: (artifactId: string) => Promise<ArtifactRecord>;
    close(): void;
};
export type ArtifactClient = ReturnType<typeof createArtifactClient>;
