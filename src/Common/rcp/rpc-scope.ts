import {MyError} from '../../toError/myThrow'

// Internal ownership seam: scopes belong to a resource, not to a shared Listen source.
export function createRpcScope() {
    const controller = new AbortController()
    const cleanup = new Set<() => void>()
    const errors: unknown[] = []
    function error() { return new MyError('Resource generation is closed', 'E_RESOURCE_CLOSED') }
    function check() { if (controller.signal.aborted) throw error() }
    function release(dispose: () => void) {
        try { dispose() } catch (failure) { errors.push(failure) }
    }
    function own(dispose: () => void) {
        if (controller.signal.aborted) release(dispose)
        else cleanup.add(dispose)
        return function forget() { cleanup.delete(dispose) }
    }
    function close() {
        if (!controller.signal.aborted) {
            controller.abort(error())
            for (const dispose of [...cleanup]) release(dispose)
            cleanup.clear()
        }
        return errors.slice()
    }
    return {check, error, own, close, active: () => !controller.signal.aborted, signal: controller.signal as AbortSignal}
}
export type RpcScope = ReturnType<typeof createRpcScope>

type ScopeBinding = {resolve: (path: readonly string[]) => RpcScope | undefined, current?: RpcScope}
const bindings = new WeakMap<object, ScopeBinding>()

export function bindRpcScopes<T extends object>(hooks: T, resolve: ScopeBinding['resolve']) {
    bindings.set(hooks, {resolve})
    return hooks
}
export function inheritRpcScopes<T extends object>(source: object | undefined, target: T) {
    const binding = source && bindings.get(source)
    if (binding) bindings.set(target, {resolve: binding.resolve})
    return target
}
export function rpcScopeFor(hooks: object | undefined, path: readonly string[]) {
    return hooks && bindings.get(hooks)?.resolve(path)
}
export function currentRpcScope(hooks: object) { return bindings.get(hooks)?.current }

// Transform is synchronous; save/restore also covers reentrant schema resolution.
export function transformRpcScoped(hooks: {resolveTransform?: (value: any) => any} | undefined, value: any, scope?: RpcScope) {
    if (!hooks?.resolveTransform) return value
    const binding = bindings.get(hooks)
    if (!binding) return hooks.resolveTransform(value)
    const previous = binding.current
    binding.current = scope
    try { return hooks.resolveTransform(value) }
    finally { binding.current = previous }
}
