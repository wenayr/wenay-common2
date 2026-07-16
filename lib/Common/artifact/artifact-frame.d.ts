import { ArtifactClient } from './artifact-client';
import { ArtifactOpenInstruction, ArtifactRecord } from './artifact-host';
export type ArtifactFrame = {
    src: string;
    setAttribute: (name: string, value: string) => void;
};
export type ArtifactFrameDeps = {
    artifacts: ArtifactClient;
    frame: ArtifactFrame;
    allowedOrigins: readonly string[];
};
export declare function createArtifactFrame(deps: ArtifactFrameDeps): {
    mount: (artifactId: string) => Promise<{
        artifact: ArtifactRecord;
        instruction: ArtifactOpenInstruction;
    }>;
    clear: () => void;
    current: () => string | undefined;
};
export type ArtifactFrameRuntime = ReturnType<typeof createArtifactFrame>;
