// listen-deep.ts

import { funcListenCallbackBase, type ListenOn } from "../events/Listen";
import type { ReplayEvent } from "../events/replay-listen";
import { listenSocket, listenSocketFirst, listenSocketAll, listenSocketSmart, type tSubHandle } from "./listen-socket";

// Клиентская проекция результата listenSocket: on(fn) отдаёт ВЫЗЫВАЕМЫЙ
// хендл (off()/await/.off/.unsubscribe/.removeCallback), callback/removeCallback — legacy.
// Только ТИП: нужен потому, что БАЗОВЫЙ listenSocket намеренно типизирован как
// Promise<void> (его ждёт rpc-server-auto: `done.then`), а клиентский слой должен
// видеть хендл. First/All/Smart уже получают tSubHandle через свой каст.
// on/callback отдают tSubHandle & Promise<void>: пересечение с Promise<void> хранит
// строгую аддитивность — старое `const p: Promise<void> = deep.ev.callback(fn)` всё ещё
// компилится, а вызываемость/await/.off/.unsubscribe/.removeCallback доступны поверх.
type WithSubHandle<R> = R extends { callback: (...a: infer A) => any }
    ? Omit<R, 'callback' | 'on' | 'once'> & {
          callback: (...a: A) => tSubHandle & Promise<void>;
          /** Основное имя подписки по факту установки колбэка. */
          on: (...a: A) => tSubHandle & Promise<void>;
          /** Однократная подписка: одно событие, затем стрим закрывается. */
          once: (...a: A) => tSubHandle & Promise<void>;
      }
    : R

type Obj = Record<string, any>;
type ListenBase<T extends any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

// Надежно достаем типы аргументов из метода addListen
export type InferArgs<T> = T extends { addListen: (cb: (...args: infer R) => void, ...rest: any[]) => any } ? R : never;

// Клиентская проекция merged replay-узла (rpc-server-auto, Feature A): ПОД ТЕМ ЖЕ
// ключом легаси Listen-поверхность (байт-в-байт plain) плюс replay-провод.
// Структурно совместим с ReplayRemote — deep.key отдаётся в replaySubscribe как есть.
export type ReplaySocketListen<Z extends any[]> = WithSubHandle<ReturnType<typeof listenSocket<Z>>> & {
    /** Линия конвертов {seq, ts, event} — live-часть replay-клиента (политика 'queue'). */
    line: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>
    /** Линия политики 'frame': на лаге сервер вправе пропускать, восстанавливая кадром. */
    frameLine: WithSubHandle<ReturnType<typeof listenSocket<[ReplayEvent<Z>]>>>
    /** Хвост журнала после seq. null = вытеснено. */
    since: (seq: number) => Promise<ReplayEvent<Z>[] | null>
    /** Свежий keyframe. null = current-провайдер не задан. */
    keyframe: () => Promise<ReplayEvent<Z> | null>
    /** Кадр: catch-up одним вызовом (хвост/мини-кадрик/keyframe — выбирает линия). */
    frame: (seq: number, hint?: unknown) => Promise<ReplayEvent<Z>[]>
}
// Детекция replay-члена на уровне типов — зеркалит рантайм-бренд (структурно:
// plain Listen не имеет getSince/keyframe/line, store-Listen — getSince/line).
export type IsReplayMember<V> = V extends { addListen: Function; getSince: Function; keyframe: Function; line: object } ? true : false

// Типы для различных вариантов Socket-лиссенеров
export type DeepSocketListen<T> = {
    [K in keyof T]: IsReplayMember<T[K]> extends true
        ? ReplaySocketListen<InferArgs<T[K]>>
        : T[K] extends { addListen: Function }
        ? WithSubHandle<ReturnType<typeof listenSocket<InferArgs<T[K]>>>>
        : T[K] extends ListenOn<infer Z>   // голый on (брендирован) → та же подписка {on, once, close, ...}
        ? WithSubHandle<ReturnType<typeof listenSocket<Z>>>
        : T[K] extends (...a: any[]) => any ? T[K]
        : T[K] extends Promise<any> ? T[K] // экземпляры Promise проходят как есть (typeof Promise ловил только конструктор)
        : T[K] extends typeof Promise ? T[K]
        : T[K] extends object ? DeepSocketListen<T[K]>
        : T[K];
};

