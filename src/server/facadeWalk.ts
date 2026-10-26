// ============================================================
//  src/server/facadeWalk.ts
//
//  The one facade walk behind the HTTP routes, the OpenAPI document and the MCP tool list:
//  nested enumerable string-keyed functions in key order, the parent kept as the call
//  context. An adapter that treats some nodes differently (MCP: Listen, noStrict) says so
//  through `take`; everything else — cycles, forbidden keys, empty segments — is refused
//  identically, with the adapter's own label in the message.
// ============================================================

import {isSafeKey} from '../Common/rcp/rpc-limits'

export type FacadeWalkEntry = {
    path: string[]
    fn: (...args: any[]) => any
    context: object
}

export type FacadeWalkOptions = {
    /** Names the adapter in every refusal, e.g. 'HTTP facade'. */
    label: string
    /** Claims a node before the default handling; true = handled, do not walk or register it. */
    take?: (value: unknown, path: string[], parent: object) => boolean
}

export function walkFacade(object: object, options: FacadeWalkOptions) {
    const {label, take} = options
    const entries: FacadeWalkEntry[] = []
    const ancestors = new Set<object>()

    function visit(node: object, path: string[]) {
        if (ancestors.has(node)) {
            throw new Error(`${label} contains a circular branch at ${JSON.stringify(path)}`)
        }
        ancestors.add(node)
        try {
            for (const key of Object.keys(node)) {
                if (!isSafeKey(key)) throw new Error(`${label} contains a forbidden key: ${key}`)
                if (key.length == 0) throw new Error(`${label} contains an empty path segment`)

                const value = (node as any)[key]
                const nextPath = [...path, key]
                if (take?.(value, nextPath, node)) continue
                if (typeof value == 'function') {
                    entries.push({path: nextPath, fn: value, context: node})
                    continue
                }
                if (value != null && typeof value == 'object') visit(value, nextPath)
            }
        } finally {
            ancestors.delete(node)
        }
    }

    visit(object, [])
    return entries
}

/** The member at `path`, or undefined when a segment is missing. Own keys only, as the walk. */
export function facadeMember(object: object, path: readonly string[]) {
    let node: any = object
    for (const key of path) {
        if (node == null || (typeof node != 'object' && typeof node != 'function')) return undefined
        if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined
        node = node[key]
    }
    return node as unknown
}
