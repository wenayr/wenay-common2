// ============================================================
//  src/server/facadeWalk.ts
//
//  The one facade walk behind the HTTP routes, the OpenAPI document and the MCP tool list:
//  nested enumerable string-keyed functions in key order, the parent kept as the call
//  context. Streams (Listen api objects, replay lines, branded `on`) and noStrict subtrees are
//  never routes or tools and are not walked; an adapter that turns some of them into something
//  else (MCP: Listen → resources, noStrict → resource templates) claims them through `take` first
//  and resolves below a noStrict node with dynamicMember. Everything else — cycles, forbidden keys,
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

// ===================================================================
// members below a noStrict node
// ===================================================================

// Methods the runtime put on its own prototypes. Data inherits them (an array's push, a Map's clear,
// a Date's setTime): the host never wrote them as call targets. Collected from the prototype chains
// of samples, so every intrinsic prototype a value can sit on is covered.
const BUILTIN_METHODS = collectBuiltinMethods()

function collectBuiltinMethods() {
    const samples: unknown[] = [
        {}, function plain() {}, async function asyncPlain() {}, (function* generator() {})(), (async function* asyncGenerator() {})(),
        [], [][Symbol.iterator](), ''[Symbol.iterator](), new Map(), new Map().entries(), new Set(), new Set().values(),
        new WeakMap(), new WeakSet(), new Date(0), /x/, /x/[Symbol.matchAll](''), Promise.resolve(), new Error(),
        new ArrayBuffer(0), new Uint8Array(0), new DataView(new ArrayBuffer(0)),
        Object(''), Object(0), Object(false), Object(Symbol()), Object(BigInt(0)),
    ]
    if (typeof WeakRef == 'function') samples.push(new WeakRef({}))
    const methods = new Map<string, Set<unknown>>()
    const seen = new Set<object>()
    for (const sample of samples) {
        for (let proto = Object.getPrototypeOf(sample); proto != null && !seen.has(proto); proto = Object.getPrototypeOf(proto)) {
            seen.add(proto)
            for (const name of Object.getOwnPropertyNames(proto)) {
                const value = Object.getOwnPropertyDescriptor(proto, name)?.value
                if (typeof value != 'function') continue
                let same = methods.get(name)
                if (!same) methods.set(name, same = new Set())
                same.add(value)
            }
        }
    }
    return methods
}

/** A member below a noStrict node, resolved as RPC resolves it there: `in` decides (a proxy's has trap
 *  is its access point), but a method inherited from a builtin prototype (Object, Function, Array,
 *  Map, Date…) never counts unless own. undefined = absent. */
export function dynamicMember(node: object, key: string) {
    if (key.length == 0 || !isSafeKey(key)) return undefined
    if (!Reflect.has(node, key)) return undefined
    // own check only for builtin names: one trap less for every ordinary key
    const builtin = key in Object.prototype || (typeof node == 'function' && key in Function.prototype)
    if (builtin && !Object.prototype.hasOwnProperty.call(node, key)) return undefined
    const value = (node as any)[key] as unknown
    // by identity, after the get: a host class that overrides push or set keeps its own method
    if (BUILTIN_METHODS.get(key)?.has(value) && !Object.prototype.hasOwnProperty.call(node, key)) return undefined
    return value
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
