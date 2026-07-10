"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketServerHook = SocketServerHook;
exports.WebSocketServerHook = WebSocketServerHook;
const Listen_1 = require("./Listen");
const listen_socket_1 = require("../rcp/listen-socket");
function SocketServerHook(opt) {
    const obj = {};
    const transformer = opt?.transformer;
    const r = {
        obj,
        get(tag) {
            return obj[tag] ??= (0, Listen_1.listen)();
        },
        provider: (tag, data) => {
            const t = r.get(tag)[0];
            if (transformer)
                transformer(t, tag, data);
            else
                t(data);
        }
    };
    return r;
}
function WebSocketServerHook(s, paramsSoc, disconnect) {
    const wrappers = {};
    const get = new Proxy(s.obj, {
        get(target, p, receiver) {
            return wrappers[p] ??= (0, listen_socket_1.listenSocketSmart)(s.get(p)[1], paramsSoc);
        }
    });
    return {
        disconnect() { disconnect?.(); },
        get,
        keys: () => Object.keys(s.obj),
        ping: () => "pong",
        provider: s.provider
    };
}
