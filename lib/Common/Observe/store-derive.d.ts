import { type Store, type StorePatch } from './store';
export declare function storeDiffPatches(prev: unknown, next: object): StorePatch[];
export type DeriveStoreOpts = {
    keys?: readonly string[];
};
export declare function deriveStore<S extends object, P extends object>(source: Store<S>, project: (state: S) => P, opts?: DeriveStoreOpts): {
    store: Store<P>;
    stats: () => {
        recomputes: number;
        emitted: number;
        skipped: number;
    };
    close: import("../..").ListenOff;
};
export type DerivedStore<P extends object = any> = ReturnType<typeof deriveStore<any, P>>;
