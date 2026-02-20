
const m = new WeakSet<object>()
set()
function set(){
    const proxy = Proxy
    Proxy = new Proxy(proxy, {
        construct(target: ProxyConstructor, argArray: any[], newTarget: Function): ProxyConstructor {
            // @ts-ignore
            const p = new proxy(...argArray)
            m.add(p)
            return p
        }
    })
}
export function isProxy(a: any){return m.has(a)}
