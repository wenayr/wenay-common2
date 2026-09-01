// =====================================================================
// Fragment constructor — the one build-a-facade loop of the command corridor
// =====================================================================
// Every corridor facade (account-bound, trusted-hop, token-envelope, relay)
// is the same shape: an object of per-name bound calls that differ only in
// the argument prefix. One constructor, five facades — a change to fragment
// construction lands ONCE.
// Deliberately NOT on the public Command facade (command-index): this is the
// corridor's internal building block, not a consumer surface.

// A fragment is a plain object served over RPC, so it keeps Object.prototype;
// these names would bind onto the prototype (or shadow it) instead of becoming
// a command — refuse them at construction, where the mistake is loud.
const RESERVED_COMMAND_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

export function bindCommandNames<F>(
    names: readonly string[],
    make: (name: string) => (...args: any[]) => unknown,
) {
    const bound = {} as F
    for (const name of names) {
        if (RESERVED_COMMAND_NAMES.has(name)) throw new Error('command name is reserved: ' + name)
        Object.defineProperty(bound, name, {value: make(name), enumerable: true, writable: true, configurable: true})
    }
    return bound
}
