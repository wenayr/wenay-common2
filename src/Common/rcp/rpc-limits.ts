const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const isSafeKey = (k: string) => !BANNED_KEYS.has(k);

export type RpcLimits = {
    maxDepth?: number;
    maxKeys?: number;
    maxArgs?: number;
    maxArrayLen?: number;
    maxStringLen?: number;
    maxCallbacks?: number;
    maxPathLen?: number;
};

const DEFAULT_LIMITS: Required<RpcLimits> = {
    maxDepth: 32,
    maxKeys: 1000,
    maxArgs: 64,
    maxArrayLen: 10_000,
    maxStringLen: 1_000_000,
    maxCallbacks: 100,
    maxPathLen: 16,
};

export const resolveLimits = (opts?: RpcLimits): Required<RpcLimits> =>
    opts ? { ...DEFAULT_LIMITS, ...opts } : DEFAULT_LIMITS;

export class PayloadLimitError extends Error {
    constructor(reason: string) {
        super(`Payload limit exceeded: ${reason}`);
        this.name = "PayloadLimitError";
    }
}
