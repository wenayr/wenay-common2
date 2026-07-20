type Socket = {
    emit: (e: string, p: any) => any;
    on: (e: string, cb: (d: any) => any) => any;
};
export type RequestScreener<T> = {
    key: string[];
    callbacksId?: string[];
    request: any[];
};
type Obj = {
    [k: string]: any;
};
type SocketData<T> = ({
    data: T;
    error?: undefined;
} | {
    error: any;
    data?: undefined;
}) & {
    mapId: number;
    wait?: boolean;
    callbacksId?: number[];
};
type PromiseServerHooks<T> = {
    onRequest?: (ctx: {
        key: string[];
        request: any[];
        fnName: string;
        fn: Func;
        msg: SocketData<RequestScreener<T>>;
    }) => boolean | Promise<boolean>;
    onInvalid?: (ctx: {
        reason: "invalid_payload" | "not_function" | "resolve_error" | "rate_limit";
        key?: any;
        request?: any;
        error?: any;
        msg: SocketData<RequestScreener<T>>;
    }) => void | Promise<void>;
};
type ScreenerSoc<T> = {
    sendMessage: (d: T) => void;
    api: (h: {
        onMessage: (m: T) => void | Promise<void>;
    }) => void;
};
export declare function promiseServer<T extends Obj>(soc: ScreenerSoc<SocketData<RequestScreener<T>>> & {
    hooks?: PromiseServerHooks<T>;
}, target: T): void;
type Func = (a: any) => any;
export type ScreenerSoc2<T> = {
    send: (d: RequestScreener<T>, wait?: boolean, cbs?: Func[]) => Promise<any>;
    api: ScreenerSocApi<T>;
    abortAll: (textError: string) => void;
};
export type ScreenerSocApi<T> = {
    log: (s: boolean) => void;
    promiseTotal: () => number;
    callbackTotal: () => number;
    promiseDeleteAll: (rej: boolean) => void;
    callbackDeleteAll: () => void;
    callbackDelete: (fn: Func) => void;
};
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;
export type MethodToPromise<T extends object> = {
    [P in keyof T]: T[P] extends (...args: infer Z) => infer X ? (...args: Z) => Promise<UnwrapPromise<X>> : T[P] extends object ? MethodToPromise<T[P]> : never;
};
export type MethodToPromiseStrict<T extends object> = {
    [P in keyof T]: T[P] extends (...args: infer Z) => infer X ? (...args: Z) => Promise<UnwrapPromise<X>> : T[P] extends object ? MethodToPromiseStrict<T[P]> : T[P];
};
export declare function wsWrapper<T>(soc: ScreenerSoc<SocketData<RequestScreener<T>>> & {
    limit?: number;
}): ScreenerSoc2<T>;
export declare function createClientProxy<T extends object>(soc2: ScreenerSoc2<T>, wait?: boolean): MethodToPromise<T>;
export type NoVoid<T> = {
    [P in Exclude<keyof T, {
        [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<T[K]> extends void ? K : never : never;
    }[keyof T]>]: T[P];
};
export type OnlyVoid<T> = {
    [P in Exclude<keyof T, {
        [K in keyof T]: T[K] extends (...args: any[]) => any ? ReturnType<T[K]> extends void ? never : K : never;
    }[keyof T]>]: T[P];
};
export declare function createAPIFacadeClient<T extends object>({ socket: sock, socketKey: key, limit }: {
    socket: Socket;
    socketKey: string;
    limit?: number;
}): {
    api: ScreenerSocApi<any>;
    func: MethodToPromise<NoVoid<T>>;
    space: MethodToPromise<OnlyVoid<T>>;
    all: MethodToPromise<T>;
    strict: MethodToPromiseStrict<T>;
    infoStrict: () => any;
    strictInit(obj?: object): Promise<unknown>;
};
export declare function createAPIFacadeServer<T extends object>({ socket: sock, object: targetObj, socketKey: key, debug }: {
    socket: Socket;
    object: T;
    socketKey: string;
    debug?: boolean;
}): void;
export declare const CreatAPIFacadeServer: typeof createAPIFacadeServer;
export declare const CreatAPIFacadeClient: typeof createAPIFacadeClient;
export {};
