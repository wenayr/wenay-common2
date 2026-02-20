import { sleepAsync } from "./common";


type tSocket = {emit: (marker: string, object: any) => any, on: (marker: string, callback: (a: any) => any) => any}
export type tRequestScreenerT<T> = {
    key: string[],
    callbacksId?: string[],
    request: any[]
}
// export type tRequestScreener = {
//     key: tKeyScreener,
//     request: any
// }
type tt = {[k: string]: any}
/**
 *  для серверной части, во входящих параметров надо отправить ссылки не WebSocket и object который будем наблюдать
 *  можно подключить последовательно к разным классам по факту если по Map объекта не находится данный ключ то он и не включиться
 *  Есть риск одноименных методов в разных объектах
 *  пока не думал как решить =)
 * */
export function funcPromiseServer<T extends tt>(data: screenerSoc<tSocketData<tRequestScreenerT<T>>>, obj: T) {
    const buf = data;
    data.api({
        onMessage: async(datum) => {
            const {key, request} = datum.data!

            let buf2 = obj
            let nameF = ""
            try {
                for (let k of key) {
                    nameF = k
                    if (typeof buf2[nameF] == "function") break
                    buf2 = buf2[nameF]
                }
            }
            catch (e) {
                data.sendMessage({mapId: datum.mapId, error: {error: e, key: key, arguments: request}})
                console.error({error: e, key: key, arguments: request})
                return
            }
            // if (nameF == "call") {
            //     console.log(key, nameF)
            // }
            const buf = buf2 // key.reduce((o,k)=>o?.[k],obj) as any// obj[key]
            // const buf = obj[key]
            // @ts-ignore
            // if (!buf[nameF]) return;//throw "такого метода нет"
            if (typeof buf[nameF] == "function") {
                const {callbacksId} = datum
                if (callbacksId && Array.isArray(callbacksId)) {
                    const arr = callbacksId.map((e) => {
                        return (d: any) => {
                            try {
                                data.sendMessage({mapId: e, data: d ?? undefined})
                            } catch (e) {
                                console.log("errrrr  !!!!!!", e);
                            }
                        }
                    })
                    let r = 0
                    request.forEach((e, i) => {
                        if (e == "___FUNC") request[i] = arr[r++]
                    })
                }
                const trt = async() => buf[nameF](...request)
                await trt()
                    .then(a => {
                        if (datum.wait !== false) data.sendMessage({mapId: datum.mapId, data: a ?? undefined})
                    })
                    .catch((e) => {
                        console.log(nameF, request, key)
                        data.sendMessage({mapId: datum.mapId, error: {error: e, key: key, arguments: request}})
                        console.error({error: e, key: key, arguments: request})
                        // myCatch?.({data: e, key: key, arguments: request})
                    })
                // если ожидание отключено, то ждать не надо, не путать с функцией callback
            } else {
                data.sendMessage({
                    mapId: datum.mapId,
                    error: JSON.stringify({data: "это не функция", key: key, arguments: request})
                })
                console.error({data: "это не функция", key: key, arguments: request})
            }
        }
    })
}

export function funcPromiseServer2<T extends object>(sendMessage: screenerSoc222<tSocketData<tRequestScreenerT<T>>>, obj: T) {
    return async(datum: any) => {
        const {key, request} = datum.data
        // @ts-ignore
        const buf = obj[key]
        if (!buf) return //throw "такого метода нет"
        if (typeof buf == "function") {
            const a = await (async() => buf(...request))()
            sendMessage({mapId: datum.mapId, data: a ?? undefined})
        } else throw "это не функция"
    }
}

// export function funcPromiseServer3(data: {send: (data: object) => void, onMess: (func: (data: object) => void)}){}
/**
 *  для серверной части, во входящих параметров надо отправить ссылки на Post/Get и object который будем наблюдать
 *  можно подключить последовательно к разным классам по факту если по Map объекта не находится данный ключ то он и не включиться
 *  Есть риск одноименных методов в разных объектах
 *  пока не думал как решить =)
 * */
// export function funcPromiseServerPost<T extends object>(data: screenerPost<tRequestScreenerT<T>>, obj: T) {
//     // data: screenerPost<tSocketData <tRequestScreenerT<T>>>, obj: T
//     data.api({
//         onMessage: async(datum) => {
//             console.log(datum);
//             if (!datum) return;
//             const {key, request} = datum//.data
//             if (!key) return;
//             const buf = obj[key]
//             if (!buf) return //throw "такого метода нет"
//             if (typeof buf == "function") {
//                 const a = await (async() => buf(...request))()
//                 return {data: a ?? undefined} //{mapId: datum.mapId, data: a??undefined}
//             } else throw "это не функция"
//         }
//     })
// }

