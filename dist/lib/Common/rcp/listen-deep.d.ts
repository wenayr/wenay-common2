import { type ListenOn } from "../events/Listen";
import type { ReplayEvent } from "../events/replay-listen";
import { listenSocket, listenSocketFirst, listenSocketAll, listenSocketSmart, type SubscriptionHandle } from "./listen-socket";
type WithSubHandle<R> = R extends {
    callback: (...a: infer A) => any;
} ? Omit<R, 'callback' | 'on' | 'once'> & {
    callback: (...a: A) => SubscriptionHandle & Promise<void>;
    on: (...a: A) => SubscriptionHandle & Promise<void>;
    once: (...a: A) => SubscriptionHandle & Promise<void>;
} : R;
type Obj = Record<string, any>;
export type InferArgs<T> = T extends {
    on: (cb: (...args: infer R) => void, ...rest: any[]) => any;
} ? R : never;
export type ReplaySocketListen<Z extends any[]> = WithSubHandle<ReturnType<typeof listenSocket<Z>>> & {
    line: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>;
    frameLine: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>;
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null>;
    keyframe: () => Promise<ReplayEvent<Z> | null>;
    frame: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[]>;
};
export type IsReplayMember<V> = V extends {
    getSince: Function;
    keyframe: Function;
    line: object;
    on: Function;
} ? true : false;
export type DeepSocketListen<T> = {
    [K in keyof T]: IsReplayMember<T[K]> extends true ? ReplaySocketListen<InferArgs<T[K]>> : T[K] extends {
        on: Function;
    } ? WithSubHandle<ReturnType<typeof listenSocket<InferArgs<T[K]>>>> : T[K] extends ListenOn<infer Z> ? WithSubHandle<ReturnType<typeof listenSocket<Z>>> : T[K] extends (...a: any[]) => any ? T[K] : T[K] extends Promise<any> ? T[K] : T[K] extends typeof Promise ? T[K] : T[K] extends object ? DeepSocketListen<T[K]> : T[K];
};
export type DeepSocketListenFirst<T> = {
    [K in keyof T]: T[K] extends {
        on: Function;
    } ? ReturnType<typeof listenSocketFirst<InferArgs<T[K]>>> : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketFirst<Z>> : T[K] extends (...a: any[]) => any ? T[K] : T[K] extends Promise<any> ? T[K] : T[K] extends typeof Promise ? T[K] : T[K] extends object ? DeepSocketListenFirst<T[K]> : T[K];
};
export type DeepSocketListenAll<T> = {
    [K in keyof T]: T[K] extends {
        on: Function;
    } ? ReturnType<typeof listenSocketAll<InferArgs<T[K]>>> : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketAll<Z>> : T[K] extends (...a: any[]) => any ? T[K] : T[K] extends Promise<any> ? T[K] : T[K] extends typeof Promise ? T[K] : T[K] extends object ? DeepSocketListenAll<T[K]> : T[K];
};
export type DeepSocketListenSmart<T> = {
    [K in keyof T]: IsReplayMember<NonNullable<T[K]>> extends true ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null> : NonNullable<T[K]> extends {
        on: Function;
    } ? ReturnType<typeof listenSocketSmart<InferArgs<NonNullable<T[K]>>>> | Extract<T[K], undefined | null> : NonNullable<T[K]> extends ListenOn<infer Z> ? ReturnType<typeof listenSocketSmart<Z>> : NonNullable<T[K]> extends (...a: any[]) => any ? T[K] : NonNullable<T[K]> extends Promise<any> ? T[K] : NonNullable<T[K]> extends typeof Promise ? T[K] : NonNullable<T[K]> extends object ? DeepSocketListenSmart<T[K]> : T[K];
};
export declare function matchKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean;
export declare function matchKeysList<T extends Obj>(obj1: T, keys: string[]): boolean;
export declare function deepMapByKeysList<T, T3>(obj1: T, keys: string[], func: (a: any) => T3): T | T3 | null;
export declare function deepMapByKeys<T, T2 extends Obj, T3>(obj1: T, obj2: T2, func: (a: T2) => T3): T3 | T | null;
export declare function deepListenFirst<T>(obj: T, data?: Parameters<typeof listenSocketFirst>[1]): DeepSocketListenFirst<T>;
export declare function deepListenAll<T>(obj: T, data?: Parameters<typeof listenSocketAll>[1]): DeepSocketListenAll<T>;
export declare function deepListenSmart<T>(obj: T, data?: Parameters<typeof listenSocketSmart>[1]): DeepSocketListenSmart<T>;
export {};
