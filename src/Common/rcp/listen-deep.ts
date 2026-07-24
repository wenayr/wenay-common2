// listen-deep.ts

import { createListen, type ListenOn } from "../events/Listen";
import type { ReplayEvent } from "../events/replay-listen";
import { listenSocket, listenSocketFirst, listenSocketAll, listenSocketSmart, type SubscriptionHandle } from "./listen-socket";

// Client projection of listenSocket result: on(fn) gives CALLABLE
// handle (off()/await/.off/.unsubscribe/.removeCallback), callback/removeCallback — legacy.
// TYPE-only: needed because BASE listenSocket intentionally typed as
// Promise<void> (awaited by rpc-server-auto: `done.then`), client layer must
// see handle. First/All/Smart already get SubscriptionHandle via their cast.
// on/callback give SubscriptionHandle & Promise<void>: intersection with Promise<void> preserves
// strict additivity — old `const p: Promise<void> = deep.ev.callback(fn)` still
// compiles, callability/await/.off/.unsubscribe/.removeCallback available on top.
type WithSubHandle<R> = R extends { callback: (...a: infer A) => any }
    ? Omit<R, 'callback' | 'on' | 'once'> & {
          callback: (...a: A) => SubscriptionHandle & Promise<void>;
          /** Primary subscription name once callback is set. */
          on: (...a: A) => SubscriptionHandle & Promise<void>;
          /** Single subscription: one event, then stream closes. */
          once: (...a: A) => SubscriptionHandle & Promise<void>;
      }
    : R

type Obj = Record<string, any>;
type ListenBase<T extends any[]> = ReturnType<typeof createListen<T>>;

// Reliably extract argument types from on method
export type InferArgs<T> = T extends { on: (cb: (...args: infer R) => void, ...rest: any[]) => any } ? R : never;

// Client projection of merged replay node (rpc-server-auto, Feature A): UNDER SAME
// key legacy Listen surface (byte-for-byte plain) plus replay wire.
// Structurally compatible with ReplayRemote — deep.key passed to replaySubscribe as-is.
export type ReplaySocketListen<Z extends any[]> = WithSubHandle<ReturnType<typeof listenSocket<Z>>> & {
    /** Line of envelopes {seq, ts, event} — live part of replay client (policy 'queue'). */
    line: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>
    /** Policy 'frame' line: on lag server may skip, recovering with frame. */
    frameLine: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>
    /** Log tail after seq. null = evicted. */
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null>
    /** Fresh keyframe. null = current provider not set. */
    keyframe: () => Promise<ReplayEvent<Z> | null>
    /** Frame: catch-up in single call (tail/mini-frame/keyframe — line chooses). */
    frame: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[]>
}
// Replay member detection at type level — mirrors runtime brand (structurally:
// plain Listen lacks getSince/keyframe/line, store-Listen — getSince/line).
export type IsReplayMember<V> = V extends { getSince: Function; keyframe: Function; line: object; on: Function } ? true : false

// Types for various Socket listener variants
export type DeepSocketListen<T> = {
    [K in keyof T]: IsReplayMember<NonNullable<T[K]>> extends true
        ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends { on: Function }
        ? WithSubHandle<ReturnType<typeof listenSocket<InferArgs<NonNullable<T[K]>>>>>
            | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends ListenOn<infer Z>   // bare on (branded) → same subscription {on, once, close, ...}
        ? WithSubHandle<ReturnType<typeof listenSocket<Z>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends (...a: any[]) => any ? T[K]
        : NonNullable<T[K]> extends Promise<any> ? T[K] // Promise instances pass as-is (typeof Promise caught only constructor)
        : NonNullable<T[K]> extends typeof Promise ? T[K]
        : NonNullable<T[K]> extends object
            ? DeepSocketListen<NonNullable<T[K]>> | Extract<T[K], undefined | null>
        : T[K];
};

export type DeepSocketListenFirst<T> = {
    [K in keyof T]: T[K] extends { on: Function }
        ? ReturnType<typeof listenSocketFirst<InferArgs<T[K]>>>
        : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketFirst<Z>>
        : T[K] extends (...a: any[]) => any ? T[K]
        : T[K] extends Promise<any> ? T[K] // Promise instances pass as-is (typeof Promise caught only constructor)
        : T[K] extends typeof Promise ? T[K]
        : T[K] extends object ? DeepSocketListenFirst<T[K]> 
        : T[K];
};

