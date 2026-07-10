import { Listener, NormalizeTuple, ListenApi } from "./Listen";
export declare function mapListen<TSource extends any[], TTarget extends any[]>(sourceListen: ListenApi<TSource>, transform: (...args: NormalizeTuple<TSource>) => TTarget | null, options?: {
    closeOn?: ListenApi<any>;
}): readonly [Listener<NormalizeTuple<TTarget>>, ListenApi<TTarget>];
