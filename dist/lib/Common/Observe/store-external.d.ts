type StoreExternalSource<T> = {
    on(cb: (value: T, ctx?: any) => void, opts?: any): () => void;
    snapshot(): T;
};
export declare function storeExternal<T>(source: StoreExternalSource<T>): {
    subscribe(onChange: () => void): () => void;
    getSnapshot(): T;
};
export type StoreExternal<T> = ReturnType<typeof storeExternal<T>>;
export {};