type tSocketData<T> = ({data: T, error?: undefined} | {error: any, data?: undefined}) & {
    mapId: number,
    wait?: boolean,
    callbacksId?: number[]
}
type screenerSoc<T> = {
    sendMessage: (data: T) => void,
    api: (data: {onMessage: (data: T) => void | Promise<void>}) => void
}
type screenerSoc222<T> = (data: T) => void
type screenerPost<T> = {
    api: (data: {onMessage: (data: T) => any | Promise<any>}) => void
}

/**
 * для обертки над WebSocket чтобы получать callback по id
 * */
export function funcForWebSocket<T>(data: screenerSoc<tSocketData<tRequestScreenerT<T>>> & {limit?: number}): screenerSoc2<T> {
    const limit = data.limit
    // const sendMessage = (datum: tSocketData <tRequestScreenerT<T>>) => data.sendMessage(JSON.stringify(datum))
    const sendMessage = data.sendMessage // (datum: tSocketData <tRequestScreenerT<T>>) => data.sendMessage(datum)
    const free = (() => {
        const freeNums: number[] = []
        let [total, _poz] = [0, 0]
        return {
            log() {
                console.log({freeNums, total, _poz});
            },
            next() {
                return _poz > 0 ? freeNums[--_poz] : ++total
            },
            numsSet(num: number) {
                freeNums[_poz++] = num
            }
        }
    })()
    const map = new Map<number, {resolve: tFunc, reject: tFunc}>()//new Map<number, (data: tRequestScreenerT<T>|undefined)=> void >()
    const callbackMany = new Map<number, tFunc>()// new Map<number, (data: tRequestScreenerT<T>|undefined)=> void >()
    // const long = async (send: tSocketData<tRequestScreenerT<T>>, time: Date) => {
    //     // подозрительно долгий ответ на запрос
    //     await sleepAsync(5000);
    //     if (map.has(send.mapId)) {
    //         console.warn("подозрительно долгий ответ на запрос ", send.data)
    //         if (Date.now() - time.valueOf()> 1000 * 60 * 5) {
    //             console.error("прошло 5 минут, наверное пора упасть", send.data);
    //             map.get(send.mapId)?.(undefined)
    //             map.delete(send.mapId);
    //             return;
    //         }
    //         long(send, time)
    //     } else return;
    // }
    data.api({
        onMessage: (data) => {
            const {mapId} = data
            if (map.has(mapId)) {
                const buf = map.get(mapId)
                map.delete(mapId)
                free.numsSet(mapId)
                if (data.error) buf?.reject(data.error)
                else buf?.resolve(data.data)
            } else if (callbackMany.has(mapId)) {
                const buf = callbackMany.get(mapId)
                // @ts-ignore
                // надо придумать команду стоп
                if (data.data == "___STOP") {
                    callbackMany.delete(mapId);
                    free.numsSet(mapId);
                }
                buf?.(data.data)
            } else {
                // пришел ответ которого не ждали
                console.error("пришел ответ которого не ждали ", data)
            }
        }
    })
    let status = false
    const api: screenerSocApi<T> = {
        log(_status: boolean) {status = _status},
        promiseTotal: () => map.size,
        callbackTotal: () => callbackMany.size,
        promiseDeleteAll: (reject = true) => {
            const arr = [...map.values()]
            const arrKey = [...map.keys()] as unknown as string[]
            map.clear()
            arrKey.forEach(e => free.numsSet(+e))
            arr.forEach((e) => reject ? e.reject("promiseDeleteAll") : e.resolve(undefined))
        },
        callbackDeleteAll: () => {
            const arr = [...callbackMany.keys()] as unknown as string[]
            callbackMany.clear()
            arr.forEach(e => free.numsSet(+e))
        },
        callbackDelete: (func: tFunc) => {
            // ))
            callbackMany.forEach((e, key) => {
                if (e == func) {
                    callbackMany.delete(key);
                    free.numsSet(+key)
                }
            })
        },
    }
    return {
        api,
        send: (data, wait?: boolean, callbacksId?: tFunc[]) => new Promise((resolve, reject) => {
            const send: tSocketData<tRequestScreenerT<T>> = {
                mapId: free.next(),
                data,
                wait: wait,
                callbacksId: <number[]>[]
            }
            for (const el of callbacksId ?? []) {
                const id = free.next()
                send.callbacksId?.push(id)
                if (status) {
                    console.log("ключ стрмиа ", id, " ", send);
                }
                callbackMany.set(id, el);
            }
            if (wait !== false) map.set(send.mapId, {resolve, reject});
            if (status) {
                free.log()
                console.log("ключ сокета ", send.mapId, " ", send);
            }
            if (limit && callbackMany.size >= limit) console.log("callbackMany.size = ", callbackMany.size)
            if (limit && map.size >= limit) console.log("map.size = ", map.size)
            sendMessage(send);
        })
    }
}

