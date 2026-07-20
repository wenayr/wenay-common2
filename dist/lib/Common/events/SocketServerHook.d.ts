import { listenSocketSmart as soc } from "../rcp/listen-socket";
type transformer = (func: (data: any) => any, tag: string, data: any) => any;
export declare function SocketServerHook(opt?: {
    transformer?: transformer;
}): {
    obj: {
        [k: string]: readonly [import("./Listen").Listener<[unknown]>, import("./Listen").ListenApi<unknown>];
    };
    get(tag: string): readonly [import("./Listen").Listener<[unknown]>, import("./Listen").ListenApi<unknown>];
    provider: (tag: string, data: any) => void;
};
export declare function WebSocketServerHook(s: ReturnType<typeof SocketServerHook>, paramsSoc?: Parameters<typeof soc>[1], disconnect?: () => any): {
    disconnect(): void;
    get: {
        [k: string]: {
            callback: (z: (...args: any[]) => void, opts?: import("../rcp/listen-socket").RpcListenSubscribeOpts) => import("../rcp/listen-socket").SubscriptionHandle;
            on: (z: (...args: any[]) => void, opts?: import("../rcp/listen-socket").RpcListenSubscribeOpts) => import("../rcp/listen-socket").SubscriptionHandle;
            once: (z: (...args: any[]) => void, opts?: import("../rcp/listen-socket").RpcListenSubscribeOpts) => import("../rcp/listen-socket").SubscriptionHandle;
            close: () => void;
            off: () => boolean;
            removeCallback: () => boolean;
        };
    };
    keys: () => string[];
    ping: () => string;
    provider: (tag: string, data: any) => void;
};
export type WebSocketServerHook = ReturnType<typeof WebSocketServerHook>;
export {};
