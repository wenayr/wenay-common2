// Проверяем, находимся ли мы в среде Node.js
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

// Пытаемся безопасно достать нативный метод для Node.js (чтобы Webpack не ругался в браузере)
let nodeIsProxy: ((value: any) => boolean) | undefined;
if (isNode) {
    try {
        // Используем eval('require') или __non_webpack_require__, чтобы бандлеры фронтенда не пытались это спарсить
        const util = eval("require('util')");
        nodeIsProxy = util.types.isProxy;
    } catch (e) {}
}

const m = new WeakSet<object>();
function set() {
    // В Node.js нам этот хак не нужен, там есть нативный метод
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
export function isProxyInit() {
    if (init || nodeIsProxy) return;
    init = true;
    set();
}

export function isProxy(a: any) {
    // Если мы в Node.js, используем встроенную магию
    if (nodeIsProxy) return nodeIsProxy(a);

    // Иначе фоллбэк на твой браузерный вариант
    if (!init) throw new Error("isProxyInit not called in start project");
    return m.has(a);
}