export declare function promiseProgress<T extends any = unknown>(array: ((() => Promise<T>) | (() => any) | Promise<T>)[]): {
    onOk: (cb: (...data: [data: T, i: number, countOk: number, countError: number, count: number]) => any) => import("../events/Listen").ListenOff;
    onError: (cb: (...data: [error: any, i: number, countOk: number, countError: number, count: number]) => any) => import("../events/Listen").ListenOff;
    all: () => Promise<any[]>;
    allSettled: () => Promise<PromiseSettledResult<any>[]>;
    items: () => Promise<any>[];
    stats: () => {
        ok: number;
        error: number;
        count: number;
    };
};
