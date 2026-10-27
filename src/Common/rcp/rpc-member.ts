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
    samples.push(...platformSamples())
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

// The host platform's classes (Node and browsers differ, so each is optional): URLSearchParams.delete,
// AbortController.abort or Buffer.write are as much the runtime's as an array's push.
function platformSamples() {
    const factories: (() => unknown)[] = [
        () => new URL('http://localhost/'),
        () => new URLSearchParams(''),
        () => new AbortController(),
        () => new AbortController().signal,
        () => new EventTarget(),
        () => new Event('sample'),
        () => new TextEncoder(),
        () => new TextDecoder(),
        () => new Headers(),
        () => new Blob([]),
        () => new FormData(),
        () => new Response(null),
        () => new Request('http://localhost/'),
        function messagePort() {
            // closed at once: a port is only a sample of its prototype and must not hold the process
            const channel = new MessageChannel()
            channel.port1.close()
            channel.port2.close()
            return channel.port1
        },
        () => (globalThis as {Buffer?: {alloc(size: number): unknown}}).Buffer?.alloc(0),
    ]
    const samples: unknown[] = []
    for (const factory of factories) {
        try {
            const sample = factory()
            if (sample != null) samples.push(sample)
        } catch {}
    }
    return samples
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