export type DeepSocketListenAll<T> = {
    [K in keyof T]: T[K] extends { on: Function }
        ? ReturnType<typeof listenSocketAll<InferArgs<T[K]>>>
        : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketAll<Z>>
        : T[K] extends (...a: any[]) => any ? T[K]
        : T[K] extends Promise<any> ? T[K] // Promise instances pass as-is (typeof Promise caught only constructor)
        : T[K] extends typeof Promise ? T[K]
        : T[K] extends object ? DeepSocketListenAll<T[K]> 
        : T[K];
};

// export type DeepSocketListenSmart<T> = {
//     [K in keyof T]: T[K] extends { on: Function }
//         ? ReturnType<typeof listenSocketSmart<InferArgs<T[K]>>>
//         : T[K] extends (...a: any[]) => any ? T[K]
//         : T[K] extends typeof Promise ? T[K]
//         : T[K] extends object ? DeepSocketListenSmart<T[K]>
//         : T[K];
// };
export type DeepSocketListenSmart<T> = {
    [K in keyof T]: IsReplayMember<NonNullable<T[K]>> extends true
        ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends { on: Function }
        ? ReturnType<typeof listenSocketSmart<InferArgs<NonNullable<T[K]>>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends ListenOn<infer Z> ? ReturnType<typeof listenSocketSmart<Z>>
        : NonNullable<T[K]> extends (...a: any[]) => any ? T[K]
            : NonNullable<T[K]> extends Promise<any> ? T[K] // Promise instances pass as-is
            : NonNullable<T[K]> extends typeof Promise ? T[K]
                : NonNullable<T[K]> extends object ? DeepSocketListenSmart<T[K]>
                    : T[K];
};
// ── Utilities ─────────────────────────────────────────────────────

function isLeafValue(value: unknown): boolean {
    return (
        value == null ||
        typeof value === "function" ||
        value instanceof Function ||
        typeof value !== "object"
    );
}

export function matchKeys<T extends Obj, T2 extends Obj>(obj1: T, obj2: T2): boolean {
    return matchKeysList(obj1, Object.keys(obj2));
}

export function matchKeysList<T extends Obj>(obj1: T, keys: string[]): boolean {
    const k1 = Object.keys(obj1);
    return k1.length === keys.length && new Set([...k1, ...keys]).size === keys.length;
}

export function deepMapByKeysList<T, T3>(
    obj1: T,
    keys: string[],
    func: (a: any) => T3,
): T | T3 | null {
    if (isLeafValue(obj1)) return obj1 as any;
    if (matchKeysList(obj1 as Obj, keys)) return func(obj1);
    return Object.fromEntries(
        Object.entries(obj1 as Obj).map(([k, v]) => [k, deepMapByKeysList(v, keys, func)] as const),
    ) as any;
}

export function deepMapByKeys<T, T2 extends Obj, T3>(
    obj1: T,
    obj2: T2,
    func: (a: T2) => T3,
): T3 | T | null {
    // thin wrapper over deepMapByKeysList — single recursion body (used to be duplicated)
    return deepMapByKeysList(obj1, Object.keys(obj2), func as (a: any) => T3) as any;
}

// ── Dedup: INTENTIONALLY not here (layering) ────────────────────────
// These deepListen*/listenSocket wrappers in client-auto ultimately drive same wire
// `*.callback(fn)`, which ALREADY deduped by rpc-client (subscribeShared, sendCall branch
// by path[-1]=="callback"). Dedup at this layer would be redundant: would double subscriber counter
// and unsub branch and could break network subscription while neighbor
// local consumer alive. Socket/id-pool owner (rpc-client) owns
// wire dedup; this layer remains thin per-subscriber multiplexor.

// ── Deep modifiers ───────────────────────────────────────────

const NOOP_LISTEN = createListen((_e) => {});

export function deepListenFirst<T>(obj: T, data?: Parameters<typeof listenSocketFirst>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketFirst(e as any, data)) as DeepSocketListenFirst<T>;
}

export function deepListenAll<T>(obj: T, data?: Parameters<typeof listenSocketAll>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketAll(e as any, data)) as DeepSocketListenAll<T>;
}

export function deepListenSmart<T>(obj: T, data?: Parameters<typeof listenSocketSmart>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketSmart(e as any, data)) as DeepSocketListenSmart<T>;
}
