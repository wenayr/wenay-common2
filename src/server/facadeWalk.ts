// ============================================================
//  src/server/facadeWalk.ts
//
//  The one facade walk behind the HTTP routes, the OpenAPI document and the MCP tool list:
//  nested enumerable string-keyed functions in key order, the parent kept as the call
//  context. Streams (Listen api objects, replay lines, branded `on`) and noStrict subtrees are
//  never routes or tools and are not walked; an adapter that turns some of them into something
//  else (MCP: Listen → resources, noStrict → resource templates) claims them through `take` first
//  and resolves below a noStrict node with dynamicMember (rcp/rpc-member.ts, the RPC rule). Everything else — cycles, forbidden keys,
//  empty segments — is refused identically, with the adapter's own label.
// ============================================================

import {isListenCallback, isListenOn} from '../Common/events/Listen'
import {isReplayListen} from '../Common/events/replay-listen'
import {isNoStrict} from '../Common/rcp/rpc-dynamic'
import {isSafeKey} from '../Common/rcp/rpc-limits'

export type FacadeWalkEntry = {
    path: string[]
    fn: (...args: any[]) => any
    context: object
}

export type FacadeWalkOptions = {
    /** Names the adapter in every refusal, e.g. 'HTTP facade'. */
    label: string
    /** Claims a node before the default (streams/dynamic skipped, functions listed, objects walked); true = handled. */
    take?: (value: unknown, path: string[], parent: object) => boolean
}

// ===================================================================
// node kinds every adapter shares
// ===================================================================
// RPC's order (rpc-server.ts transformTree, rpc-server-auto.ts resolveTransform): noStrict first, so a
// dynamic Proxy is never enumerated. A stream's members (emit, close, run, onClose, off) are the producer's.

export function facadeNodeKind(value: unknown) {
    if (isNoStrict(value)) return 'dynamic' as const
    if (isReplayListen(value) || isListenCallback(value)) return 'listen' as const
    if (isListenOn(value)) return 'on' as const
    return undefined
}

// ===================================================================
// the walk
// ===================================================================

export function walkFacade(object: object, options: FacadeWalkOptions) {
    const {label, take} = options
    const rootKind = facadeNodeKind(object)
    if (rootKind) throw new Error(`${label} object is a ${rootKind} node, not a facade`)
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
                // a stream or a dynamic subtree is never a route or a tool, and is not walked
                if (facadeNodeKind(value) != undefined) continue
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
