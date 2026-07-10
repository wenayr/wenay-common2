type CommonOptions<T extends (...args: any[]) => any> = {
    beforeParams?: (...a: Parameters<T>) => void;
    modifyParams?: (...a: Parameters<T>) => Parameters<T>;
    afterParams?: (...a: Parameters<T>) => void;
    onResult?: (res: ReturnType<T>) => void;
    modifyResult?: (res: ReturnType<T>) => ReturnType<T>;
};
type AsyncExtras<T extends (...args: any[]) => any> = ReturnType<T> extends Promise<any> ? {
    onCatch?: (error: unknown) => void;
    onFinally?: () => void;
} : {};
type EnhancedDecoratorOptions<T extends (...args: any[]) => any> = CommonOptions<T> & AsyncExtras<T>;
export declare function enhancedDecorator<T extends (...args: any[]) => any>(fn: T, opt?: EnhancedDecoratorOptions<T>): (...args: Parameters<T>) => ReturnType<T>;
export declare const wrap: typeof enhancedDecorator;
export declare function enhancedTransformer<T extends (...args: any[]) => any, R>(fn: T, transform: (data: [args: Parameters<T>, result: ReturnType<T>]) => R): (...args: Parameters<T>) => R;
export declare function Decorator<T extends (...args: any[]) => any>(fn: T, opt?: {
    parameters?: (...a: Parameters<T>) => any;
    parametersModifier?: (...a: Parameters<T>) => Parameters<T>;
    parametersAfter?: (...a: Parameters<T>) => any;
    result?: (res: ReturnType<T>) => any;
    resultModifier?: (res: ReturnType<T>) => ReturnType<T>;
}): (...args: Parameters<T>) => ReturnType<T>;
export declare function TransformerResult<T extends (...args: any[]) => any, R>(fn: T, transform: (data: [args: Parameters<T>, result: ReturnType<T>]) => R): (...args: Parameters<T>) => R;
export declare function around<T extends (...args: any[]) => any, R>(fn: T, transform: (data: [args: Parameters<T>, fn: T]) => R): (...args: Parameters<T>) => R;
export declare const Transformer: typeof around;
export {};
