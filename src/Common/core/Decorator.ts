import { sleepAsync } from "./common";
type CommonOptions<T extends (...args: any[]) => any> = {
    beforeParams?: (...a: Parameters<T>) => void;
    modifyParams?: (...a: Parameters<T>) => Parameters<T>;
    afterParams?: (...a: Parameters<T>) => void;
    onResult?: (res: ReturnType<T>) => void;
    modifyResult?: (res: ReturnType<T>) => ReturnType<T>;
};

type AsyncExtras<T extends (...args: any[]) => any> = ReturnType<T> extends Promise<any>
    ? {
        onCatch?: (error: unknown) => void;
        onFinally?: () => void;
    }
    : {};

type EnhancedDecoratorOptions<T extends (...args: any[]) => any> = CommonOptions<T> & AsyncExtras<T>;

/** @deprecated use {@link wrap} */
export function enhancedDecorator<T extends (...args: any[]) => any>(
    fn: T,
    opt?: EnhancedDecoratorOptions<T>
): (...args: Parameters<T>) => ReturnType<T> {
    return (...args: Parameters<T>) => {
        opt?.beforeParams?.(...args);
        const modifiedArgs = opt?.modifyParams?.(...args) || args;
        const rawResult = fn(...modifiedArgs);
        opt?.afterParams?.(...args);

        if (rawResult instanceof Promise) {
            const optAsync = opt as unknown as EnhancedDecoratorOptions<() => Promise<any>>;
            return rawResult
                .then((res) => {
                    optAsync?.onResult?.(res);
                    return opt?.modifyResult?.(res) ?? res;
                })
                .catch((err) => {
                    optAsync?.onCatch?.(err);
                    throw err;   // onCatch is an observer, not a handler: promise must remain rejected
                })
                .finally(() => optAsync?.onFinally?.()) as ReturnType<T>;
        } else {
            opt?.onResult?.(rawResult);
            return opt?.modifyResult?.(rawResult) ?? rawResult;
        }
    };
}

// === wrap — idiomatic name for enhancedDecorator ===
// Pure alias: preserves generics + hook semantics byte-for-byte (axios-interceptor shape).
export const wrap = enhancedDecorator

/**
 * Wraps function to perform specific post-processing.
 * @deprecated use {@link wrap}
 */
export function enhancedTransformer<T extends (...args: any[]) => any, R>(
    fn: T,
    transform: (data: [args: Parameters<T>, result: ReturnType<T>]) => R
): (...args: Parameters<T>) => R {
    return (...args: Parameters<T>): R => {
        const result = fn(...args);
        // Transform result taking into account original parameters
        return transform([args, result]) as R;
    };
}

/**
 * Support for old `Decorator` method via redirection to new enhanced version.
 * @deprecated use {@link wrap}
 */
export function Decorator<T extends (...args: any[]) => any>(
    fn: T,
    opt?: {
        parameters?: (...a: Parameters<T>) => any,
        parametersModifier?: (...a: Parameters<T>) => Parameters<T>,
        parametersAfter?: (...a: Parameters<T>) => any,
        result?: (res: ReturnType<T>) => any,
        resultModifier?: (res: ReturnType<T>) => ReturnType<T>,
    }
) {
    // Convert old parameters to new ones
    return enhancedDecorator(fn, {
        beforeParams: opt?.parameters,
        modifyParams: opt?.parametersModifier,
        afterParams: opt?.parametersAfter,
        onResult: opt?.result,
        modifyResult: opt?.resultModifier,
    });
}

/**
 * Support for old `Transformer` method via redirection to new enhanced version.
 * @deprecated use {@link wrap}
 */
export function TransformerResult<T extends (...args: any[]) => any, R>(
    fn: T,
    transform: (data: [args: Parameters<T>, result: ReturnType<T>]) => R
) {
    return enhancedTransformer(fn, transform);
}

/**
 * AOP "around advice": `transform` receives the UN-CALLED `fn`, so the caller
 * controls timing (may skip / replace / defer the invocation). lodash `_.wrap` shape.
 */
export function around<T extends (...args: any[]) => any, R>(
    fn: T,
    transform: (data: [args: Parameters<T>, fn: T]) => R
): (...args: Parameters<T>) => R {
    return (...args: Parameters<T>): R => transform([args, fn]) as R
}

/** @deprecated use {@link around} */
export const Transformer = around
