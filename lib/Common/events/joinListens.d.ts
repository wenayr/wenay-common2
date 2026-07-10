import { listen as createListenPair } from "./Listen";
export type ListenPair<T extends any[] = any[]> = ReturnType<typeof createListenPair<T>>;
type KeyExtractor<D> = (data: D) => string | undefined;
export type ListenMap<T extends Record<string, any>> = {
    [K in keyof T]: ListenPair<T[K]>[1];
};
type CollectedResult<T extends Record<string, any>> = {
    [K in keyof T]: T[K];
};
type JoinResult<R> = {
    listen: ListenPair<[R, string]>[1];
    pending: Map<string, Map<string, any>>;
    clear: (tid?: string) => void;
    destroy: () => void;
    add: (port: ListenPair<any>[1], key?: string) => void;
};
export declare function joinListens<T extends Record<string, any[]>>(listens: ListenMap<T>, keyExtractor?: KeyExtractor<any>): JoinResult<CollectedResult<T>>;
export declare function joinListens<D extends any[] = any[]>(listens: ListenPair<D>[1][], keyExtractor?: KeyExtractor<any>): JoinResult<D[][]>;
export {};