/**
 * Отправка сообщений для клиента, через авто создание апи, по методу пост запроса, с настраиваемым header
 * */


// export class CSendForPost {
//     header: HeadersInit | undefined = {
//         'content-type': 'application/json'
//     }
//     readonly funcForPost = <T>(address: string): screenerSoc2<T> =>  ({
//             send: async (data, wait?: boolean) =>  (
//                     await (await fetch(address, {
//                         method: "POST",
//                         headers: this.header,
//                         // data: JSON.stringify(data),
//                         body: JSON.stringify(data)
//                     })).json()
//                 )
//         })
// }
//
// export function funcForPost<T>(address: string): screenerSoc2<T> {
//     return (new CSendForPost()).funcForPost(address)
// }
// export function FFuncMyF<T extends object>(object: T) {
//     return {
//         send: async(data: tRequestScreenerT<T>) => {
//             const buf = object[data.key]
//             if (!buf) throw "такого метода нет"
//             if (typeof buf == "function") return buf(...data.request)
//             else throw "это не функция"
//         }
//     }
// }

type tFunc = (a: any) => any
export type screenerSoc2<T> = {
    send: (data: tRequestScreenerT<T>, wait?: boolean, callbacksId?: tFunc[]) => Promise<any>,
    api: screenerSocApi<T>,
}
export type screenerSocApi<T> = {
    log: (status: boolean) => void,
    promiseTotal: () => number,
    callbackTotal: () => number,
    promiseDeleteAll: (reject: boolean) => void,
    callbackDeleteAll: () => void,
    callbackDelete: (func: tFunc) => void,
}
export type tMethodToPromise2<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? X extends Promise<any> ? T[P] : (...args: Z) => Promise<X> : T[P] extends object ? tMethodToPromise2<T[P]> : never }
export type tMethodToPromise4<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? X extends Promise<any> ? T[P] : (...args: Z) => Promise<X> : T[P] extends object ? tMethodToPromise4<T[P]> : T[P]}
type tt5<T extends any> = T extends Promise<infer R> ? R : T
export type tMethodToPromise5<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => Promise<tt5<X>> : T[P] extends object ? tMethodToPromise5<T[P]> : never }
export type tMethodToPromise6<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => Promise<tt5<X>> : T[P] extends object ? tMethodToPromise6<T[P]> : T[P]}

// export type tMethodToPromise2<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => (X extends Promise<any> ? X : Promise<X>) : T[P] extends object ? tMethodToPromise2<T[P]> : never }

// export type tMethodToPromise4<T extends object> = {[P in keyof T] : T[P] extends ((...args: any)=> any X <T[P]> extends }// T[P] extends ((...args: infer Z)=> infer X)? (...args: Z)=>(X extends Promise<any>? X : Promise<X>) : Promise<T[P]>}
/**
 * обертка для класса - переводит класс в Promise<method> класс, также перехватывает все функции и желает свою обработку типа WebSocket или другое
 * */


// export function funcScreenerClient4<T extends object>(data: screenerSoc2<T>, wait?: boolean) {
//     return new Proxy({} as unknown as tMethodToPromise2<T>, {
//         get(target: tMethodToPromise2<T>, p: string | symbol, receiver: any): any {
//             const key = String(p) as keyof T
//             return async(...argArray: any[]) => {
//                 const callback: {func: tFunc, poz: number}[] = []
//                 const callback2: tFunc[] = []
//                 argArray.forEach((el, i) => {
//                     if (typeof el == "function") {
//                         callback.push({func: el, poz: i})
//                         callback2.push(el)
//                         argArray[i] = "___FUNC"
//                     }
//                 })
//                 return data.send({key, request: argArray}, wait, callback2)
//             }
//             // .catch((e)=>{
//             //     console.error("упали при отправке сообщения");
//             //     throw "упали при отправке сообщения"
//             // })
//         }
//     })
// }

