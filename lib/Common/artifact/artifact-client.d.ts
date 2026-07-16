import { StoreDrain } from '../Observe/store';
import { ReplayRemote } from '../events/replay-wire';
import { ArtifactOpenInstruction, ArtifactRecord, ArtifactStore } from './artifact-host';
export type ArtifactRemote = {
    state: ReplayRemote<any>;
    open: (artifactId: string) => ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>;
    revoke: (artifactId: string) => ArtifactRecord | Promise<ArtifactRecord>;
};
export type ArtifactClientDeps = {
    remote: ArtifactRemote;
    initial?: ArtifactStore;
    drain?: StoreDrain;
};
export declare function createArtifactClient(deps: ArtifactClientDeps): {
    store: import("../Observe/store").Store<ArtifactStore>;
    ready: Promise<void>;
    seq: () => number;
    open: (artifactId: string) => Promise<ArtifactOpenInstruction>;
    revoke: (artifactId: string) => Promise<ArtifactRecord>;
    close(): void;
};
export type ArtifactClient = ReturnType<typeof createArtifactClient>;
