import { type RpcAuthNotice, type SocketTmpl, type tAuthState } from "./rpc-protocol";
import { type RpcLimits } from './rpc-limits';
import { makeOff } from "./rpc-off";
import { type RpcOpt } from './rpc-caps';
import type { IsReplayMember, InferArgs, ReplaySocketListen } from "./listen-deep";
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;
export type DeepDataOnly<T> = T extends Function ? never : T extends ArrayBuffer | ArrayBufferView ? T : T extends readonly any[] ? {
    [I in keyof T]: DeepDataOnly<T[I]>;
} : T extends object ? {
    [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]>;
} : T;
export type ClientAPIAll<T> = {
    [K in keyof T as NonNullable<T[K]> extends Function ? K : NonNullable<T[K]> extends object ? K : never]: IsReplayMember<NonNullable<T[K]>> extends true ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null> : NonNullable<T[K]> extends (...args: infer A) => infer R ? ((...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>>) | Extract<T[K], undefined | null> : NonNullable<T[K]> extends object ? ClientAPIAll<NonNullable<T[K]>> | Extract<T[K], undefined | null> : never;
};
type NonFalsy<T> = Exclude<T, false | null | 0 | "" | undefined>;
export type ClientAPIStrict<T> = {
    [K in keyof T as NonFalsy<T[K]> extends Function ? K : NonFalsy<T[K]> extends object ? K : never]: IsReplayMember<NonFalsy<T[K]>> extends true ? ReplaySocketListen<InferArgs<NonFalsy<T[K]>>> : NonFalsy<T[K]> extends (...args: infer A) => infer R ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>> : NonFalsy<T[K]> extends object ? ClientAPIStrict<NonFalsy<T[K]>> : never;
};
export interface PipeArrayAPI<T> extends Promise<DeepDataOnly<T[]>> {
    [index: number]: PipeAPI<T>;
}
export type PipeAPI<T> = T extends Array<infer U> ? PipeArrayAPI<U> : {
    [K in keyof T as T[K] extends Function ? K : T[K] extends object ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<DeepDataOnly<UnwrapPromise<R>>> & PipeAPI<UnwrapPromise<R>> : T[K] extends object ? PipeAPI<T[K]> : never;
};
type ClientApiHandle = {
    log: (s: boolean) => void;
    pending: () => number;
    callbacks: () => number;
    clearPromises: (reject?: boolean) => void;
    clearCallbacks: () => void;
    remove: (fn: Function) => void;
    end: (fn: Function) => void;
    subscriptions: () => {
        key: string;
        consumers: number;
    }[];
};
export type tAuthEventState = tAuthState | 'renewFailed' | 'renewed';
export type RpcAuthEvent = Omit<RpcAuthNotice, 'state'> & {
    state: tAuthEventState;
};
export type tAuthRenewReason = 'connect' | 'notice' | 'unauthorized';
export type RpcAuthRenewRequest = {
    reason: tAuthRenewReason;
    notice?: RpcAuthEvent;
};
export type RpcTokenRenew = (request: RpcAuthRenewRequest) => any;
export type RpcClientReturn<T extends object> = {
    func: ClientAPIAll<T>;
    pipe: PipeAPI<T>;
    pipeStrict: PipeAPI<T>;
    space: ClientAPIAll<T>;
    all: ClientAPIAll<T>;
    strict: ClientAPIStrict<T>;
    api: ClientApiHandle;
    abortAll: (reason: string) => void;
    dispose: (reason?: string, opts?: {
        socketAlive?: boolean;
    }) => void;
    close: (reason?: string, opts?: {
        socketAlive?: boolean;
    }) => void;
    schema: () => any;
    readyStrict: () => Promise<void>;
    ready: () => Promise<void>;
    initStrict: (obj?: object) => Promise<void>;
    init: (obj?: object) => Promise<void>;
    reauth: (token: any) => Promise<any>;
    auth: () => Promise<any>;
    onAuthState: (cb: (event: RpcAuthEvent) => void) => ReturnType<typeof makeOff>;
    setTokenRenew: (renew: RpcTokenRenew | null) => void;
    onDisconnect: (cb: (reason: string) => void) => ReturnType<typeof makeOff>;
};
export declare function createRpcClient<T extends object>({ socket, socketKey: key, limit, limits, dedupeListen, token, opt }: {
    socket: SocketTmpl;
    socketKey: string;
    limit?: number;
    limits?: RpcLimits;
    dedupeListen?: boolean;
    token?: any;
    opt?: RpcOpt;
}): RpcClientReturn<T>;
export type { ClientApiHandle };
