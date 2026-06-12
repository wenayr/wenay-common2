import { isListenCallback, funcListenCallbackBase } from "../events/Listen";
import { listenSocket, } from "./listen-socket";
import { createRpcServer, type PromiseServerHooks, type RpcLimits } from "./rpc-server";
import {DeepSocketListen} from "./listen-deep";
import {SocketTmpl, IS_RPC_LISTEN} from "./rpc-protocol";

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
    // Один listenSocket-wrapper на Listen ЗАТИРАЛ предыдущего подписчика при повторной
    // подписке (его callback заменяет last/active). Мультиплексор: каждый подписчик
    // получает собственный listenSocket; записи чистятся по завершении подписки.
    const cache = new WeakMap<object, ReturnType<typeof listenSocket>>();

    function getListenSocket(parent: any, disconnectListen?: ListenCallbackBase<any>): ReturnType<typeof listenSocket> {
        let result = cache.get(parent);
        if (!result) {
            const subs = new Map<Function, ReturnType<typeof listenSocket>>();
            function subscribe(z: any) {
                const w = listenSocket(parent, { addListenClose: disconnectListen });
                subs.set(z, w);
                const done = w.callback(z);
                done.then(() => subs.delete(z));
                return done;
            }
            function unsubscribeAll() {
                subs.forEach(w => w.removeCallback());
                subs.clear();
                return true;
            }
            result = { callback: subscribe, removeCallback: unsubscribeAll };
            (result as any)[IS_RPC_LISTEN] = true; // сервер задекларирует адрес узла в Pkt.MAP
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