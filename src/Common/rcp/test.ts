import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io } from 'socket.io-client';
import { createRpcServer } from './rpc-server';
import { createRpcClientHub, rpc } from './rpc-clientHub';
import {createRpcServerAuto} from "./rpc-server-auto";
import {listen} from "../events/Listen";
import {sleepAsync} from "../core/common";

// --- Фасад (API сервера) ---
const facade = ()=>{
    return {
        math: {
            add: async (a: number, b: number) => a + b,
            multiply: async (a: number, b: number) => a * b,
            callback: async (a: { callback: (b: { a: Date , b: Date }, f: number) => void })=> {
                for (let i = 0; i < 100; i++) {
                    await sleepAsync(50)
                    a.callback({a: new Date(), b: new Date(Date.now() - 100000)}, 43);
                }
            },
        },
        greet: async (name: string) => {
            console.log('get ' + name)
            return false
        },
        date: async (date: Date) => {
            await sleepAsync(1000)
            return ({msg: `Hello!`, map: new Map<string, number>([['ds',43]]), youDate: date, now: new Date()})
        },
    };
}

type FacadeAPI = ReturnType<typeof facade>;

// --- Запуск сервера ---
async function startServer(port: number) {
    const app = express();
    const httpServer = createServer(app);
    const ioServer = new SocketIOServer(httpServer);

    ioServer.on('connection', (socket) => {
        console.log('[server] клиент подключился');
        const [disconnect, disconnectListen] = listen()
        socket.on('disconnect', disconnect);
        createRpcServerAuto({
            socket: {
                emit: (key, data) => socket.emit(key, data),
                on: (key, cb) => socket.on(key, cb),
            },
            socketKey: 'rpc',
            object: facade(),
            disconnectListen,
            debug: true,
        });
    });

    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    console.log(`[server] слушает :${port}`);
    return httpServer;
}

// --- Запуск клиента через hub ---
async function startClient(port: number) {
    const hub = createRpcClientHub(
        () => io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true }),
        (r) => ({ api: r<FacadeAPI>('rpc') }) as const,
    );
    const clients = await hub.setToken(null);
    console.log('[client] подключились, ждём схему...');
    clients.api.api.log(true)
    await clients.api.readyStrict();
    console.log('[client] схема получена, schema:', clients.api.schema());
    return { hub, clients };
}
//
// --- Основной тест ---
async function runTest() {
    const PORT = 4020;
    const httpServer = await startServer(PORT);
    const { hub, clients } = await startClient(PORT);

    const api = clients.api.func;

    // const addResult = await api.math.add(5, 7);
    // console.log('[test] math.add(5, 7) =', addResult); // 12
    //
    // const mulResult = await api.math.multiply(3, 4);
    // console.log('[test] math.multiply(3, 4) =', mulResult); // 12

    console.log('test World')
    const greetResult = await api.greet('World');
    console.log('[test] greet("World") =', greetResult); // Hello, World!

    // const dateResult = await api.date(new Date());
    // console.log('[test] date(new Date()) =', dateResult);
    // // @ts-ignore
    // console.log('[test] date(new Date()) =', dateResult.youDate.toISOString(), new Date(dateResult.youDate).getDate(), dateResult.youDate.getDate());
    //
    // await api.math.callback({callback: (a)=>{
    //         console.log(a)
    //     }});

    hub.socket?.disconnect?.();
    httpServer.close(() => console.log('[server] остановлен'));
}

runTest().catch(console.error);