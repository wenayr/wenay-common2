import { createListen } from "../events/Listen";
import { type PromiseServerHooks, type RpcLimits, type RpcOpt } from "./rpc-server";
import { DeepSocketListen } from "./listen-deep";
import { type SocketTmpl } from "./rpc-protocol";
type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof createListen<T>>;
type ClientProtocol = 'v2' | 'legacy' | null;
export declare function createRpcServerAutoDetect<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits, opt, onProtocolDetect, }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
    opt?: RpcOpt;
    onProtocolDetect?: (protocol: 'v2' | 'legacy') => void;
}): {
    getProtocol: () => ClientProtocol;
    getLegacySchema: () => any;
    getResolved: () => any;
    dispose: (reason?: string) => void;
    reset: () => void;
};
export {};
