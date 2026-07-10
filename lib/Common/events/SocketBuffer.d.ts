export type SocketSource<T extends any> = (data: {
    callback: (data: T) => void;
    [key: string]: any;
}, ...b: any[]) => (any | (() => any));
export type SocketPayload<T extends SocketSource<any>> = T extends SocketSource<infer R> ? R : never;
type ParametersOther<T extends (forget: any, ...args: any) => any> = T extends (forget: any, ...args: infer P) => any ? P : never;
type NonUndefined<T> = T extends undefined ? never : T;
export declare function socketBuffer<T extends SocketSource<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown;
}, T4 extends T3 | (() => T3)>(func: T, callbackMain: (data: SocketPayload<T>, memo: T3 | T4) => T2, memo?: T3 | T4): (a: Omit<Parameters<T>[0], "callback"> & {
    callback: (...data: NonUndefined<T2>) => any;
}, ...b: ParametersOther<T>) => ReturnType<T>;
export declare function listenSnapshot<T extends SocketSource<any | any[]>, T2 extends (readonly unknown[]) | undefined, T3 extends {
    [key: string]: unknown;
}, T4 extends T3 | (() => T3)>({ func, memo, callbackSave, snapshot }: {
    func: () => T;
    callbackSave: (data: SocketPayload<T>, memo: T3) => T2;
    memo: T4;
    snapshot?: (memo: T4) => T3;
}): {
    run: (cb: import("./Listen").Listener<[data: SocketPayload<T>, memo: T3]>, opts?: {
        cbClose?: () => void;
        key?: import("./Listen").ListenKey;
    } | undefined) => import("./Listen").ListenOff;
    snapshot: () => T3 | undefined;
    memo: T4;
    listenA: import("./Listen").ListenApi<[data: SocketPayload<T>, memo: T3]>;
    connect: () => void;
    readonly disconnect: ((a: Omit<Parameters<T>[0], "callback"> & {
        callback: (...data: NonUndefined<T2>) => any;
    }, ...b: ParametersOther<T>) => ReturnType<T>) | null;
};
export {};
