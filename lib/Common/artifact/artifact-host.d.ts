import { StoreDrain } from '../Observe/store';
export type ArtifactRuntime = 'sandboxed-iframe' | 'download';
export type ArtifactState = 'ready' | 'revoked' | 'expired';
export type ArtifactRetention = {
    class: 'ephemeral';
    expiresAt: number;
} | {
    class: 'persistent';
    expiresAt?: number;
};
export type ArtifactDescriptor = {
    kind: string;
    label: string;
    runtime: ArtifactRuntime;
    mime?: string;
    version?: string;
};
export type ArtifactRecord = {
    id: string;
    owner: string;
    descriptor: ArtifactDescriptor;
    state: ArtifactState;
    retention: ArtifactRetention;
    createdAt: number;
    updatedAt: number;
};
export type ArtifactStore = {
    artifacts: Record<string, ArtifactRecord>;
};
export type ArtifactOpenInstruction = {
    url: string;
    expiresAt: number;
};
export type ArtifactStoragePort = {
    open(input: {
        artifact: ArtifactRecord;
        storageKey: unknown;
        account: string;
    }): ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>;
    remove?(input: {
        artifact: ArtifactRecord;
        storageKey: unknown;
        reason: 'revoked' | 'expired';
    }): void | Promise<void>;
};
export type ArtifactRegisterInput = {
    owner: string;
    descriptor: ArtifactDescriptor;
    storageKey: unknown;
    retention: ArtifactRetention;
};
export type ArtifactPolicy = {
    canRead?: (account: string, artifact: ArtifactRecord) => boolean;
    canRevoke?: (account: string, artifact: ArtifactRecord) => boolean;
    canRegister?: (input: ArtifactRegisterInput) => boolean;
};
export type ArtifactHostDeps = {
    storage: ArtifactStoragePort;
    policy?: ArtifactPolicy;
    id?: () => string;
    now?: () => number;
    history?: number;
    drain?: StoreDrain;
};
export declare function copyArtifact(artifact: ArtifactRecord): ArtifactRecord;
export declare function validateOpenInstruction(instruction: ArtifactOpenInstruction, now: number): {
    url: string;
    expiresAt: number;
};
export declare function createArtifactHost(deps: ArtifactHostDeps): {
    register: (input: ArtifactRegisterInput) => ArtifactRecord;
    reap: (at?: number) => Promise<ArtifactRecord[]>;
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
    store: import("../Observe/store").Store<ArtifactStore>;
    close(): void;
};
export type ArtifactHost = ReturnType<typeof createArtifactHost>;
