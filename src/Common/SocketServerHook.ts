import {UseListen} from "./Listen";
import {funcListenBySocket2 as soc} from "./ListenBySocket";

type transformer = (func: (data: any) => any, tag: string, data: any) => any
export function SocketServerHook(opt?:{transformer?: transformer}) {
    const obj: {[k: string]: ReturnType<typeof UseListen>} = {}
    const transformer = opt?.transformer
    const r = {
        obj,
        get(tag: string) {
            return obj[tag] ??= UseListen()
        },
        provider: (tag: string, data: any) => {
            const t = r.get(tag)[0]
            if (transformer) transformer(t, tag, data)
            else t(data)
        }
    }
    return r
}
export function WebSocketServerHook(s: ReturnType<typeof SocketServerHook>, paramsSoc?: Parameters<typeof soc>[1], disconnect?:()=>any) {
    const get = new Proxy(s.obj, {
        get(target: any, p: string, receiver: any): any {
            return soc(s.get(p)[1], paramsSoc)
        }
    }) as {[k: string]: ReturnType<typeof soc>}
    return {
        disconnect(){disconnect?.()},
        get,
        keys: ()=> Object.keys(s.obj),
        ping: () => "pong",
        provider: s.provider
    }
}
export type WebSocketServerHook = ReturnType<typeof WebSocketServerHook>