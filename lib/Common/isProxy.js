"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installProxyTracking = void 0;
exports.isProxyInit = isProxyInit;
exports.isProxy = isProxy;
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
let nodeIsProxy;
if (isNode) {
    try {
        const util = eval("require('util')");
        nodeIsProxy = util.types.isProxy;
    }
    catch (e) { }
}
const m = new WeakSet();
function set() {
    if (nodeIsProxy)
        return;
    const proxy = Proxy;
    Proxy = new Proxy(proxy, {
        construct(target, argArray, newTarget) {
            const p = new proxy(...argArray);
            m.add(p);
            return p;
        }
    });
}
let init = false;
function isProxyInit() {
    if (init || nodeIsProxy)
        return;
    init = true;
    set();
}
exports.installProxyTracking = isProxyInit;
function isProxy(a) {
    if (nodeIsProxy)
        return nodeIsProxy(a);
    if (!init)
        throw new Error("isProxyInit not called in start project");
    return m.has(a);
}
