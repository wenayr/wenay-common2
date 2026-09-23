import { MyError } from '../../toError/myThrow';
export declare function createRpcScope(): {
    check: () => void;
    error: () => MyError<unknown>;
    own: (dispose: () => void) => () => void;
    close: () => unknown[];
    active: () => boolean;
    signal: AbortSignal;
};
export type RpcScope = ReturnType<typeof createRpcScope>;
type ScopeBinding = {
    resolve: (path: readonly string[]) => RpcScope | undefined;
    current?: RpcScope;
};
export declare function bindRpcScopes<T extends object>(hooks: T, resolve: ScopeBinding['resolve']): T;
export declare function inheritRpcScopes<T extends object>(source: object | undefined, target: T): T;
export declare function rpcScopeFor(hooks: object | undefined, path: readonly string[]): {
    check: () => void;
    error: () => MyError<unknown>;
    own: (dispose: () => void) => () => void;
    close: () => unknown[];
    active: () => boolean;
    signal: AbortSignal;
} | undefined;
export declare function currentRpcScope(hooks: object): {
    check: () => void;
    error: () => MyError<unknown>;
    own: (dispose: () => void) => () => void;
    close: () => unknown[];
    active: () => boolean;
    signal: AbortSignal;
} | undefined;
export declare function transformRpcScoped(hooks: {
    resolveTransform?: (value: any) => any;
} | undefined, value: any, scope?: RpcScope): any;
export {};
