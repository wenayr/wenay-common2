import { ArtifactRecord } from './artifact-host';
export type tArtifactBytes = string | Uint8Array;
export type ArtifactByteCacheDeps = {
    fetch: (artifact: ArtifactRecord) => Promise<tArtifactBytes> | tArtifactBytes;
    maxBytes?: number;
    onEvict?: (hash: string, bytes: tArtifactBytes) => void;
    hash?: (bytes: tArtifactBytes) => Promise<string> | string;
};
export declare function createArtifactByteCache(deps: ArtifactByteCacheDeps): {
    get: (artifact: ArtifactRecord) => Promise<{
        hash: string;
        bytes: string | Uint8Array<ArrayBuffer>;
    }>;
    has: (hashKey: string) => boolean;
    peek: (hashKey: string) => string | Uint8Array<ArrayBuffer> | undefined;
    stats: () => {
        entries: number;
        totalBytes: number;
        hits: number;
        misses: number;
    };
    clear(): void;
};
export type ArtifactByteCache = ReturnType<typeof createArtifactByteCache>;
