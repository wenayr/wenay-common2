// listen-socket.ts

import { funcListenCallback, funcListenCallbackBase, type Listener } from "../events/Listen";

type ListenCallbackResult<T extends any[] = any[]> = ReturnType<typeof funcListenCallbackBase<T>>;

export function listenSocket<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    d?: {
        readonly status?: () => boolean;
        readonly addListenClose?: ListenCallbackResult<any>;
        readonly stop?: (x: Listener<Z>) => any;
        readonly paramsModify?: (...e: Z) => any[];
    },
) {
    const { stop, addListenClose, status, paramsModify } = d ?? {};
    const { addListen, removeListen, eventClose, removeEventClose } = e;

    let last: Listener<Z> | null = null;
    let active: Listener<any> | null = null;
    let resolveWait: (() => void) | null = null;

    function finish() {
        if (resolveWait) { resolveWait(); resolveWait = null; }
    }

    function removeCallback() {
        if (last) { stop?.(last); last = null; }
        if (active) { removeListen(active); active = null; }
        addListenClose?.removeListen(removeCallback);
        finish();
        return true;
    }

    async function callback(z: Listener<Z>): Promise<void> {
        if (last) stop?.(last);
        if (active) removeListen(active);
        if (resolveWait) { resolveWait(); resolveWait = null; }

        last = z;

        let handler: Listener<any> = z;
        if (paramsModify) {
            const orig = handler;
            handler = (...a: any[]) => orig(...paramsModify(...(a as Z)));
        }
        if (status) {
            const wrapped = handler;
            handler = (...a: any[]) => {
                if (status()) wrapped(...a);
                else removeCallback();
            };
        }

        const inner = handler;
        active = (...a: any[]) => {
            if (a[0] === "___STOP") {
                z(...a as Z);
                if (last) { stop?.(last); }
                last = null;
                if (active) { removeListen(active); active = null; }
                addListenClose?.removeListen(removeCallback);
                finish();
                return;
            }
            inner(...a);
        };

        addListen(active, removeCallback);
        addListenClose?.addListen(removeCallback);

        return new Promise<void>((resolve) => {
            resolveWait = () => { resolve() };
        });
    }

    return { callback, removeCallback };
}

export function listenSocketFirst<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, {
        ...options,
        paramsModify: ((...args: any[]) => [args[0]]) as (...e: Z) => any[],
    });
    type SingleArgCallback = (a: Z[0]) => void;
    return {
        callback: r.callback as unknown as (z: SingleArgCallback) => void,
        removeCallback: r.removeCallback,
    };
}

export function listenSocketAll<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as (z: (...args: Z) => void) => void,
        removeCallback: r.removeCallback,
    };
}

type SmartCallback<Z extends any[]> = Z extends [infer Single]
    ? (a: Single) => void
    : (...args: Z) => void;

export function listenSocketSmart<Z extends any[] = any[]>(
    e: ListenCallbackResult<Z>,
    options?: Omit<Parameters<typeof listenSocket>[1], "paramsModify">,
) {
    const r = listenSocket(e, { ...options });
    return {
        callback: r.callback as unknown as (z: SmartCallback<Z>) => void,
        removeCallback: r.removeCallback,
    };
}