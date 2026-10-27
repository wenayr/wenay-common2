"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dynamicMember = dynamicMember;
const rpc_limits_1 = require("./rpc-limits");
const BUILTIN_METHODS = collectBuiltinMethods();
function collectBuiltinMethods() {
    const samples = [
        {}, function plain() { }, async function asyncPlain() { }, (function* generator() { })(), (async function* asyncGenerator() { })(),
        [], [][Symbol.iterator](), ''[Symbol.iterator](), new Map(), new Map().entries(), new Set(), new Set().values(),
        new WeakMap(), new WeakSet(), new Date(0), /x/, /x/[Symbol.matchAll](''), Promise.resolve(), new Error(),
        new ArrayBuffer(0), new Uint8Array(0), new DataView(new ArrayBuffer(0)),
        Object(''), Object(0), Object(false), Object(Symbol()), Object(BigInt(0)),
    ];
    if (typeof WeakRef == 'function')
        samples.push(new WeakRef({}));
    samples.push(...platformSamples());
    const methods = new Map();
    const seen = new Set();
    for (const sample of samples) {
        for (let proto = Object.getPrototypeOf(sample); proto != null && !seen.has(proto); proto = Object.getPrototypeOf(proto)) {
            seen.add(proto);
            for (const name of Object.getOwnPropertyNames(proto)) {
                const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
                if (typeof value != 'function')
                    continue;
                let same = methods.get(name);
                if (!same)
                    methods.set(name, same = new Set());
                same.add(value);
            }
        }
    }
    return methods;
}
function platformSamples() {
    const factories = [
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
            const channel = new MessageChannel();
            channel.port1.close();
            channel.port2.close();
            return channel.port1;
        },
        () => globalThis.Buffer?.alloc(0),
    ];
    const samples = [];
    for (const factory of factories) {
        try {
            const sample = factory();
            if (sample != null)
                samples.push(sample);
        }
        catch { }
    }
    return samples;
}
function dynamicMember(node, key) {
    if (key.length == 0 || !(0, rpc_limits_1.isSafeKey)(key))
        return undefined;
    if (!Reflect.has(node, key))
        return undefined;
    const builtin = key in Object.prototype || (typeof node == 'function' && key in Function.prototype);
    if (builtin && !Object.prototype.hasOwnProperty.call(node, key))
        return undefined;
    const value = node[key];
    if (BUILTIN_METHODS.get(key)?.has(value) && !Object.prototype.hasOwnProperty.call(node, key))
        return undefined;
    return value;
}
