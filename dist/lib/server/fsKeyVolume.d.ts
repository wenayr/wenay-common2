export type SaveKeyValueStore = ReturnType<typeof saveKeyValue>;
export declare function saveKeyValue({ dirDef, key: _key }: {
    dirDef: string;
    key?: string;
}): {
    get: ({ key, path }?: {
        key?: string | undefined;
        path?: string | undefined;
    }) => Promise<string>;
    has: ({ key, path }?: {
        key?: string | undefined;
        path?: string | undefined;
    }) => Promise<boolean>;
    set: (args_0: {
        key?: string;
        obj: string;
        path?: string;
    }) => Promise<void>;
    setElMap: (args_0: {
        key?: string;
        keyEl: string;
        valueEl: any;
        path?: string;
    }) => Promise<void>;
    delEl: (args_0: {
        key?: string;
        keyEl: string;
        path?: string;
    }) => Promise<boolean>;
    del: (args_0?: {
        key?: string | undefined;
        path?: string | undefined;
    } | undefined) => Promise<void>;
};
