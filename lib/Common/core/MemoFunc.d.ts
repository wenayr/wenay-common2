export declare function MemoFunc(a?: {
    memo?: Map<Function, Map<string, any>>;
    timeDelta?: number;
    maxLimits?: number;
    compareArguments?: (...args: any[]) => string;
    eventUpdate?: () => void;
}): {
    func: <T extends (...args: any[]) => any>(data: T, options?: {
        old?: boolean;
        key?: string;
        timeDelta?: number;
        reSave?: boolean;
        compareArguments?: (...args: Parameters<T>) => string;
    }) => T;
    cleanAll: (obj: Map<string, any> | Record<string, any>) => void;
    readonly memo: Map<Function, Map<string, any>>;
};
export type MemoFuncOpt = Parameters<ReturnType<typeof MemoFunc>["func"]>[1];
export declare const MemoFuncConvert: <T extends () => any>(func: T, memo: ReturnType<typeof MemoFunc>) => (opt?: MemoFuncOpt) => ReturnType<T>;
