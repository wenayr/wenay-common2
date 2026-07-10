type IterableObjectOptions<V> = {
    resolve: () => Map<string, V>;
    onChange?: (type: "set" | "delete", key: string, value?: V) => void;
};
export declare function createIterableObject<V>(options: IterableObjectOptions<V>): Iterable<[string, V]> & Record<string, V>;
export {};
