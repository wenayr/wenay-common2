// =====================================================================
// Static key selection — one normal form and one identity for selected lines
// =====================================================================
// Shared by every Store line that carries a server-owned key selection
// (store-replay-view, store-lazy-line): the same key set must always produce
// the same selectionId, or a cursor could never be matched across lines.

export function normalizeStoreSelectionKeys(keys: readonly string[], label: string) {
    if (!Array.isArray(keys)) throw new TypeError(label + ': keys must be an array')
    const unique = new Set<string>()
    for (const key of keys) {
        if (typeof key != 'string') {
            throw new TypeError(label + ': keys must contain only strings')
        }
        unique.add(key)
    }
    return Object.freeze([...unique].sort())
}

/**
 * Identity of a normalized key set: same keys => same id, any difference => a
 * different id with overwhelming probability (two independent 32-bit FNV-style
 * streams over length-prefixed keys). Not cryptographic — selections are not
 * secrets, the id only detects that a cursor was issued for a different set.
 */
export function storeSelectionId(keys: readonly string[]) {
    let first = 0x811c9dc5
    let second = 0x9e3779b9
    for (const key of keys) {
        const text = key.length + ':' + key + ';'
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index)
            first = Math.imul(first ^ code, 0x01000193)
            second = Math.imul(second ^ code, 0x85ebca6b)
        }
    }
    const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
    return 'keys-v1:' + keys.length + ':' + hex(first) + hex(second)
}
