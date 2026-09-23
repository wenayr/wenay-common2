import { type Request } from 'express';
import type { ArtifactStoragePort } from '../Common/artifact/artifact-host';
export type BlobAccess<C> = {
    context: C;
    operation: 'upload' | 'read' | 'remove';
    phase: 'begin' | 'commit';
    id?: string;
};
export type LocalBlobStorageDeps<C> = {
    directory: string;
    maxBytes: number;
    authorize: (access: BlobAccess<C>) => void | Promise<void>;
    validate?: (bytes: Buffer) => void | Promise<void>;
    identify?: (bytes: Buffer) => string;
};
export declare function createLocalBlobStorage<C>(deps: LocalBlobStorageDeps<C>): {
    control: {
        upload: (context: C, input: Uint8Array) => Promise<{
            id: string;
            size: number;
        }>;
        remove: (context: C, id: string) => Promise<void>;
    };
    resource: {
        read: (context: C, id: string) => Promise<NonSharedBuffer>;
        authorize: (access: BlobAccess<C>) => Promise<void>;
    };
    view: {
        info: (context: C, id: string) => Promise<{
            id: string;
            size: number;
        }>;
        maxBytes: number;
    };
};
export type LocalBlobStorage<C> = ReturnType<typeof createLocalBlobStorage<C>>;
export declare function createBlobHttpRouter<C>(deps: {
    storage: LocalBlobStorage<C>;
    context: (request: Request) => C | Promise<C>;
    contentType?: (id: string) => string;
    cacheControl?: string;
}): import("express-serve-static-core").Router;
export declare function createBlobArtifactStorage<C>(deps: {
    storage: LocalBlobStorage<C>;
    context: (account: string) => C;
    open: (input: {
        id: string;
        account: string;
    }) => ReturnType<ArtifactStoragePort['open']>;
    remove?: ArtifactStoragePort['remove'];
}): {
    open({ storageKey, account }: {
        artifact: import("../Common/artifact/artifact-host").ArtifactRecord;
        storageKey: unknown;
        account: string;
    }): Promise<import("../Common/artifact/artifact-host").ArtifactOpenInstruction>;
    remove?: ((input: {
        artifact: import("../Common/artifact/artifact-host").ArtifactRecord;
        storageKey: unknown;
        reason: 'revoked' | 'expired';
    }) => void | Promise<void>) | undefined;
};
