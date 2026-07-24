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
    batch?: boolean;
};
export declare function createArtifactClient(deps: ArtifactClientDeps): {
    store: import("../Observe/store").Store<ArtifactStore>;
    ready: Promise<void>;
    seq: () => number;
    stateMode: () => import("../Observe/store-replay").tStoreReplayMode;
    open: (artifactId: string) => Promise<ArtifactOpenInstruction>;
    revoke: (artifactId: string) => Promise<ArtifactRecord>;
    close(): void;
};
export type ArtifactClient = ReturnType<typeof createArtifactClient>;
