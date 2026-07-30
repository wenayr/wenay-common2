export declare const REACTIVE_ARRAY_MUTATIONS: unique symbol;
export declare const STORE_REPLAY_PATCH_SOURCE: unique symbol;
export declare const STORE_REPLAY_VIEW_PATCH_SOURCE: unique symbol;
export type ReactiveArrayMutations = {
    paths: readonly PropertyKey[][];
    replacements: readonly PropertyKey[][];
};
