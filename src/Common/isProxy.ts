// Check if we are in Node.js environment
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

// Try to safely get native method for Node.js (so Webpack doesn't complain in browser)
let nodeIsProxy: ((value: any) => boolean) | undefined;
if (isNode) {
    try {
        // Use eval('require') or __non_webpack_require__ so frontend bundlers don't try to parse this
        const util = eval("require('util')");
        nodeIsProxy = util.types.isProxy;
    } catch (e) {}
}

const m = new WeakSet<object>();
function set() {
    // In Node.js we don't need this hack, there is a native method
    if (nodeIsProxy) return;

    const proxy = Proxy;
    Proxy = new Proxy(proxy, {
        construct(target: ProxyConstructor, argArray: any[], newTarget: Function): ProxyConstructor {
            // @ts-ignore
            const p = new proxy(...argArray);
            m.add(p);
            return p;
        }
    });
}

let init = false;
/** @deprecated use {@link installProxyTracking} */
export function isProxyInit() {
    if (init || nodeIsProxy) return;
    init = true;
    set();
}

// idiomatic alias: one-time setup of the browser fallback (must run at startup,
// before any Proxy is constructed). NOT lazy — see isProxy()'s throw.
export const installProxyTracking = isProxyInit

export function isProxy(a: any) {
    // If we are in Node.js, use built-in magic
    if (nodeIsProxy) return nodeIsProxy(a);

    // Otherwise fallback to your browser variant
    if (!init) throw new Error("isProxyInit not called in start project");
    return m.has(a);
}