export declare const RPC_TRANSPORT_LIFECYCLE: unique symbol;
export declare const RPC_TRANSPORT_CONTROL: unique symbol;
export declare const RPC_MEMBER_LOOKUP: unique symbol;
export declare const RPC_SCHEMA_READY: unique symbol;
export type RpcMemberLookup = (member: string) => boolean | undefined;
export declare function hasRpcMemberLookup(remote: any): boolean;
export declare function getRpcMemberState(remote: any, member: string): boolean | undefined;
export declare function rpcMemberAvailable(remote: any, member: string): boolean;
export declare function rpcMemberMayBeAvailable(remote: any, member: string): boolean;
export type RpcSchemaReady = () => Promise<void>;
export declare function getRpcSchemaReady(remote: any): RpcSchemaReady | undefined;
export type TransportLifecycleApi = {
    connected: () => boolean;
    closed: () => boolean;
    generation: () => number;
    onConnect: (cb: (generation: number) => void) => () => void;
    onDisconnect: (cb: (reason: string, generation: number) => void) => () => void;
    onClose: (cb: (reason: string) => void) => () => void;
};
export declare function getRpcTransportLifecycle(remote: any): TransportLifecycleApi | undefined;
export type TransportLifecycleControl = {
    connect: () => void;
    disconnect: (reason: string) => void;
    close: (reason: string) => void;
};
export declare function createTransportLifecycle(initialConnected?: boolean): {
    api: TransportLifecycleApi;
    control: TransportLifecycleControl;
};
