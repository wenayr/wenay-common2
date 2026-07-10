"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transformer = exports.wrap = void 0;
exports.enhancedDecorator = enhancedDecorator;
exports.enhancedTransformer = enhancedTransformer;
exports.Decorator = Decorator;
exports.TransformerResult = TransformerResult;
exports.around = around;
function enhancedDecorator(fn, opt) {
    return (...args) => {
        opt?.beforeParams?.(...args);
        const modifiedArgs = opt?.modifyParams?.(...args) || args;
        const rawResult = fn(...modifiedArgs);
        opt?.afterParams?.(...args);
        if (rawResult instanceof Promise) {
            const optAsync = opt;
            return rawResult
                .then((res) => {
                optAsync?.onResult?.(res);
                return opt?.modifyResult?.(res) ?? res;
            })
                .catch((err) => {
                optAsync?.onCatch?.(err);
                throw err;
            })
                .finally(() => optAsync?.onFinally?.());
        }
        else {
            opt?.onResult?.(rawResult);
            return opt?.modifyResult?.(rawResult) ?? rawResult;
        }
    };
}
exports.wrap = enhancedDecorator;
function enhancedTransformer(fn, transform) {
    return (...args) => {
        const result = fn(...args);
        return transform([args, result]);
    };
}
function Decorator(fn, opt) {
    return enhancedDecorator(fn, {
        beforeParams: opt?.parameters,
        modifyParams: opt?.parametersModifier,
        afterParams: opt?.parametersAfter,
        onResult: opt?.result,
        modifyResult: opt?.resultModifier,
    });
}
function TransformerResult(fn, transform) {
    return enhancedTransformer(fn, transform);
}
function around(fn, transform) {
    return (...args) => transform([args, fn]);
}
exports.Transformer = around;
