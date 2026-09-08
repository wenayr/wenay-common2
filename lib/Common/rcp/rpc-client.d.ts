import { type RpcAuthNotice, type SocketTmpl, type tAuthState } from "./rpc-protocol";
import { type RpcLimits } from './rpc-limits';
import { makeOff } from "./rpc-off";
import { type RpcOpt } from './rpc-caps';
import type { IsReplayMember, IsListenMember, InferArgs, ReplaySocketListen, SocketListenMember } from "./listen-deep";
import type { StoreGetter, StoreMask, StorePick } from '../Observe/store';
import type { StoreReplayState } from '../Observe/store-replay';
import type { tJsonData } from '../core/json-data';
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;
export type DeepDataOnly<T> = [T] extends [tJsonData] ? [tJsonData] extends [T] ? T : DeepDataOnlyValue<T> : DeepDataOnlyValue<T>;
type DeepDataOnlyValue<T> = T extends Function ? never : T extends ArrayBuffer | ArrayBufferView ? T : T extends readonly any[] ? {
    [I in keyof T]: DeepDataOnly<T[I]>;
} : T extends object ? {
    [K in keyof T as T[K] extends Function ? never : K]: DeepDataOnly<T[K]>;
} : T;
type RpcCallResult<T, P extends boolean> = Promise<DeepDataOnly<T>> & (P extends true ? PipeAPI<T> : unknown);
type RpcStoreGetter<T extends object, P extends boolean> = {
    (): RpcCallResult<T, P>;
    <M extends StoreMask<T>>(mask: M): RpcCallResult<StorePick<T, M>, P>;
};
type RpcFunction<F, P extends boolean = false> = F extends (...args: infer A) => infer R ? 0 extends (1 & F) ? (...args: A) => RpcCallResult<UnwrapPromise<R>, P> : keyof StoreGetter<object> extends keyof F ? F extends StoreGetter<infer S> ? RpcStoreGetter<S, P> : never : (...args: A) => RpcCallResult<UnwrapPromise<R>, P> : never;
export type ClientAPIAll<T> = {
    [K in keyof T as K extends keyof StoreReplayState ? K : NonNullable<T[K]> extends Function ? K : NonNullable<T[K]> extends object ? K : never]: K extends keyof StoreReplayState ? T[K] : IsReplayMember<NonNullable<T[K]>> extends true ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null> : IsListenMember<NonNullable<T[K]>> extends true ? SocketListenMember<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null> : NonNullable<T[K]> extends (...args: infer A) => infer R ? RpcFunction<NonNullable<T[K]>> | Extract<T[K], undefined | null> : NonNullable<T[K]> extends object ? ClientAPIAll<NonNullable<T[K]>> | Extract<T[K], undefined | null> : never;
};
type NonFalsy<T> = Exclude<T, false | null | 0 | "" | undefined>;
export type ClientAPIStrict<T> = {
    [K in keyof T as K extends keyof StoreReplayState ? K : NonFalsy<T[K]> extends Function ? K : NonFalsy<T[K]> extends object ? K : never]: K extends keyof StoreReplayState ? T[K] : IsReplayMember<NonFalsy<T[K]>> extends true ? ReplaySocketListen<InferArgs<NonFalsy<T[K]>>> : IsListenMember<NonFalsy<T[K]>> extends true ? SocketListenMember<InferArgs<NonFalsy<T[K]>>> : NonFalsy<T[K]> extends (...args: infer A) => infer R ? RpcFunction<NonFalsy<T[K]>> : NonFalsy<T[K]> extends object ? ClientAPIStrict<NonFalsy<T[K]>> : never;
};
export interface PipeArrayAPI<T> extends Promise<DeepDataOnly<T[]>> {
    [index: number]: PipeAPI<T>;
}
export type PipeAPI<T> = T extends Array<infer U> ? PipeArrayAPI<U> : {
    [K in keyof T as K extends keyof StoreReplayState ? K : T[K] extends Function ? K : T[K] extends object ? K : never]: K extends keyof StoreReplayState ? T[K] : T[K] extends (...args: infer A) => infer R ? RpcFunction<T[K], true> : T[K] extends object ? PipeAPI<T[K]> : never;
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