export type DeepSocketListenFirst<T> = {
    [K in keyof T]: T[K] extends { addListen: Function }
        ? ReturnType<typeof listenSocketFirst<InferArgs<T[K]>>>
        : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketFirst<Z>>
        : T[K] extends (...a: any[]) => any ? T[K]
        : T[K] extends Promise<any> ? T[K] // экземпляры Promise проходят как есть (typeof Promise ловил только конструктор)
        : T[K] extends typeof Promise ? T[K]
        : T[K] extends object ? DeepSocketListenFirst<T[K]> 
        : T[K];
};

export type DeepSocketListenAll<T> = {
    [K in keyof T]: T[K] extends { addListen: Function }
        ? ReturnType<typeof listenSocketAll<InferArgs<T[K]>>>
        : T[K] extends ListenOn<infer Z> ? ReturnType<typeof listenSocketAll<Z>>
        : T[K] extends (...a: any[]) => any ? T[K]
        : T[K] extends Promise<any> ? T[K] // экземпляры Promise проходят как есть (typeof Promise ловил только конструктор)
        : T[K] extends typeof Promise ? T[K]
        : T[K] extends object ? DeepSocketListenAll<T[K]> 
        : T[K];
};

// export type DeepSocketListenSmart<T> = {
//     [K in keyof T]: T[K] extends { addListen: Function }
//         ? ReturnType<typeof listenSocketSmart<InferArgs<T[K]>>>
//         : T[K] extends (...a: any[]) => any ? T[K]
//         : T[K] extends typeof Promise ? T[K]
//         : T[K] extends object ? DeepSocketListenSmart<T[K]>
//         : T[K];
// };
export type DeepSocketListenSmart<T> = {
    [K in keyof T]: IsReplayMember<NonNullable<T[K]>> extends true
        ? ReplaySocketListen<InferArgs<NonNullable<T[K]>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends { addListen: Function }
        ? ReturnType<typeof listenSocketSmart<InferArgs<NonNullable<T[K]>>>> | Extract<T[K], undefined | null>
        : NonNullable<T[K]> extends ListenOn<infer Z> ? ReturnType<typeof listenSocketSmart<Z>>
        : NonNullable<T[K]> extends (...a: any[]) => any ? T[K]
            : NonNullable<T[K]> extends Promise<any> ? T[K] // экземпляры Promise проходят как есть
            : NonNullable<T[K]> extends typeof Promise ? T[K]
                : NonNullable<T[K]> extends object ? DeepSocketListenSmart<T[K]>
                    : T[K];
};
// ── Утилиты ─────────────────────────────────────────────────────

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
    // тонкая обёртка над deepMapByKeysList — единое тело рекурсии (раньше дублировалось)
    return deepMapByKeysList(obj1, Object.keys(obj2), func as (a: any) => T3) as any;
}

// ── Дедуп: НАМЕРЕННО не здесь (layering) ────────────────────────
// Эти deepListen*/listenSocket-обёртки в client-auto в итоге гонят тот же провод
// `*.callback(fn)`, который УЖЕ дедупит rpc-client (subscribeShared, ветка sendCall
// по path[-1]=="callback"). Дедуп на этом слое был бы повторным: задвоил бы счётчик
// потребителей и развилку отписки и мог бы оборвать сетевую подписку, пока жив
// соседний локальный потребитель. Владелец сокета/id-пула (rpc-client) и владеет
// wire-дедупом; этот слой остаётся тонким per-subscriber мультиплексором.

// ── Deep-модификаторы ───────────────────────────────────────────

const NOOP_LISTEN = funcListenCallbackBase((_e) => {});

export function deepListenFirst<T>(obj: T, data?: Parameters<typeof listenSocketFirst>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketFirst(e as any, data)) as DeepSocketListenFirst<T>;
}

export function deepListenAll<T>(obj: T, data?: Parameters<typeof listenSocketAll>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketAll(e as any, data)) as DeepSocketListenAll<T>;
}

export function deepListenSmart<T>(obj: T, data?: Parameters<typeof listenSocketSmart>[1]) {
    return deepMapByKeys(obj, NOOP_LISTEN, (e) => listenSocketSmart(e as any, data)) as DeepSocketListenSmart<T>;
}