import { SocketTmpl } from "./rpc-protocol";
import { DeepSocketListenSmart } from "./listen-deep";
import { type RpcOpt } from "./rpc-caps";
export interface RpcHubSocket extends SocketTmpl {
    disconnect?: () => void;
}
export type RpcDescriptor<T extends object> = {
    socketKey?: string;
    __type?: T;
};
export declare function rpc<T extends object>(socketKey?: string): RpcDescriptor<T>;
export declare function createRpcClientHub<T extends Record<string, RpcDescriptor<any>>, T2 extends RpcHubSocket>(createSocket: (token: string | null) => T2, schemaBuilder: (helper: typeof rpc) => T, hubOpts?: {
    opt?: RpcOpt;
}): {
    readonly promise: Promise<{ [K in keyof { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }]: { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }[K]; }>;
    facade: { [K in keyof { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }]: { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }[K]; };
    setToken: (token: string | null) => Promise<{ [K in keyof { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }]: { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }[K]; }>;
    connect: (token: string | null) => Promise<{ [K in keyof { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }]: { [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object> ? import("./rpc-client").RpcClientReturn<DeepSocketListenSmart<U>> : never; }[K]; }>;
    reauth: (token: string | null) => Promise<any[]>;
    readonly socket: T2;
    onConnect: (func?: ((count: number) => void) | null) => void;
    onDisconnect: (func?: ((reason: string) => void) | null) => void;
    connectListen: (cb: (count: number) => void) => () => void;
    disconnectListen: (cb: (reason: string) => void) => () => void;
    connectCount: () => number;
};
