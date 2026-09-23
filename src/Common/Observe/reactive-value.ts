// Private admission boundary shared by the reactive engine and whole-Store replacement.
export function isReactiveObj(value: any) {
    if (value == null || typeof value != 'object') return false
    if (Array.isArray(value)) return true
    const prototype = Object.getPrototypeOf(value)
    return prototype == Object.prototype || prototype == null
}

export function prepareReactiveValue<T>(value: T, toRaw: <V>(value: V) => V): T {
    const raw = toRaw(value)
    // An existing reactive target has already passed admission. Preserve its raw identity.
    if (!Object.is(raw, value) || !isReactiveObj(value)) return raw
    const seen = new WeakSet<object>()
    const pending = [value as object]
    const replacements: {target: object, key: PropertyKey, descriptor: PropertyDescriptor}[] = []
    while (pending.length) {
        const target = pending.pop()!
        if (seen.has(target)) continue
        seen.add(target)
        for (const key of Reflect.ownKeys(target)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)!
            // Accessors and rich leaves keep their existing user-defined/opaque behavior.
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue
            const child = descriptor.value
            const next = toRaw(child)
            if (!Object.is(child, next)) {
                if (!descriptor.configurable && !descriptor.writable) {
                    throw new TypeError('Observe cannot unwrap a reactive value in non-writable, non-configurable property ' + String(key))
                }
                replacements.push({target, key, descriptor: {...descriptor, value: next}})
            } else if (isReactiveObj(child)) pending.push(child)
        }
    }
    // Resolve the entire input before rebinding any path, including sibling swaps.
    // Preflight immutable slots before changing even the caller's replacement containers.
    for (const {target, key, descriptor} of replacements) {
        if (!Reflect.defineProperty(target, key, descriptor)) {
            throw new TypeError('Observe cannot store an unwrapped value at property ' + String(key))
        }
    }
    return raw
}
