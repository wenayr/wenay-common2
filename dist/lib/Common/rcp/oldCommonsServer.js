"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CTestWeb = void 0;
exports.funcPromiseServer = funcPromiseServer;
exports.funcPromiseServer2 = funcPromiseServer2;
exports.funcForWebSocket = funcForWebSocket;
exports.funcScreenerClient2 = funcScreenerClient2;
exports.CreatAPIFacadeClientOld = CreatAPIFacadeClientOld;
exports.CreatAPIFacadeServerOld = CreatAPIFacadeServerOld;
exports.fMiniTest = fMiniTest;
const common_1 = require("../core/common");
const oldCommonsServerMini_1 = require("./oldCommonsServerMini");
function funcPromiseServer(data, obj) {
    return (0, oldCommonsServerMini_1.promiseServer)(data, obj);
}
function funcPromiseServerOld(data, obj) {
    const buf = data;
    data.api({
        onMessage: async (datum) => {
            const { key, request } = datum.data;
            let buf2 = obj;
            let nameF = "";
            try {
                for (let k of key) {
                    nameF = k;
                    if (typeof buf2[nameF] == "function")
                        break;
                    buf2 = buf2[nameF];
                }
            }
            catch (e) {
                data.sendMessage({ mapId: datum.mapId, error: { error: e, key: key, arguments: request } });
                console.error({ error: e, key: key, arguments: request });
                return;
            }
            const buf = buf2;
            if (typeof buf[nameF] == "function") {
                const { callbacksId } = datum;
                if (callbacksId && Array.isArray(callbacksId)) {
                    const arr = callbacksId.map((e) => {
                        return (d) => {
                            try {
                                data.sendMessage({ mapId: e, data: d ?? undefined });
                            }
                            catch (e) {
                                console.log("errrrr  !!!!!!", e);
                            }
                        };
                    });
                    let r = 0;
                    request.forEach((e, i) => {
                        if (e == "___FUNC")
                            request[i] = arr[r++];
                    });
                }
                const trt = async () => buf[nameF](...request);
                await trt()
                    .then(a => {
                    if (datum.wait !== false)
                        data.sendMessage({ mapId: datum.mapId, data: a ?? undefined });
                })
                    .catch((e) => {
                    console.log(nameF, request, key);
                    data.sendMessage({ mapId: datum.mapId, error: { error: e, key: key, arguments: request } });
                    console.error({ error: e, key: key, arguments: request });
                });
            }
            else {
                data.sendMessage({
                    mapId: datum.mapId,
                    error: JSON.stringify({ data: "это не функция", key: key, arguments: request })
                });
                console.error({ data: "это не функция", key: key, arguments: request });
            }
        }
    });
}
function funcPromiseServer2(sendMessage, obj) {
    return async (datum) => {
        const { key, request } = datum.data;
        const buf = obj[key];
        if (!buf)
            return;
        if (typeof buf == "function") {
            const a = await (async () => buf(...request))();
            sendMessage({ mapId: datum.mapId, data: a ?? undefined });
        }
        else
            throw "это не функция";
    };
}
function funcForWebSocket(data) {
    return (0, oldCommonsServerMini_1.wsWrapper)(data);
}
function funcForWebSocketOld(data) {
    const limit = data.limit;
    const sendMessage = data.sendMessage;
    const free = (() => {
        const freeNums = [];
        let [total, _poz] = [0, 0];
        return {
            log() {
                console.log({ freeNums, total, _poz });
            },
            next() {
                return _poz > 0 ? freeNums[--_poz] : ++total;
            },
            numsSet(num) {
                freeNums[_poz++] = num;
            }
        };
    })();
    const map = new Map();
    const callbackMany = new Map();
    data.api({
        onMessage: (data) => {
            const { mapId } = data;
            if (map.has(mapId)) {
                const buf = map.get(mapId);
                map.delete(mapId);
                free.numsSet(mapId);
                if (data.error)
                    buf?.reject(data.error);
                else
                    buf?.resolve(data.data);
            }
            else if (callbackMany.has(mapId)) {
                const buf = callbackMany.get(mapId);
                if (data.data == "___STOP") {
                    callbackMany.delete(mapId);
                    free.numsSet(mapId);
                    return;
                }
                buf?.(data.data);
            }
            else {
                console.error("пришел ответ которого не ждали ", data);
            }
        }
    });
    let status = false;
    const api = {
        log(_status) { status = _status; },
        promiseTotal: () => map.size,
        callbackTotal: () => callbackMany.size,
        promiseDeleteAll: (reject = true) => {
            const arr = [...map.values()];
            const arrKey = [...map.keys()];
            map.clear();
            arrKey.forEach(e => free.numsSet(+e));
            arr.forEach((e) => reject ? e.reject("promiseDeleteAll") : e.resolve(undefined));
        },
        callbackDeleteAll: () => {
            const arr = [...callbackMany.keys()];
            callbackMany.clear();
            arr.forEach(e => free.numsSet(+e));
        },
        callbackDelete: (func) => {
            callbackMany.forEach((e, key) => {
                if (e == func) {
                    callbackMany.delete(key);
                    free.numsSet(+key);
                }
            });
        },
    };
    return {
        api,
        send: (data, wait, callbacksId) => new Promise((resolve, reject) => {
            const send = {
                mapId: free.next(),
                data,
                wait: wait,
                callbacksId: []
            };
            for (const el of callbacksId ?? []) {
                const id = free.next();
                send.callbacksId?.push(id);
                if (status) {
                    console.log("ключ стрмиа ", id, " ", send);
                }
                callbackMany.set(id, el);
            }
            if (wait !== false)
                map.set(send.mapId, { resolve, reject });
            if (status) {
                free.log();
                console.log("ключ сокета ", send.mapId, " ", send);
            }
            if (limit && callbackMany.size >= limit)
                console.log("callbackMany.size = ", callbackMany.size);
            if (limit && map.size >= limit)
                console.log("map.size = ", map.size);
            sendMessage(send);
        })
    };
}
function funcScreenerClient2(data, wait) {
    return (0, oldCommonsServerMini_1.createClientProxy)(data, wait);
}
function funcScreenerClient2Old(data, wait) {
    const tr = (address) => new Proxy((() => { }), {
        get(target, p, receiver) {
            address.push(p);
            return tr(address);
        },
        apply(target, thisArg, argArray) {
            const callback = [];
            const callback2 = [];
            argArray.forEach((el, i) => {
                if (typeof el == "function") {
                    callback.push({ func: el, poz: i });
                    callback2.push(el);
                    argArray[i] = "___FUNC";
                }
            });
            return data.send({ key: address, request: argArray }, wait, callback2);
        }
    });
    const tr2 = () => new Proxy({}, {
        get(target, p, receiver) {
            return tr([String(p)]);
        },
    });
    return tr2();
}
function funcScreenerClient3(data, obj, wait) {
    const tr = (address) => new Proxy((() => { }), {
        has(target, p) {
            let o = obj();
            for (let a of address) {
                o = o?.[a];
                if (!o)
                    break;
                if (o == "null")
                    return false;
            }
            o = o?.[p];
            if (o == "null")
                return false;
            return true;
        },
        get(target, p, receiver) {
            let o = obj();
            for (let a of address) {
                o = o?.[a];
                if (!o)
                    break;
                if (o == "null")
                    return undefined;
            }
            o = o?.[p];
            if (o == "null")
                return undefined;
            return tr([...address, String(p)]);
        },
        apply(target, thisArg, argArray) {
            let o = obj();
            for (let a of address) {
                o = o?.[a];
                if (!o)
                    break;
                if (o == "null")
                    return undefined;
            }
            if (address.at(-1) == "call") {
                address.length = address.length - 1;
                argArray.splice(0, 1);
            }
            const callback = [];
            const callback2 = [];
            argArray.forEach((el, i) => {
                if (typeof el == "function") {
                    callback.push({ func: el, poz: i });
                    callback2.push(el);
                    argArray[i] = "___FUNC";
                }
            });
            return data.send({ key: address, request: argArray }, wait, callback2);
        }
    });
    const tr2 = () => new Proxy({}, {
        has(target, p) {
            let o = obj();
            o = o?.[p];
            if (o == "null")
                return false;
            return true;
        },
        get(target, p, receiver) {
            let o = obj();
            if (o) {
                if (o[p] == "null")
                    return undefined;
            }
            return tr([String(p)]);
        },
    });
    return tr2();
}
function CreatAPIFacadeClientOld({ socketKey, socket, limit }) {
    let strictlyObj = {};
    let promiseStrictly = Promise.resolve();
    let funcPromise;
    const tr = funcForWebSocket({
        sendMessage: (data) => socket.emit(socketKey, data),
        api: (data) => {
            socket.on(socketKey, (d) => {
                if (typeof d == "object" && d?.STRICTLY) {
                    Object.keys(strictlyObj).forEach(k => { delete strictlyObj[k]; });
                    Object.assign(strictlyObj, d.STRICTLY);
                    funcPromise?.(undefined);
                }
                else
                    data.onMessage(d);
            });
        },
        limit
    });
    const func = funcScreenerClient2(tr);
    const strictly = funcScreenerClient3(tr, () => strictlyObj);
    const space = funcScreenerClient2(tr, false);
    return {
        api: tr.api,
        func,
        space,
        all: func,
        strictly,
        infoStrictly() { return strictlyObj; },
        async strictlyInit(obj) {
            if (obj)
                strictlyObj = obj;
            else {
                socket.emit(socketKey, "___STRICTLY");
                return new Promise(resolve => {
                    funcPromise = resolve;
                });
            }
        }
    };
}
function CreatAPIFacadeServerOld(params) {
    return (0, oldCommonsServerMini_1.createAPIFacadeServer)(params);
}
function CreatAPIFacadeServerOldImpl({ object, socket, socketKey, debug = false }) {
    function ff(obj) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => {
            return [
                k, typeof v == "object" && v != null ? ff(v) : typeof v == "function" ? "func" : !v ? "null" : "unknow"
            ];
        }));
    }
    const t = ff(object);
    funcPromiseServer({
        sendMessage: (data) => socket.emit(socketKey, data),
        api: (api) => {
            socket.on(socketKey, (d) => {
                if (debug)
                    console.log(typeof d == "object" ? JSON.stringify(d) : d);
                if (d == "___STRICTLY") {
                    socket.emit(socketKey, { STRICTLY: t });
                }
                else
                    api.onMessage(d);
            });
        }
    }, object);
}
function fMiniTest() {
}
class CTestWeb {
    func(a, b) {
        return a + b;
    }
    async func2(a, b) {
        await (0, common_1.sleepAsync)(1000);
        return a * b;
    }
    fun3(a, b) {
        return a ** b;
    }
    test() {
        return "status ok";
    }
}
exports.CTestWeb = CTestWeb;
