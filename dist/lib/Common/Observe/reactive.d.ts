type Fn = () => void;
export type ReactiveChange = {
    paths: PropertyKey[][];
};
type PathUpdateFn = (change: ReactiveChange) => void;
type Drain = 'micro' | 'immediate' | number | ((flush: Fn) => void);
export type Opts = {
    drain?: Drain;
    depth?: number;
    eager?: boolean;
};
export declare function reactive<T extends object>(root: T, opts?: Opts): T;
export declare function isReactive(p: any): boolean;
export declare function toRaw<T>(p: T): T;
export declare function onUpdate(p: any, cb: Fn): () => void;
export declare function onUpdatePaths(p: any, cb: PathUpdateFn): () => void;
export declare function flushReactive(p: any): Promise<void>;
export declare function listenUpdate(p: any): import("../..").ListenApi<[]>;
export declare function listenUpdatePaths(p: any): import("../..").ListenApi<[ReactiveChange]>;
export type Reactive<T extends object> = T;
export {};
