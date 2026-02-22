// rpc-server-auto.ts

import { isListenCallback, funcListenCallbackBase } from "../events/Listen";
import { listenSocket, } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits } from "./rpc-server";
import {DeepSocketListen} from "./listen-deep";
import {SocketTmpl} from "./rpc-protocol";

type ListenCallbackBase<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

export function createRpcServerAuto<T extends object>({ socket, object: target, socketKey: key, debug, hooks, disconnectListen, limits }: {
    socket: SocketTmpl;
    object: T;
    socketKey: string;
    debug?: boolean;
    hooks?: Omit<PromiseServerHooks<DeepSocketListen<T>>, "resolveTransform">;
    disconnectListen?: ListenCallbackBase<any>;
    limits?: RpcLimits;
}) {
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (!result) {
            result = listenSocket(parent, { addListenClose: disconnectListen });
            cache.set(parent, result);
        }
        return result;
    }

    createRpcServer({
        socket, object: target as any, socketKey: key, debug, limits,
        hooks: {
            ...hooks,
            resolveTransform: (obj: any) => {
                if (!isListenCallback(obj)) return obj;
                return getListenSocket(obj, disconnectListen);
            },
        } as any,
    });
}