// ============================================================
//  src/Common/rcp/rpc-member.ts
//
//  How a name resolves below a noStrict node — one rule for the RPC string path and the MCP
//  templates/dispatcher. `in` decides membership, because the application resolves that subtree
//  itself and a proxy's has trap is its access point (doc/RPC-AUTH.md Rule 3). What `in` also
//  finds — the methods the runtime put on its own prototypes — never counts unless the node owns
//  it: data inherits them (Object's __defineGetter__, an array's push, a Map's clear, a Date's
//  setTime), the application never wrote them as call targets.
// ============================================================

import {isSafeKey} from './rpc-limits'

// Collected from the prototype chains of samples, so every intrinsic prototype a value can sit on
// is covered; matched by identity, so a host class overriding push or clear keeps its own method.
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

/** The member `key` of a node below noStrict, or undefined when absent or a builtin the node does
 *  not own. One has, one get; an own check only for builtin names. */
export function dynamicMember(node: object, key: string) {
    if (key.length == 0 || !isSafeKey(key)) return undefined
    if (!Reflect.has(node, key)) return undefined
    const builtin = key in Object.prototype || (typeof node == 'function' && key in Function.prototype)
    if (builtin && !Object.prototype.hasOwnProperty.call(node, key)) return undefined
    const value = (node as any)[key] as unknown
    // by identity, after the get: a host class that overrides push or set keeps its own method
    if (BUILTIN_METHODS.get(key)?.has(value) && !Object.prototype.hasOwnProperty.call(node, key)) return undefined
    return value
}
