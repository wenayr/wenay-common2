"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcScope = createRpcScope;
exports.bindRpcScopes = bindRpcScopes;
exports.inheritRpcScopes = inheritRpcScopes;
exports.rpcScopeFor = rpcScopeFor;
exports.currentRpcScope = currentRpcScope;
exports.transformRpcScoped = transformRpcScoped;
const myThrow_1 = require("../../toError/myThrow");
function createRpcScope() {
    const controller = new AbortController();
    const cleanup = new Set();
    const errors = [];
    function error() { return new myThrow_1.MyError('Resource generation is closed', 'E_RESOURCE_CLOSED'); }
    function check() { if (controller.signal.aborted)
        throw error(); }
    function release(dispose) {
        try {
            dispose();
        }
        catch (failure) {
            errors.push(failure);
        }
    }
    function own(dispose) {
        if (controller.signal.aborted)
            release(dispose);
        else
            cleanup.add(dispose);
        return function forget() { cleanup.delete(dispose); };
    }
    function close() {
        if (!controller.signal.aborted) {
            controller.abort(error());
            for (const dispose of [...cleanup])
                release(dispose);
            cleanup.clear();
        }
        return errors.slice();
    }
    return { check, error, own, close, active: () => !controller.signal.aborted, signal: controller.signal };
}
const bindings = new WeakMap();
function bindRpcScopes(hooks, resolve) {
    bindings.set(hooks, { resolve });
    return hooks;
}
function inheritRpcScopes(source, target) {
    const binding = source && bindings.get(source);
    if (binding)
        bindings.set(target, { resolve: binding.resolve });
    return target;
}
function rpcScopeFor(hooks, path) {
    return hooks && bindings.get(hooks)?.resolve(path);
}
function currentRpcScope(hooks) { return bindings.get(hooks)?.current; }
function transformRpcScoped(hooks, value, scope) {
    if (!hooks?.resolveTransform)
        return value;
    const binding = bindings.get(hooks);
    if (!binding)
        return hooks.resolveTransform(value);
    const previous = binding.current;
    binding.current = scope;
    try {
        return hooks.resolveTransform(value);
    }
    finally {
        binding.current = previous;
    }
}