export function funcScreenerClient2<T extends object>(data: screenerSoc2<T>, wait?: boolean) {
    const tr = (address: string[]) => new Proxy((()=>{}) as any, {
        get(target: any, p: string | symbol, receiver: any): any {
            address.push(p as string)
            return tr(address)
        },
        apply(target: any, thisArg: any, argArray: any[]): any {
            const callback: {func: tFunc, poz: number}[] = []
            const callback2: tFunc[] = []
            argArray.forEach((el, i) => {
                if (typeof el == "function") {
                    callback.push({func: el, poz: i})
                    callback2.push(el)
                    argArray[i] = "___FUNC"
                }
            })
            return data.send({key: address, request: argArray}, wait, callback2)
        }
    })
    const tr2 = () => new Proxy({} as any, {
        get(target: any, p: string | symbol, receiver: any): any {
            return tr([String(p)])
        },
    })
    return tr2() as unknown as tMethodToPromise5<T>
}


function funcScreenerClient3<T extends object>(data: screenerSoc2<T>, obj: ()=>any, wait?: boolean) {
    const tr = (address: (string)[]) => new Proxy((()=>{}) as any, {
        has(target: any, p: string | symbol): boolean {
            let o = obj()
            for (let a of address) {
                o = o?.[a]
                if (!o) break
                if (o == "null") return false
            }
            o = o?.[p]
            if (o == "null") return false
            return true
        },
        get(target: any, p: string | symbol, receiver: any): any {
            // address.push(p as string)
            let o = obj()
            for (let a of address) {
                o = o?.[a]
                if (!o) break
                if (o == "null") return undefined
            }
            o = o?.[p]
            if (o == "null") return undefined
            return tr([...address, String(p)])
        },
        apply(target: any, thisArg: any, argArray: any[]): any {
            let o = obj()
            for (let a of address) {
                o = o?.[a]
                if (!o) break
                if (o == "null") return undefined
            }
            //
            if (address.at(-1) == "call") {
                address.length = address.length - 1
                argArray.splice(0,1)
            }
            const callback: {func: tFunc, poz: number}[] = []
            const callback2: tFunc[] = []

            argArray.forEach((el, i) => {
                if (typeof el == "function") {
                    callback.push({func: el, poz: i})
                    callback2.push(el)
                    argArray[i] = "___FUNC"
                }
            })

            return data.send({key: address, request: argArray}, wait, callback2)
        }
    })
    const tr2 = () => new Proxy({} as any, {
        has(target: any, p: string | symbol): boolean {
            let o = obj()
            o = o?.[p]
            if (o == "null") return false
            return true
        },
        get(target: any, p: string | symbol, receiver: any): any {
            let o = obj()
            if (o) {
                if (o[p] == "null") return undefined
            }
            return tr([String(p)])
        },
    })
    return tr2() as unknown as tMethodToPromise5<T>
}

// метод void отменяет callback, т.е. фактически мгновенно исполняет Promise resolve
type tAndB<T> = {data: T, void: () => void}
export type screenerSoc3<T> = {send: (data: tRequestScreenerT<T>) => tAndB<Promise<any>>}
export type tMethodToPromise3<T extends object> = { [P in keyof T]: T[P] extends ((...args: infer Z) => infer X) ? (...args: Z) => (X extends Promise<any> ? tAndB<X> : tAndB<Promise<X>>) : tAndB<Promise<T[P]>> }

/**
 *
 * обертка для класса - переводит класс в Promise<method> класс
 * завернутый в определенный класс, чтобы можно было отделить методы с возвращением void и не создавать на них callback,
 * также перехватывает все функции и желает свою обработку типа WebSocket или другое
 * */
// export function funcScreenerClient3<T extends object>(data: screenerSoc3<T>) {
//     return new Proxy({} as unknown as tMethodToPromise3<T>, {
//         get(target: tMethodToPromise3<T>, p: string | symbol, receiver: any): any {
//             const key = String(p) as keyof T
//             return (...argArray: any) => data.send({key, request: argArray})
//         }
//     })
// }

/*
 *      const data = base + info.name + '&interval=' + infoTF.name + '&startTime=' + String(new Date('2000').valueOf())  + '&limit='+1
 await waitLimit()
 const parseData = (await (await fetch(data)).json());
 * */
type typeVoid<T> = Pick<
    T,
    {
        [K in keyof T]: T[K] extends (any: any) => any ? ReturnType<T[K]> extends void ? never : K : never;
    }[keyof T]
