import { MyError } from '../toError/myThrow';
import type { ServiceResourceOptions } from './resource-definition';
export declare function resourceBudgets(options?: ServiceResourceOptions): {
    open: number;
    close: number;
};
export declare function resourceError(code: string): MyError<unknown>;
export declare function resourceWithin<T>(work: Promise<T>, ms: number, code: string, signal?: AbortSignal): Promise<T>;
