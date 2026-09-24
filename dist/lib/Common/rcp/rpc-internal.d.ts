export declare function registerCoreDetach(server: object, detach: () => void): void;
export declare function coreDetachOf(server: object): (() => void) | undefined;
export declare function setRpcCallbackId(fn: Function, id: number): void;
export declare function rpcCallbackId(fn: Function): number | undefined;