>;
type typeNoVoid<T> = Pick<
    T,
    {
        [K in keyof T]: T[K] extends (any: any) => any ? ReturnType<T[K]> extends void ? K : never : never;
    }[keyof T]
>;
export type typeVoid2<T> = {
    [P in Exclude<keyof T, { [P in keyof T]: T[P] extends (any: any) => any ? ReturnType<T[P]> extends void ? P : never : never; }[keyof T]>]: T[P];
};
export type typeNoVoid2<T> = {
    [P in Exclude<keyof T, { [P in keyof T]: T[P] extends (any: any) => any ? ReturnType<T[P]> extends void ? never : P : never; }[keyof T]>]: T[P];
};
export type UnAwaited<T extends Promise<any>> = T extends Promise<infer R> ? R : never
export type UnAwaitedArr<T extends Promise<any>[]> = T extends Promise<infer R>[] ? R[] : never
export type ReturnTypePromise<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R extends Promise<any> ? UnAwaited<R> : R : any;
export type UnObject<T extends object> = T extends {[k: string]: infer R} ? R : never;
export type UnArray<T extends any[]> = T extends (infer R)[] ? R : never
export type tElArr<T extends any[]> = UnArray<T>

// OmitTypes
export function CreatAPIFacadeClientOld<T extends object>({socketKey, socket, limit}: {socket: tSocket, socketKey: string, limit?: number}) {

    let strictlyObj = {} as any
    let promiseStrictly = Promise.resolve()
    let funcPromise: (value: unknown) => void
    const tr = funcForWebSocket<any>({
        sendMessage: (data) => socket.emit(socketKey, data),
        api: (data) => {
            socket.on(socketKey, (d: any) => {
                if (typeof d == "object" && d?.STRICTLY) {
                    Object.keys(strictlyObj).forEach(k=>{delete strictlyObj[k]})
                    Object.assign(strictlyObj, d.STRICTLY)
                    funcPromise?.(undefined)
                }
                else data.onMessage(d)
            })
        },
        limit
    })
    const func = funcScreenerClient2<typeVoid2<T>>(tr) //satisfies tMethodToPromise2<typeVoid2<T>>

    const strictly = funcScreenerClient3(tr,()=>strictlyObj) as tMethodToPromise6<T>

    //Не ждет ответа
    const space = funcScreenerClient2<typeNoVoid2<T>>(tr, false)
    // const roles =
    return {
        api: tr.api,
        // типизацией убраны некоторые методы
        func,
        // типизацией убраны некоторые методы
        space,
        // все методы
        all: func as tMethodToPromise5<T>,
        // возможность добавлять не обязательные методы
        strictly,
        infoStrictly(){return strictlyObj},
        async strictlyInit(obj?: object) {
            if (obj) strictlyObj = obj
            else {
                socket.emit(socketKey, "___STRICTLY")
                return new Promise(resolve => {
                    funcPromise = resolve
                })
            }
        }
    }
}

export function CreatAPIFacadeServerOld<T extends object>({object, socket, socketKey, debug = false}: {
    socket: tSocket,
    object: T,
    socketKey: string,
    debug?: boolean
}) {
    function ff(obj: any): any {
        return Object.fromEntries(Object.entries(obj).map(([k,v])=> {
                return [
                    k, typeof v == "object" && v != null ? ff(v) : typeof v == "function" ? "func" : !v ? "null" : "unknow"
                ]
            }
        ))
    }
    const t = ff(object)
    // серверная часть (она же клиенская, для выполнения статичных подписок)
    funcPromiseServer({
            sendMessage: (data) => socket.emit(socketKey, data),
            api: (api) => {
                socket.on(socketKey, (d: any) => {
                    if (debug) console.log(typeof d == "object" ? JSON.stringify(d) : d)
                    if (d == "___STRICTLY") {
                        socket.emit(socketKey, {STRICTLY: t})
                    }
                    else api.onMessage(d)
                })
            }
        }
        , object)
}

type tMethodToPromise<T extends object> =
    { [P in keyof T]: PromiseAllZL<T[P]> }
type PromiseAllZL<T extends any> =
    T extends ((...args: infer Z) => infer X) ? (...args: Z) => (X extends Promise<any> ? X : Promise<X>) : Promise<T>

export function fMiniTest() {
}



export class CTestWeb {
    func(a: number, b: number) {
        return a + b
    }

    async func2(a: number, b: number) {
        await sleepAsync(1000);
        return a * b
    }

    fun3(a: number, b: number) {
        return a ** b
    }

    test() {
        return "status ok"
    }
}
