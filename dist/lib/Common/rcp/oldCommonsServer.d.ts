type tSocket = {
    emit: (marker: string, object: any) => any;
    on: (marker: string, callback: (a: any) => any) => any;
};
export type tRequestScreenerT<T> = {
    key: string[];
    callbacksId?: string[];
    request: any[];
};
type tt = {
    [k: string]: any;
};
export declare function funcPromiseServer<T extends tt>(data: screenerSoc<tSocketData<tRequestScreenerT<T>>>, obj: T): void;
export declare function funcPromiseServer2<T extends object>(sendMessage: screenerSoc222<tSocketData<tRequestScreenerT<T>>>, obj: T): (datum: any) => Promise<void>;
type tSocketData<T> = ({
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
type screenerSoc<T> = {
    sendMessage: (data: T) => void;
    api: (data: {
        onMessage: (data: T) => void | Promise<void>;
    }) => void;
};
type screenerSoc222<T> = (data: T) => void;
export declare function funcForWebSocket<T>(data: screenerSoc<tSocketData<tRequestScreenerT<T>>> & {
    limit?: number;
}): screenerSoc2<T>;
type tFunc = (a: any) => any;
export type screenerSoc2<T> = {
    send: (data: tRequestScreenerT<T>, wait?: boolean, callbacksId?: tFunc[]) => Promise<any>;
    api: screenerSocApi<T>;
};
export type screenerSocApi<T> = {
    log: (status: boolean) => void;
    promiseTotal: () => number;
    callbackTotal: () => number;
    promiseDeleteAll: (reject: boolean) => void;
    callbackDeleteAll: () => void;
    callbackDelete: (func: tFunc) => void;
};
export type tMethodToPromise2<T extends object> = {
    [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? X extends Promise<any> ? T[P] : (...args: Z) => Promise<X> : T[P] extends object ? tMethodToPromise2<T[P]> : never;
};
export type tMethodToPromise4<T extends object> = {
    [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? X extends Promise<any> ? T[P] : (...args: Z) => Promise<X> : T[P] extends object ? tMethodToPromise4<T[P]> : T[P];
};
type tt5<T extends any> = T extends Promise<infer R> ? R : T;
export type tMethodToPromise5<T extends object> = {
    [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => Promise<tt5<X>> : T[P] extends object ? tMethodToPromise5<T[P]> : never;
};
export type tMethodToPromise6<T extends object> = {
    [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => Promise<tt5<X>> : T[P] extends object ? tMethodToPromise6<T[P]> : T[P];
};
export declare function funcScreenerClient2<T extends object>(data: screenerSoc2<T>, wait?: boolean): tMethodToPromise5<T>;
type tAndB<T> = {
    data: T;
    void: () => void;
};
export type screenerSoc3<T> = {
    send: (data: tRequestScreenerT<T>) => tAndB<Promise<any>>;
};
export type tMethodToPromise3<T extends object> = {
    [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => (X extends Promise<any> ? tAndB<X> : tAndB<Promise<X>>) : tAndB<Promise<T[P]>>;
};
export type typeVoid2<T> = {
    [P in Exclude<keyof T, {
        [P in keyof T]: T[P] extends (any: any) => any ? ReturnType<T[P]> extends void ? P : never : never;
    }[keyof T]>]: T[P];
};
export type typeNoVoid2<T> = {
    [P in Exclude<keyof T, {
        [P in keyof T]: T[P] extends (any: any) => any ? ReturnType<T[P]> extends void ? never : P : never;
    }[keyof T]>]: T[P];
};
export type UnAwaited<T extends Promise<any>> = T extends Promise<infer R> ? R : never;
export type UnAwaitedArr<T extends Promise<any>[]> = T extends Promise<infer R>[] ? R[] : never;
export type ReturnTypePromise<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R extends Promise<any> ? UnAwaited<R> : R : any;
export type UnObject<T extends object> = T extends {
    [k: string]: infer R;
} ? R : never;
export type UnArray<T extends any[]> = T extends (infer R)[] ? R : never;
export type tElArr<T extends any[]> = UnArray<T>;
export declare function CreatAPIFacadeClientOld<T extends object>({ socketKey, socket, limit }: {
    socket: tSocket;
    socketKey: string;
    limit?: number;
}): {
    api: screenerSocApi<any>;
    func: tMethodToPromise5<typeVoid2<T>>;
    space: tMethodToPromise5<typeNoVoid2<T>>;
    all: tMethodToPromise5<T>;
    strictly: tMethodToPromise6<T>;
    infoStrictly(): any;
    strictlyInit(obj?: object): Promise<unknown>;
};
export declare function CreatAPIFacadeServerOld<T extends object>(params: {
    socket: tSocket;
    object: T;
    socketKey: string;
    debug?: boolean;
}): void;
export declare function fMiniTest(): void;
export declare class CTestWeb {
    func(a: number, b: number): number;
    func2(a: number, b: number): Promise<number>;
    fun3(a: number, b: number): number;
    test(): string;
}
export {};
