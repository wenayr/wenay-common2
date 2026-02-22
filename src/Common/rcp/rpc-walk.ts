// rpc-walk.ts

import { idPool } from "../id-pool";
import { isSafeKey, PayloadLimitError, type RpcLimits } from "./rpc-limits";

const FN_MARKER = "$_f";

export function walk(
    val: any,
    onLeaf: (v: any) => any,
    lim?: Required<RpcLimits>,
    depth = 0,
): any {
    if (lim) {
        if (depth > lim.maxDepth) throw new PayloadLimitError("max depth exceeded");
        if (typeof val == "string" && val.length > lim.maxStringLen) throw new PayloadLimitError("string too long");
    }
    if (val == null || typeof val !== "object") return onLeaf(val);
    if (val[FN_MARKER] !== undefined) return onLeaf(val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen) throw new PayloadLimitError("array too long");
        return val.map(v => walk(v, onLeaf, lim, depth + 1));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys) throw new PayloadLimitError("too many keys in object");
    const o: any = {};
    for (const k of keys) if (isSafeKey(k)) o[k] = walk(val[k], onLeaf, lim, depth + 1);
    return o;
}

export function pack(
    args: any[],
    pool: idPool,
    cbStore: Map<number, Function>,
    cbIds: number[],
): any[] {
    return args.map(v => walk(v, leaf => {
        if (typeof leaf == "function") {
            const id = pool.next();
            cbStore.set(id, leaf);
            cbIds.push(id);
            return { [FN_MARKER]: id };
        }
        return leaf;
    }));
}

const _stopRegistry = new WeakMap<Function, () => void>();

export function rpcEndCallback(fn: Function) {
    _stopRegistry.get(fn)?.();
}

export function unpack(
    args: any[],
    sender: (id: number, a: any[]) => void,
    onEnd: (id: number) => void,
    lim?: Required<RpcLimits>,
): any[] {
    let cbCount = 0;
    return args.map(v => walk(v, leaf => {
        if (leaf != null && typeof leaf == "object" && leaf[FN_MARKER] !== undefined) {
            if (lim && ++cbCount > lim.maxCallbacks) throw new PayloadLimitError("too many callbacks");
            const id = leaf[FN_MARKER];
            if (typeof id !== "number" || !Number.isFinite(id)) throw new PayloadLimitError("invalid callback id");
            const wrapper = (...a: any[]) => {
                if (a[0] == "___STOP") { onEnd(id); return; }
                sender(id, a);
            };
            _stopRegistry.set(wrapper, () => onEnd(id));
            return wrapper;
        }
        return leaf;
    }, lim));
}

export const errToObj = (e: any) =>
    e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e;

export const resolveCA = (path: string[], args: any[]): [string[], any[]] => {
    const last = path[path.length - 1];
    if (last == "call") return [path.slice(0, -1), args.slice(1)];
    if (last == "apply") return [path.slice(0, -1), args[1] ?? []];
    return [path, args];
};